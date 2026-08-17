package database

// User rows + manuscript_access grants (split out of queries.go, 2026-08 —
// pure code motion).

import (
	"context"
	"errors"
	"fmt"

	"github.com/slackwing/manuscript-studio/internal/models"

	"github.com/jackc/pgx/v5"
)

func (db *DB) GetUserByUsername(ctx context.Context, username string) (*models.User, error) {
	query := `
		SELECT username, password_hash, role, created_at
		FROM "user"
		WHERE username = $1
	`

	var u models.User
	err := db.Pool.QueryRow(ctx, query, username).Scan(
		&u.Username,
		&u.PasswordHash,
		&u.Role,
		&u.CreatedAt,
	)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get user: %w", err)
	}

	return &u, nil
}

func (db *DB) GetManuscriptAccessForUser(ctx context.Context, username string) ([]models.ManuscriptAccess, error) {
	query := `
		SELECT username, manuscript_name, created_at
		FROM manuscript_access
		WHERE username = $1
		ORDER BY manuscript_name
	`

	rows, err := db.Pool.Query(ctx, query, username)
	if err != nil {
		return nil, fmt.Errorf("failed to query manuscript access: %w", err)
	}
	defer rows.Close()

	var access []models.ManuscriptAccess
	for rows.Next() {
		var ma models.ManuscriptAccess
		if err := rows.Scan(&ma.Username, &ma.ManuscriptName, &ma.CreatedAt); err != nil {
			return nil, fmt.Errorf("failed to scan manuscript access: %w", err)
		}
		access = append(access, ma)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating manuscript access: %w", err)
	}

	return access, nil
}

func (db *DB) HasManuscriptAccess(ctx context.Context, username, manuscriptName string) (bool, error) {
	query := `
		SELECT EXISTS(
			SELECT 1 FROM manuscript_access
			WHERE username = $1 AND manuscript_name = $2
		)
	`

	var exists bool
	err := db.Pool.QueryRow(ctx, query, username, manuscriptName).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("failed to check manuscript access: %w", err)
	}

	return exists, nil
}

// GetLastManuscriptName returns the most recently opened manuscript for the
// user, or "" if they've never opened one.
func (db *DB) GetLastManuscriptName(ctx context.Context, username string) (string, error) {
	var last *string
	err := db.Pool.QueryRow(ctx,
		`SELECT last_manuscript_name FROM "user" WHERE username = $1`, username,
	).Scan(&last)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("get last manuscript: %w", err)
	}
	if last == nil {
		return "", nil
	}
	return *last, nil
}

// GetMigrationIDForSentence returns the migration_id a sentence belongs to,
// or 0 if the sentence doesn't exist. Used by the access-check helper to
// resolve sentence_id → migration_id → manuscript_id.
func (db *DB) GetMigrationIDForSentence(ctx context.Context, sentenceID string) (int, error) {
	var mid int
	err := db.Pool.QueryRow(ctx,
		`SELECT migration_id FROM sentence WHERE sentence_id = $1`, sentenceID,
	).Scan(&mid)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("get migration id for sentence: %w", err)
	}
	return mid, nil
}

// SetLastManuscriptName stores the user's most recently opened manuscript.
// Caller is expected to have already verified access.
func (db *DB) SetLastManuscriptName(ctx context.Context, username, manuscriptName string) error {
	_, err := db.Pool.Exec(ctx,
		`UPDATE "user" SET last_manuscript_name = $1 WHERE username = $2`,
		manuscriptName, username,
	)
	if err != nil {
		return fmt.Errorf("set last manuscript: %w", err)
	}
	return nil
}
