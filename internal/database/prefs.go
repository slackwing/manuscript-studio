package database

// Generic per-user preferences (user_pref, changeset 046). First tenant:
// marker_display ('on' — absent means off, the new-user default).

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// GetUserPref returns the value, or "" when unset.
func (db *DB) GetUserPref(ctx context.Context, username, key string) (string, error) {
	var v string
	err := db.Pool.QueryRow(ctx,
		`SELECT value FROM user_pref WHERE user_id = $1 AND key = $2`, username, key).Scan(&v)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("get user pref %s: %w", key, err)
	}
	return v, nil
}

// SetUserPref upserts; an empty value DELETES the row (unset = default).
func (db *DB) SetUserPref(ctx context.Context, username, key, value string) error {
	if value == "" {
		if _, err := db.Pool.Exec(ctx,
			`DELETE FROM user_pref WHERE user_id = $1 AND key = $2`, username, key); err != nil {
			return fmt.Errorf("unset user pref %s: %w", key, err)
		}
		return nil
	}
	if _, err := db.Pool.Exec(ctx, `
		INSERT INTO user_pref (user_id, key, value) VALUES ($1, $2, $3)
		ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value
	`, username, key, value); err != nil {
		return fmt.Errorf("set user pref %s: %w", key, err)
	}
	return nil
}
