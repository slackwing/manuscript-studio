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

// Private type so context keys from other packages can't collide with ours.
type contextKey string

const sessionContextKey contextKey = "session"

// SessionTTL is how long a fresh or just-touched session stays valid.
const SessionTTL = 24 * time.Hour

// When a session has less than this left, Get() bumps expires_at by SessionTTL —
// sliding window without a DB write on every single request.
const sessionRefreshThreshold = 6 * time.Hour

type Session struct {
	Username  string
	CSRFToken string
	CreatedAt time.Time
	ExpiresAt time.Time
}

// SessionStore persists sessions in the `session` table so they survive process
// restarts and can be shared across replicas.
type SessionStore struct {
	pool *pgxpool.Pool
}

// NewSessionStore returns a store backed by pool and starts a background
// goroutine that periodically purges expired rows.
func NewSessionStore(pool *pgxpool.Pool) *SessionStore {
	s := &SessionStore{pool: pool}
	go s.cleanupExpired()
	return s
}

// Create inserts a session row and returns the cookie token. Sessions no
// longer carry a manuscript — that's runtime state driven by the URL.
func (s *SessionStore) Create(username string) (string, error) {
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
		INSERT INTO session (id, username, csrf_token,
		                     created_at, expires_at, last_activity_at)
		VALUES ($1, $2, $3, $4, $5, $4)
	`, token, username, csrfToken, now, expires)
	if err != nil {
		return "", fmt.Errorf("failed to insert session: %w", err)
	}
	return token, nil
}

// Get loads a session by token. Returns (nil, false) if unknown or expired.
// Bumps expires_at only when inside sessionRefreshThreshold (sliding window
// without a write per request).
func (s *SessionStore) Get(token string) (*Session, bool) {
	if token == "" {
		return nil, false
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	var (
		username, csrfToken  string
		createdAt, expiresAt time.Time
	)
	err := s.pool.QueryRow(ctx, `
		SELECT username, csrf_token, created_at, expires_at
		FROM session
		WHERE id = $1
	`, token).Scan(&username, &csrfToken, &createdAt, &expiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, false
	}
	if err != nil {
		log.Printf("session lookup error: %v", err)
		return nil, false
	}

	now := time.Now().UTC()
	if !now.Before(expiresAt) {
		_, _ = s.pool.Exec(ctx, `DELETE FROM session WHERE id = $1`, token)
		return nil, false
	}

	newExpires := expiresAt
	if expiresAt.Sub(now) < sessionRefreshThreshold {
		newExpires = now.Add(SessionTTL)
	}
	_, _ = s.pool.Exec(ctx, `
		UPDATE session SET last_activity_at = $1, expires_at = $2 WHERE id = $3
	`, now, newExpires, token)

	return &Session{
		Username:  username,
		CSRFToken: csrfToken,
		CreatedAt: createdAt,
		ExpiresAt: newExpires,
	}, true
}

func (s *SessionStore) Delete(token string) {
	if token == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _ = s.pool.Exec(ctx, `DELETE FROM session WHERE id = $1`, token)
}

// cleanupExpired periodically trims expired rows to keep the table small.
// Correctness lives in the per-request check in Get(); this is just hygiene.
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

func generateSessionToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.URLEncoding.EncodeToString(b), nil
}

func HashPassword(password string) (string, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return "", err
	}
	return string(hash), nil
}

func VerifyPassword(password, hash string) bool {
	err := bcrypt.CompareHashAndPassword([]byte(hash), []byte(password))
	return err == nil
}

// ValidatePassword: intentionally minimal (>= 4 chars). Used at every entry
// point that sets a password.
func ValidatePassword(password string) error {
	if len(password) < 4 {
		return fmt.Errorf("password must be at least 4 characters")
	}
	return nil
}

// Middleware returns a handler that requires a valid session cookie.
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

func GetSession(r *http.Request) (*Session, error) {
	session, ok := r.Context().Value(sessionContextKey).(*Session)
	if !ok {
		return nil, fmt.Errorf("no session in context")
	}
	return session, nil
}

// CSRFMiddleware rejects state-changing requests without a matching X-CSRF-Token.
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
