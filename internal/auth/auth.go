package auth

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"net/http"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"
)

// contextKey is a private type for context keys to prevent collisions
type contextKey string

const sessionContextKey contextKey = "session"

// Session represents an active user session
type Session struct {
	Username       string
	ManuscriptName string
	CSRFToken      string
	CreatedAt      time.Time
	ExpiresAt      time.Time
}

// SessionStore manages active sessions
type SessionStore struct {
	sessions map[string]*Session
	mu       sync.RWMutex
}

// NewSessionStore creates a new session store
func NewSessionStore() *SessionStore {
	store := &SessionStore{
		sessions: make(map[string]*Session),
	}
	// Start cleanup goroutine
	go store.cleanupExpired()
	return store
}

// Create creates a new session and returns the session token
func (s *SessionStore) Create(username, manuscriptName string) (string, error) {
	token, err := generateSessionToken()
	if err != nil {
		return "", err
	}

	csrfToken, err := generateSessionToken()
	if err != nil {
		return "", err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	session := &Session{
		Username:       username,
		ManuscriptName: manuscriptName,
		CSRFToken:      csrfToken,
		CreatedAt:      time.Now(),
		ExpiresAt:      time.Now().Add(24 * time.Hour), // 24 hour sessions
	}

	s.sessions[token] = session
	return token, nil
}

// Get retrieves a session by token
// Returns a copy of the session to avoid race conditions
func (s *SessionStore) Get(token string) (*Session, bool) {
	s.mu.RLock()
	session, exists := s.sessions[token]
	s.mu.RUnlock()

	if !exists {
		return nil, false
	}

	// Check if expired (after releasing lock)
	now := time.Now()
	if now.After(session.ExpiresAt) {
		// Delete expired session with write lock
		s.mu.Lock()
		delete(s.sessions, token)
		s.mu.Unlock()
		return nil, false
	}

	// Return a copy to prevent external modifications
	sessionCopy := &Session{
		Username:       session.Username,
		ManuscriptName: session.ManuscriptName,
		CSRFToken:      session.CSRFToken,
		CreatedAt:      session.CreatedAt,
		ExpiresAt:      session.ExpiresAt,
	}

	return sessionCopy, true
}

// Delete removes a session
func (s *SessionStore) Delete(token string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.sessions, token)
}

// cleanupExpired periodically removes expired sessions
func (s *SessionStore) cleanupExpired() {
	ticker := time.NewTicker(1 * time.Hour)
	defer ticker.Stop()

	for range ticker.C {
		s.mu.Lock()
		now := time.Now()
		for token, session := range s.sessions {
			if now.After(session.ExpiresAt) {
				delete(s.sessions, token)
			}
		}
		s.mu.Unlock()
	}
}

// generateSessionToken creates a cryptographically secure random token
func generateSessionToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.URLEncoding.EncodeToString(b), nil
}

// HashPassword hashes a password using bcrypt
func HashPassword(password string) (string, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return "", err
	}
	return string(hash), nil
}

// VerifyPassword verifies a password against a hash
func VerifyPassword(password, hash string) bool {
	err := bcrypt.CompareHashAndPassword([]byte(hash), []byte(password))
	return err == nil
}

// Middleware returns a middleware that checks for valid session
func Middleware(store *SessionStore) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Get session token from cookie
			cookie, err := r.Cookie("session_token")
			if err != nil {
				http.Error(w, "Unauthorized", http.StatusUnauthorized)
				return
			}

			// Validate session
			session, valid := store.Get(cookie.Value)
			if !valid {
				http.Error(w, "Unauthorized", http.StatusUnauthorized)
				return
			}

			// Add session to context using typed key
			ctx := context.WithValue(r.Context(), sessionContextKey, session)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// GetSession retrieves the session from the request context
func GetSession(r *http.Request) (*Session, error) {
	session, ok := r.Context().Value(sessionContextKey).(*Session)
	if !ok {
		return nil, fmt.Errorf("no session in context")
	}
	return session, nil
}

// CSRFMiddleware validates CSRF tokens on state-changing requests
func CSRFMiddleware(store *SessionStore) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Only check CSRF on state-changing methods
			if r.Method == "POST" || r.Method == "PUT" || r.Method == "DELETE" {
				// Get session from cookie
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

				// Get CSRF token from header
				csrfToken := r.Header.Get("X-CSRF-Token")
				if csrfToken == "" {
					http.Error(w, "CSRF token missing", http.StatusForbidden)
					return
				}

				// Validate CSRF token
				if csrfToken != session.CSRFToken {
					http.Error(w, "CSRF token invalid", http.StatusForbidden)
					return
				}
			}

			next.ServeHTTP(w, r)
		})
	}
}

// ValidateCSRFToken validates a CSRF token for a given session
func ValidateCSRFToken(r *http.Request, store *SessionStore, providedToken string) bool {
	// Get session from cookie
	cookie, err := r.Cookie("session_token")
	if err != nil {
		return false
	}

	session, valid := store.Get(cookie.Value)
	if !valid {
		return false
	}

	// Check if the provided token matches the session's CSRF token
	return providedToken == session.CSRFToken
}
