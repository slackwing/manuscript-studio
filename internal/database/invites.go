package database

// Invite-only sign-up (039): single-use codes with an expiry. Minted by
// the operator (admin API / debug script); consumed atomically at signup.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"time"
)

var (
	// ErrInviteInvalid: unknown, expired, or already used. One error on
	// purpose — signup mustn't leak which.
	ErrInviteInvalid = errors.New("invalid invite code")
	// ErrUsernameTaken speaks for itself.
	ErrUsernameTaken = errors.New("username is taken")
)

// CreateUserWithInvite is the whole signup write: user row + invite burn in
// ONE transaction, so a bad invite never half-creates a user and a taken
// username never burns an invite.
func (db *DB) CreateUserWithInvite(ctx context.Context, username, passwordHash, email, code string) error {
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("signup: begin: %w", err)
	}
	defer tx.Rollback(ctx)

	tag, err := tx.Exec(ctx, `
		INSERT INTO "user" (username, password_hash, role, email)
		VALUES ($1, $2, 'author', $3)
		ON CONFLICT (username) DO NOTHING`, username, passwordHash, email)
	if err != nil {
		return fmt.Errorf("signup: insert user: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrUsernameTaken
	}
	tag, err = tx.Exec(ctx, `
		UPDATE invite_code SET used_by = $2, used_at = NOW()
		WHERE code = $1 AND used_by IS NULL AND expires_at > NOW()`, code, username)
	if err != nil {
		return fmt.Errorf("signup: consume invite: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrInviteInvalid
	}
	return tx.Commit(ctx)
}

// MintInvite creates a code valid for ttl (caller defaults to a year).
func (db *DB) MintInvite(ctx context.Context, ttl time.Duration, note string) (string, time.Time, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", time.Time{}, fmt.Errorf("mint invite: %w", err)
	}
	code := hex.EncodeToString(buf)
	expires := time.Now().Add(ttl)
	if _, err := db.Pool.Exec(ctx, `
		INSERT INTO invite_code (code, expires_at, note) VALUES ($1, $2, $3)`,
		code, expires, note); err != nil {
		return "", time.Time{}, fmt.Errorf("mint invite: %w", err)
	}
	return code, expires, nil
}

// ConsumeInvite atomically claims a live code for username. The WHERE
// clause is the whole validity check, so two racing signups can't share
// one code.
func (db *DB) ConsumeInvite(ctx context.Context, code, username string) error {
	tag, err := db.Pool.Exec(ctx, `
		UPDATE invite_code
		SET used_by = $2, used_at = NOW()
		WHERE code = $1 AND used_by IS NULL AND expires_at > NOW()`,
		code, username)
	if err != nil {
		return fmt.Errorf("consume invite: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrInviteInvalid
	}
	return nil
}

// SearchUsers: prefix match on username, for the access-management
// autocomplete. Case-insensitive, capped.
func (db *DB) SearchUsers(ctx context.Context, prefix string, limit int) ([]string, error) {
	rows, err := db.Pool.Query(ctx, `
		SELECT username FROM "user"
		WHERE username ILIKE $1 || '%'
		ORDER BY username LIMIT $2`, prefix, limit)
	if err != nil {
		return nil, fmt.Errorf("search users: %w", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var u string
		if err := rows.Scan(&u); err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}
