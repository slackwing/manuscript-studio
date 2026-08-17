package database

// Manuscript rows (split out of queries.go, 2026-08 — pure code motion).

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/slackwing/manuscript-studio/internal/models"

	"github.com/jackc/pgx/v5"
)

func (db *DB) CreateManuscript(ctx context.Context, repoPath, filePath string) (*models.Manuscript, error) {
	query := `
		INSERT INTO manuscript (repo_path, file_path)
		VALUES ($1, $2)
		ON CONFLICT (repo_path, file_path) DO UPDATE
			SET repo_path = EXCLUDED.repo_path
		RETURNING manuscript_id, repo_path, file_path, COALESCE(display_name, ''), created_at, birthday, word_goal
	`

	var m models.Manuscript
	err := db.Pool.QueryRow(ctx, query, repoPath, filePath).Scan(
		&m.ManuscriptID,
		&m.RepoPath,
		&m.FilePath,
		&m.DisplayName,
		&m.CreatedAt,
		&m.Birthday,
		&m.WordGoal,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create manuscript: %w", err)
	}

	return &m, nil
}

// GetManuscriptByID returns (nil, nil) when no row exists.
func (db *DB) GetManuscriptByID(ctx context.Context, manuscriptID int) (*models.Manuscript, error) {
	var m models.Manuscript
	err := db.Pool.QueryRow(ctx,
		`SELECT manuscript_id, repo_path, file_path, COALESCE(display_name, ''), created_at, birthday, word_goal FROM manuscript WHERE manuscript_id = $1`,
		manuscriptID,
	).Scan(&m.ManuscriptID, &m.RepoPath, &m.FilePath, &m.DisplayName, &m.CreatedAt, &m.Birthday, &m.WordGoal)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get manuscript by id: %w", err)
	}
	return &m, nil
}

func (db *DB) GetManuscript(ctx context.Context, repoPath, filePath string) (*models.Manuscript, error) {
	query := `
		SELECT manuscript_id, repo_path, file_path, COALESCE(display_name, ''), created_at, birthday, word_goal
		FROM manuscript
		WHERE repo_path = $1 AND file_path = $2
	`

	var m models.Manuscript
	err := db.Pool.QueryRow(ctx, query, repoPath, filePath).Scan(
		&m.ManuscriptID,
		&m.RepoPath,
		&m.FilePath,
		&m.DisplayName,
		&m.CreatedAt,
		&m.Birthday,
		&m.WordGoal,
	)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get manuscript: %w", err)
	}

	return &m, nil
}

// UpdateManuscriptMeta partially updates the stats-pane metadata: a nil
// field is left unchanged. Returns the updated row, or (nil, nil) when the
// manuscript doesn't exist.
func (db *DB) UpdateManuscriptMeta(ctx context.Context, manuscriptID int, birthday *time.Time, wordGoal *int) (*models.Manuscript, error) {
	var m models.Manuscript
	err := db.Pool.QueryRow(ctx, `
		UPDATE manuscript
		SET birthday = COALESCE($2, birthday),
		    word_goal = COALESCE($3, word_goal)
		WHERE manuscript_id = $1
		RETURNING manuscript_id, repo_path, file_path, COALESCE(display_name, ''), created_at, birthday, word_goal
	`, manuscriptID, birthday, wordGoal).Scan(
		&m.ManuscriptID, &m.RepoPath, &m.FilePath, &m.DisplayName, &m.CreatedAt, &m.Birthday, &m.WordGoal)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("update manuscript meta: %w", err)
	}
	return &m, nil
}
