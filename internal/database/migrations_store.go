package database

// Migration lifecycle rows: pending → running → done/error (split out of
// queries.go, 2026-08 — pure code motion).

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/slackwing/manuscript-studio/internal/models"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// ErrMigrationInProgress: a duplicate (manuscript_id, commit_hash, segmenter). Callers map to HTTP 409.
var ErrMigrationInProgress = errors.New("migration already exists for this commit/segmenter")

// Result columns (sentence_count etc.) are only meaningful when status='done';
// callers that read them must filter.
const migrationSelectColumns = `migration_id, manuscript_id, commit_hash, segmenter,
		       parent_migration_id, branch_name, processed_at, status,
		       started_at, finished_at, error,
		       sentence_count, additions_count, deletions_count, changes_count,
		       sentence_id_array`

func scanMigration(row pgx.Row, m *models.Migration) error {
	var (
		branchName          *string
		sentenceCount       *int
		additionsCount      *int
		deletionsCount      *int
		changesCount        *int
		sentenceIDArrayJSON []byte
	)
	err := row.Scan(
		&m.MigrationID,
		&m.ManuscriptID,
		&m.CommitHash,
		&m.Segmenter,
		&m.ParentMigrationID,
		&branchName,
		&m.ProcessedAt,
		&m.Status,
		&m.StartedAt,
		&m.FinishedAt,
		&m.Error,
		&sentenceCount,
		&additionsCount,
		&deletionsCount,
		&changesCount,
		&sentenceIDArrayJSON,
	)
	if err != nil {
		return err
	}
	if branchName != nil {
		m.BranchName = *branchName
	}
	if sentenceCount != nil {
		m.SentenceCount = *sentenceCount
	}
	if additionsCount != nil {
		m.AdditionsCount = *additionsCount
	}
	if deletionsCount != nil {
		m.DeletionsCount = *deletionsCount
	}
	if changesCount != nil {
		m.ChangesCount = *changesCount
	}
	if len(sentenceIDArrayJSON) > 0 {
		if err := json.Unmarshal(sentenceIDArrayJSON, &m.SentenceIDArray); err != nil {
			return fmt.Errorf("failed to parse sentence_id_array: %w", err)
		}
	}
	return nil
}

// GetLatestMigration returns (nil, nil) if no done migration exists.
func (db *DB) GetLatestMigration(ctx context.Context, manuscriptID int) (*models.Migration, error) {
	query := `
		SELECT ` + migrationSelectColumns + `
		FROM migration
		WHERE manuscript_id = $1 AND status = 'done'
		ORDER BY processed_at DESC
		LIMIT 1
	`
	var m models.Migration
	err := scanMigration(db.Pool.QueryRow(ctx, query, manuscriptID), &m)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get latest migration: %w", err)
	}
	return &m, nil
}

// GetMigrations returns done rows newest-first. See GetActiveMigrations for pending/running.
func (db *DB) GetMigrations(ctx context.Context, manuscriptID int) ([]models.Migration, error) {
	query := `
		SELECT ` + migrationSelectColumns + `
		FROM migration
		WHERE manuscript_id = $1 AND status = 'done'
		ORDER BY processed_at DESC
	`
	rows, err := db.Pool.Query(ctx, query, manuscriptID)
	if err != nil {
		return nil, fmt.Errorf("failed to get migrations: %w", err)
	}
	defer rows.Close()

	var migrations []models.Migration
	for rows.Next() {
		var m models.Migration
		if err := scanMigration(rows, &m); err != nil {
			return nil, fmt.Errorf("failed to scan migration: %w", err)
		}
		migrations = append(migrations, m)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating migrations: %w", err)
	}
	return migrations, nil
}

// GetActiveMigrations returns pending/running rows; used by /api/admin/status.
func (db *DB) GetActiveMigrations(ctx context.Context) ([]models.Migration, error) {
	query := `
		SELECT ` + migrationSelectColumns + `
		FROM migration
		WHERE status IN ('pending', 'running')
		ORDER BY started_at DESC NULLS LAST, migration_id DESC
	`
	rows, err := db.Pool.Query(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("failed to get active migrations: %w", err)
	}
	defer rows.Close()

	var migrations []models.Migration
	for rows.Next() {
		var m models.Migration
		if err := scanMigration(rows, &m); err != nil {
			return nil, fmt.Errorf("failed to scan migration: %w", err)
		}
		migrations = append(migrations, m)
	}
	return migrations, rows.Err()
}

// CreatePendingMigration returns ErrMigrationInProgress on a duplicate row.
func (db *DB) CreatePendingMigration(ctx context.Context, manuscriptID int, commitHash, segmenter string) (int, error) {
	query := `
		INSERT INTO migration (manuscript_id, commit_hash, segmenter, status, started_at)
		VALUES ($1, $2, $3, 'pending', NOW())
		RETURNING migration_id
	`
	var id int
	err := db.Pool.QueryRow(ctx, query, manuscriptID, commitHash, segmenter).Scan(&id)
	if err != nil {
		// Postgres unique-violation → typed error → HTTP 409.
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return 0, ErrMigrationInProgress
		}
		return 0, fmt.Errorf("failed to insert pending migration: %w", err)
	}
	return id, nil
}

func (db *DB) MarkMigrationRunning(ctx context.Context, migrationID int) error {
	_, err := db.Pool.Exec(ctx, `
		UPDATE migration SET status = 'running'
		WHERE migration_id = $1 AND status IN ('pending', 'running')
	`, migrationID)
	if err != nil {
		return fmt.Errorf("failed to mark migration running: %w", err)
	}
	return nil
}

// MarkMigrationDone overwrites commit_hash because the pending row may have
// been inserted with a symbolic ref ("HEAD" or branch); by now we know the SHA.
func (db *DB) MarkMigrationDone(ctx context.Context, m *models.Migration) error {
	sentenceIDArrayJSON, err := json.Marshal(m.SentenceIDArray)
	if err != nil {
		return fmt.Errorf("failed to marshal sentence_id_array: %w", err)
	}
	_, err = db.Pool.Exec(ctx, `
		UPDATE migration SET
			status = 'done',
			finished_at = NOW(),
			processed_at = NOW(),
			commit_hash = $2,
			parent_migration_id = $3,
			branch_name = $4,
			sentence_count = $5,
			additions_count = $6,
			deletions_count = $7,
			changes_count = $8,
			sentence_id_array = $9,
			error = NULL
		WHERE migration_id = $1
	`, m.MigrationID, m.CommitHash, m.ParentMigrationID, m.BranchName, m.SentenceCount,
		m.AdditionsCount, m.DeletionsCount, m.ChangesCount, sentenceIDArrayJSON)
	if err != nil {
		return fmt.Errorf("failed to mark migration done: %w", err)
	}
	return nil
}

// MarkMigrationError truncates errMsg so a giant stack trace can't blow up the row.
func (db *DB) MarkMigrationError(ctx context.Context, migrationID int, errMsg string) error {
	const maxErrLen = 4000
	if len(errMsg) > maxErrLen {
		errMsg = errMsg[:maxErrLen] + "...[truncated]"
	}
	_, err := db.Pool.Exec(ctx, `
		UPDATE migration SET
			status = 'error',
			finished_at = NOW(),
			error = $2
		WHERE migration_id = $1
	`, migrationID, errMsg)
	if err != nil {
		return fmt.Errorf("failed to mark migration error: %w", err)
	}
	return nil
}

// RecoverInterruptedMigrations runs once at startup: leftover pending/running
// rows from a previous process were interrupted, so flip them to 'error'.
func (db *DB) RecoverInterruptedMigrations(ctx context.Context) (int, error) {
	tag, err := db.Pool.Exec(ctx, `
		UPDATE migration
		SET status = 'error',
		    finished_at = NOW(),
		    error = COALESCE(error, '') || 'interrupted by server restart'
		WHERE status IN ('pending', 'running')
	`)
	if err != nil {
		return 0, fmt.Errorf("failed to recover interrupted migrations: %w", err)
	}
	return int(tag.RowsAffected()), nil
}

// GetMigrationByID returns (nil, nil) if the row is missing or pre-'done'.
func (db *DB) GetMigrationByID(ctx context.Context, migrationID int) (*models.Migration, error) {
	query := `
		SELECT ` + migrationSelectColumns + `
		FROM migration
		WHERE migration_id = $1 AND status = 'done'
	`
	var m models.Migration
	err := scanMigration(db.Pool.QueryRow(ctx, query, migrationID), &m)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get migration by ID: %w", err)
	}
	return &m, nil
}
