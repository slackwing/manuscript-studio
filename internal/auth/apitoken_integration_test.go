package auth

// APITokenStore against the dev Postgres (localhost:5433, override with
// MANUSCRIPT_STUDIO_TEST_DB_URL). Skips — never fails — when it's
// unreachable or not migrated to 053 yet; each test makes its own user.

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func apiTokenTestStore(t *testing.T) (*APITokenStore, *pgxpool.Pool, string) {
	t.Helper()
	url := os.Getenv("MANUSCRIPT_STUDIO_TEST_DB_URL")
	if url == "" {
		url = "postgres://manuscript_dev:manuscript_dev@localhost:5433/manuscript_studio_dev"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, url)
	if err == nil {
		err = pool.Ping(ctx)
	}
	if err != nil {
		t.Skipf("test DB unreachable: %v", err)
	}
	var migrated bool
	if err := pool.QueryRow(ctx, `SELECT to_regclass('api_token') IS NOT NULL`).Scan(&migrated); err != nil || !migrated {
		pool.Close()
		t.Skip("api_token table missing — run make db-migrate")
	}
	user := fmt.Sprintf("apitok-%d", time.Now().UnixNano())
	if _, err := pool.Exec(ctx, `INSERT INTO "user" (username, password_hash, role) VALUES ($1, 'x', 'author')`, user); err != nil {
		pool.Close()
		t.Fatalf("create user: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM "user" WHERE username = $1`, user) // cascades to api_token
		pool.Close()
	})
	return NewAPITokenStore(pool), pool, user
}

func TestAPITokenStoreLifecycle(t *testing.T) {
	store, pool, user := apiTokenTestStore(t)
	ctx := context.Background()

	if _, _, err := store.Create(ctx, user+"-nobody", "x", []string{ScopePointsRead}, nil); !errors.Is(err, ErrUnknownUser) {
		t.Fatalf("minting for a missing user: err %v, want ErrUnknownUser", err)
	}

	tok, secret, err := store.Create(ctx, user, "hobby-server sxiva", []string{ScopePointsRead}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if tok.Username != user || tok.Name != "hobby-server sxiva" || tok.Prefix != secret[:12] || !tok.HasScope(ScopePointsRead) {
		t.Fatalf("created %+v", tok)
	}
	var stored string
	if err := pool.QueryRow(ctx, `SELECT token_hash FROM api_token WHERE token_id = $1`, tok.ID).Scan(&stored); err != nil || stored != HashAPIToken(secret) {
		t.Fatalf("stored %q, want the SHA-256 of the secret (never the secret)", stored)
	}

	got, err := store.Lookup(ctx, secret)
	if err != nil || got == nil || got.ID != tok.ID {
		t.Fatalf("lookup: %+v, %v", got, err)
	}
	if got, _ := store.Lookup(ctx, secret+"x"); got != nil {
		t.Fatal("a wrong secret must not match")
	}

	if err := store.Touch(ctx, tok.ID); err != nil {
		t.Fatal(err)
	}
	var first time.Time
	_ = pool.QueryRow(ctx, `SELECT last_used_at FROM api_token WHERE token_id = $1`, tok.ID).Scan(&first)
	if err := store.Touch(ctx, tok.ID); err != nil {
		t.Fatal(err)
	}
	var second time.Time
	_ = pool.QueryRow(ctx, `SELECT last_used_at FROM api_token WHERE token_id = $1`, tok.ID).Scan(&second)
	if first.IsZero() || !second.Equal(first) {
		t.Fatalf("last_used_at %v then %v: want set once, then left alone within a minute", first, second)
	}

	list, err := store.List(ctx, user)
	if err != nil || len(list) != 1 || list[0].ID != tok.ID {
		t.Fatalf("list: %+v, %v", list, err)
	}

	if ok, err := store.Revoke(ctx, tok.ID); err != nil || !ok {
		t.Fatalf("revoke: %v, %v", ok, err)
	}
	if got, _ := store.Lookup(ctx, secret); got != nil {
		t.Fatal("a revoked token must not authenticate")
	}
	if ok, _ := store.Revoke(ctx, tok.ID); ok {
		t.Fatal("revoking twice reports false")
	}
	list, _ = store.List(ctx, user)
	if len(list) != 1 || list[0].RevokedAt == nil {
		t.Fatal("revoked tokens stay listed, marked revoked")
	}
}

func TestAPITokenExpiry(t *testing.T) {
	store, pool, user := apiTokenTestStore(t)
	ctx := context.Background()
	future := time.Now().Add(time.Hour)
	tok, secret, err := store.Create(ctx, user, "expiring", []string{ScopePointsRead}, &future)
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := store.Lookup(ctx, secret); got == nil {
		t.Fatal("a token before its expiry works")
	}
	if _, err := pool.Exec(ctx, `UPDATE api_token SET expires_at = NOW() - interval '1 second' WHERE token_id = $1`, tok.ID); err != nil {
		t.Fatal(err)
	}
	if got, _ := store.Lookup(ctx, secret); got != nil {
		t.Fatal("an expired token must not authenticate")
	}
}
