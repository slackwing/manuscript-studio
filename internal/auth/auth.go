package auth

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
)

// contextKey is a private type for context keys to prevent collisions
type contextKey string

const sessionContextKey contextKey = "session"

// SessionTTL is how long a fresh or just-touched session stays valid.
const SessionTTL = 24 * time.Hour

// sessionRefreshThreshold: when a session has less than this much time left,
// Get() extends expires_at by SessionTTL. Sliding window without churning the
// DB on every single request.
const sessionRefreshThreshold = 6 * time.Hour

// Session represents an active user session.
type Session struct {
	Username       string
	ManuscriptName string
	CSRFToken      string
	CreatedAt      time.Time
	ExpiresAt      time.Time
}

// SessionStore manages active sessions, persisted in the `session` DB table.
//
// Backed by Postgres so sessions survive process restarts and can be shared
// across replicas. Replaces the in-memory map this used to be — the same
// Create/Get/Delete API is preserved so call sites need no changes.
type SessionStore struct {
	pool *pgxpool.Pool
}

// NewSessionStore creates a session store backed by the provided pool.
// Starts a background goroutine that periodically purges expired rows.
func NewSessionStore(pool *pgxpool.Pool) *SessionStore {
	s := &SessionStore{pool: pool}
	go s.cleanupExpired()
	return s
}

// Create inserts a new session row and returns the cookie token.
func (s *SessionStore) Create(username, manuscriptName string) (string, error) {
	token, err := generateSessionToken()
	if err != nil {
		return "", err
	}
	csrfToken, err := generateSessionToken()
	if err != nil {
		return "", err
	}

	now := time.Now().UTC()
	expires := now.Add(SessionTTL)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	_, err = s.pool.Exec(ctx, `
		INSERT INTO session (id, username, manuscript_name, csrf_token,
		                     created_at, expires_at, last_activity_at)
		VALUES ($1, $2, $3, $4, $5, $6, $5)
	`, token, username, manuscriptName, csrfToken, now, expires)
	if err != nil {
		return "", fmt.Errorf("failed to insert session: %w", err)
	}
	return token, nil
}

// Get loads the session for a token. Returns (nil, false) if the token is
// unknown or expired. Refreshes expires_at on read if the session is in the
// last sessionRefreshThreshold of its TTL — implements a sliding window
// without writing on every request.
func (s *SessionStore) Get(token string) (*Session, bool) {
	if token == "" {
		return nil, false
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	var (
		username, manuscriptName, csrfToken string
		createdAt, expiresAt                time.Time
	)
	err := s.pool.QueryRow(ctx, `
		SELECT username, manuscript_name, csrf_token, created_at, expires_at
		FROM session
		WHERE id = $1
	`, token).Scan(&username, &manuscriptName, &csrfToken, &createdAt, &expiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, false
	}
	if err != nil {
		log.Printf("session lookup error: %v", err)
		return nil, false
	}

	now := time.Now().UTC()
	if !now.Before(expiresAt) {
		// Expired. Best-effort delete; ignore error.
		_, _ = s.pool.Exec(ctx, `DELETE FROM session WHERE id = $1`, token)
		return nil, false
	}

	// Sliding-window refresh: if we're inside the refresh threshold, push
	// expires_at out by another full TTL. Always update last_activity_at.
	newExpires := expiresAt
	if expiresAt.Sub(now) < sessionRefreshThreshold {
		newExpires = now.Add(SessionTTL)
	}
	_, _ = s.pool.Exec(ctx, `
		UPDATE session SET last_activity_at = $1, expires_at = $2 WHERE id = $3
	`, now, newExpires, token)

	return &Session{
		Username:       username,
		ManuscriptName: manuscriptName,
		CSRFToken:      csrfToken,
		CreatedAt:      createdAt,
		ExpiresAt:      newExpires,
	}, true
}

// Delete removes a session.
func (s *SessionStore) Delete(token string) {
	if token == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _ = s.pool.Exec(ctx, `DELETE FROM session WHERE id = $1`, token)
}

// cleanupExpired runs periodically to purge expired session rows. The
// per-request expiry check in Get() is the load-bearing one; this is just
// for tidiness and to keep the table small.
func (s *SessionStore) cleanupExpired() {
	ticker := time.NewTicker(15 * time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		_, err := s.pool.Exec(ctx, `DELETE FROM session WHERE expires_at < NOW()`)
		cancel()
		if err != nil {
			log.Printf("session cleanup error: %v", err)
		}
	}
}

// generateSessionToken creates a cryptographically secure random token.
func generateSessionToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.URLEncoding.EncodeToString(b), nil
}

// HashPassword hashes a password using bcrypt.
func HashPassword(password string) (string, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return "", err
	}
	return string(hash), nil
}

// VerifyPassword verifies a password against a hash.
func VerifyPassword(password, hash string) bool {
	err := bcrypt.CompareHashAndPassword([]byte(hash), []byte(password))
	return err == nil
}

// ValidatePassword enforces our password rules. Intentionally minimal:
// at least 4 characters, no other constraints. Used at every entry point
// that sets a password (registration, admin upsert, etc.).
func ValidatePassword(password string) error {
	if len(password) < 4 {
		return fmt.Errorf("password must be at least 4 characters")
	}
	return nil
}

// Middleware returns a middleware that checks for valid session.
func Middleware(store *SessionStore) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			cookie, err := r.Cookie("session_token")
			if err != nil {
				http.Error(w, "Unauthorized", http.StatusUnauthorized)
				return
			}
			session, valid := store.Get(cookie.Value)
			if !valid {
				http.Error(w, "Unauthorized", http.StatusUnauthorized)
				return
			}
			ctx := context.WithValue(r.Context(), sessionContextKey, session)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// GetSession retrieves the session from the request context.
func GetSession(r *http.Request) (*Session, error) {
	session, ok := r.Context().Value(sessionContextKey).(*Session)
	if !ok {
		return nil, fmt.Errorf("no session in context")
	}
	return session, nil
}

// CSRFMiddleware validates CSRF tokens on state-changing requests.
func CSRFMiddleware(store *SessionStore) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method == "POST" || r.Method == "PUT" || r.Method == "DELETE" {
				cookie, err := r.Cookie("session_token")
				if err != nil {
					http.Error(w, "Unauthorized", http.StatusUnauthorized)
					return
				}
				session, valid := store.Get(cookie.Value)
				if !valid {
					http.Error(w, "Unauthorized", http.StatusUnauthorized)
					return
				}
				csrfToken := r.Header.Get("X-CSRF-Token")
				if csrfToken == "" {
					http.Error(w, "CSRF token missing", http.StatusForbidden)
					return
				}
				if subtle.ConstantTimeCompare([]byte(csrfToken), []byte(session.CSRFToken)) != 1 {
					http.Error(w, "CSRF token invalid", http.StatusForbidden)
					return
				}
			}
			next.ServeHTTP(w, r)
		})
	}
}

// ValidateCSRFToken validates a CSRF token for a given session.
func ValidateCSRFToken(r *http.Request, store *SessionStore, providedToken string) bool {
	cookie, err := r.Cookie("session_token")
	if err != nil {
		return false
	}
	session, valid := store.Get(cookie.Value)
	if !valid {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(providedToken), []byte(session.CSRFToken)) == 1
}
