package auth

// Personal API tokens (README "API tokens"): a token lets another service
// act as ONE user, limited to its scopes, on the token-only /api/v1 routes.
//
//   - Format: "mst_" + 32 random bytes, base64url. High-entropy, so it's
//     stored as a plain SHA-256 (bcrypt is for guessable passwords) and
//     looked up by that hash.
//   - Shown once, at minting (POST /api/admin/api-tokens); never logged.
//   - Revoked or expired tokens stay in the table but never authenticate.

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// APITokenPrefix starts every token, so a leaked one is recognizable
// (and greppable by secret scanners).
const APITokenPrefix = "mst_"

// Scopes. A token-authenticated route names the one it needs.
const (
	ScopePointsRead = "points:read" // GET /api/v1/points-daily
)

// KnownScopes is every scope a token may be minted with.
var KnownScopes = map[string]bool{
	ScopePointsRead: true,
}

// last_used_at is refreshed at most this often per token.
const apiTokenTouchInterval = time.Minute

const apiTokenContextKey contextKey = "api_token"

// APIToken is a token's row, without its secret.
type APIToken struct {
	ID         int        `json:"id"`
	Username   string     `json:"username"`
	Name       string     `json:"name"`
	Prefix     string     `json:"prefix"`
	Scopes     []string   `json:"scopes"`
	CreatedAt  time.Time  `json:"created_at"`
	LastUsedAt *time.Time `json:"last_used_at"`
	ExpiresAt  *time.Time `json:"expires_at"`
	RevokedAt  *time.Time `json:"revoked_at"`
}

// HasScope reports whether the token was granted scope.
func (t *APIToken) HasScope(scope string) bool {
	for _, s := range t.Scopes {
		if s == scope {
			return true
		}
	}
	return false
}

// GenerateAPIToken returns a new token, its SHA-256 hex hash, and its
// display prefix ("mst_" + 8 characters).
func GenerateAPIToken() (token, hash, prefix string, err error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", "", "", err
	}
	token = APITokenPrefix + base64.RawURLEncoding.EncodeToString(b)
	return token, HashAPIToken(token), token[:len(APITokenPrefix)+8], nil
}

// HashAPIToken is the stored form of a token.
func HashAPIToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// BearerAPIToken extracts an API token from "Authorization: Bearer mst_…",
// or "" if the header doesn't carry one.
func BearerAPIToken(r *http.Request) string {
	parts := strings.Fields(r.Header.Get("Authorization"))
	if len(parts) != 2 || !strings.EqualFold(parts[0], "bearer") || !strings.HasPrefix(parts[1], APITokenPrefix) {
		return ""
	}
	return parts[1]
}

// ErrUnknownUser: minting for a username that doesn't exist.
var ErrUnknownUser = errors.New("no such user")

// APITokenStore persists tokens in the api_token table.
type APITokenStore struct {
	pool *pgxpool.Pool
}

func NewAPITokenStore(pool *pgxpool.Pool) *APITokenStore {
	return &APITokenStore{pool: pool}
}

const apiTokenColumns = `token_id, username, name, prefix, scopes, created_at, last_used_at, expires_at, revoked_at`

func scanAPIToken(row pgx.Row) (*APIToken, error) {
	var t APIToken
	if err := row.Scan(&t.ID, &t.Username, &t.Name, &t.Prefix, &t.Scopes, &t.CreatedAt,
		&t.LastUsedAt, &t.ExpiresAt, &t.RevokedAt); err != nil {
		return nil, err
	}
	return &t, nil
}

// Create mints a token for username. The returned string is the only copy
// of the token — the caller hands it over once.
func (s *APITokenStore) Create(ctx context.Context, username, name string, scopes []string, expiresAt *time.Time) (*APIToken, string, error) {
	token, hash, prefix, err := GenerateAPIToken()
	if err != nil {
		return nil, "", err
	}
	var exists bool
	if err := s.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM "user" WHERE username = $1)`, username).Scan(&exists); err != nil {
		return nil, "", err
	}
	if !exists {
		return nil, "", ErrUnknownUser
	}
	t, err := scanAPIToken(s.pool.QueryRow(ctx, `
		INSERT INTO api_token (username, name, token_hash, prefix, scopes, expires_at)
		VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING `+apiTokenColumns,
		username, name, hash, prefix, scopes, expiresAt))
	if err != nil {
		return nil, "", err
	}
	return t, token, nil
}

// Lookup returns the live token for a presented secret, or nil when it's
// unknown, revoked or expired.
func (s *APITokenStore) Lookup(ctx context.Context, token string) (*APIToken, error) {
	t, err := scanAPIToken(s.pool.QueryRow(ctx, `
		SELECT `+apiTokenColumns+` FROM api_token
		WHERE token_hash = $1 AND revoked_at IS NULL
		  AND (expires_at IS NULL OR expires_at > NOW())`, HashAPIToken(token)))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return t, err
}

// Touch records a use, at most once per apiTokenTouchInterval.
func (s *APITokenStore) Touch(ctx context.Context, id int) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE api_token SET last_used_at = NOW()
		WHERE token_id = $1
		  AND (last_used_at IS NULL OR last_used_at < $2)`,
		id, time.Now().Add(-apiTokenTouchInterval))
	return err
}

// List returns a user's tokens (all users' when username is ""), newest
// first, revoked ones included.
func (s *APITokenStore) List(ctx context.Context, username string) ([]APIToken, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT `+apiTokenColumns+` FROM api_token
		WHERE $1 = '' OR username = $1
		ORDER BY created_at DESC, token_id DESC`, username)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []APIToken{}
	for rows.Next() {
		t, err := scanAPIToken(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *t)
	}
	return out, rows.Err()
}

// Revoke stops a token working. False when there's no such live token.
func (s *APITokenStore) Revoke(ctx context.Context, id int) (bool, error) {
	tag, err := s.pool.Exec(ctx, `UPDATE api_token SET revoked_at = NOW() WHERE token_id = $1 AND revoked_at IS NULL`, id)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// APITokenLookup is what TokenMiddleware needs from the store (an
// interface, so handler tests can fake it).
type APITokenLookup interface {
	Lookup(ctx context.Context, token string) (*APIToken, error)
	Touch(ctx context.Context, id int) error
}

// TokenMiddleware admits requests bearing a live API token with scope:
// 401 without a valid token, 403 without the scope. The token's user is
// then available through Username(r).
func TokenMiddleware(store APITokenLookup, scope string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			secret := BearerAPIToken(r)
			if secret == "" {
				http.Error(w, "Unauthorized", http.StatusUnauthorized)
				return
			}
			t, err := store.Lookup(r.Context(), secret)
			if err != nil {
				http.Error(w, "Internal error", http.StatusInternalServerError)
				return
			}
			if t == nil {
				http.Error(w, "Unauthorized", http.StatusUnauthorized)
				return
			}
			if !t.HasScope(scope) {
				http.Error(w, "Token lacks scope "+scope, http.StatusForbidden)
				return
			}
			_ = store.Touch(r.Context(), t.ID) // best effort; a failed touch doesn't fail the call
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), apiTokenContextKey, t)))
		})
	}
}

// GetAPIToken returns the token that authenticated the request, if any.
func GetAPIToken(r *http.Request) (*APIToken, bool) {
	t, ok := r.Context().Value(apiTokenContextKey).(*APIToken)
	return t, ok
}

// Username is the acting user: from the session cookie, or from the API
// token on token routes. Handlers that serve both use this instead of
// GetSession.
func Username(r *http.Request) (string, error) {
	if s, err := GetSession(r); err == nil {
		return s.Username, nil
	}
	if t, ok := GetAPIToken(r); ok {
		return t.Username, nil
	}
	return "", errors.New("no session or API token in context")
}
