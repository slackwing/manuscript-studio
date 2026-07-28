package database

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"

	"github.com/slackwing/manuscript-studio/internal/fractional"
	"github.com/slackwing/manuscript-studio/internal/models"
	"github.com/slackwing/manuscript-studio/internal/sentence"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// ErrMigrationInProgress: a duplicate (manuscript_id, commit_hash, segmenter). Callers map to HTTP 409.
var ErrMigrationInProgress = errors.New("migration already exists for this commit/segmenter")

func (db *DB) CreateManuscript(ctx context.Context, repoPath, filePath string) (*models.Manuscript, error) {
	query := `
		INSERT INTO manuscript (repo_path, file_path)
		VALUES ($1, $2)
		ON CONFLICT (repo_path, file_path) DO UPDATE
			SET repo_path = EXCLUDED.repo_path
		RETURNING manuscript_id, repo_path, file_path, COALESCE(display_name, ''), created_at
	`

	var m models.Manuscript
	err := db.Pool.QueryRow(ctx, query, repoPath, filePath).Scan(
		&m.ManuscriptID,
		&m.RepoPath,
		&m.FilePath,
		&m.DisplayName,
		&m.CreatedAt,
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
		`SELECT manuscript_id, repo_path, file_path, COALESCE(display_name, ''), created_at FROM manuscript WHERE manuscript_id = $1`,
		manuscriptID,
	).Scan(&m.ManuscriptID, &m.RepoPath, &m.FilePath, &m.DisplayName, &m.CreatedAt)
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
		SELECT manuscript_id, repo_path, file_path, COALESCE(display_name, ''), created_at
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
	)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get manuscript: %w", err)
	}

	return &m, nil
}

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

// GetSentenceTextsByIDs batches text + previous_sentence_id lookups for the
// history-chain walk. Returns a map keyed by sentence_id.
func (db *DB) GetSentenceTextsByIDs(ctx context.Context, sentenceIDs []string) (map[string]struct {
	Text       string
	PreviousID *string
}, error) {
	out := make(map[string]struct {
		Text       string
		PreviousID *string
	}, len(sentenceIDs))
	if len(sentenceIDs) == 0 {
		return out, nil
	}
	rows, err := db.Pool.Query(ctx,
		`SELECT sentence_id, text, previous_sentence_id FROM sentence WHERE sentence_id = ANY($1)`,
		sentenceIDs,
	)
	if err != nil {
		return nil, fmt.Errorf("batch fetch sentences: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id, text string
		var prev *string
		if err := rows.Scan(&id, &text, &prev); err != nil {
			return nil, fmt.Errorf("scan sentence: %w", err)
		}
		out[id] = struct {
			Text       string
			PreviousID *string
		}{Text: text, PreviousID: prev}
	}
	return out, rows.Err()
}

// UpsertSuggestion stores text as-given; collapsing empty / original-equals-text
// into deletes is the caller's responsibility.
func (db *DB) UpsertSuggestion(ctx context.Context, sentenceID, userID, text string) (*models.SuggestedChange, error) {
	query := `
		INSERT INTO suggested_change (sentence_id, user_id, text, created_at, updated_at)
		VALUES ($1, $2, $3, NOW(), NOW())
		ON CONFLICT (sentence_id, user_id) DO UPDATE
			SET text = EXCLUDED.text, updated_at = NOW()
		RETURNING suggestion_id, sentence_id, user_id, text, created_at, updated_at
	`
	var s models.SuggestedChange
	err := db.Pool.QueryRow(ctx, query, sentenceID, userID, text).Scan(
		&s.SuggestionID, &s.SentenceID, &s.UserID, &s.Text, &s.CreatedAt, &s.UpdatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("upsert suggestion: %w", err)
	}
	return &s, nil
}

// DeleteSuggestion returns true if a row was deleted.
func (db *DB) DeleteSuggestion(ctx context.Context, sentenceID, userID string) (bool, error) {
	tag, err := db.Pool.Exec(ctx,
		`DELETE FROM suggested_change WHERE sentence_id = $1 AND user_id = $2`,
		sentenceID, userID,
	)
	if err != nil {
		return false, fmt.Errorf("delete suggestion: %w", err)
	}
	return tag.RowsAffected() > 0, nil
}

// GetSuggestionsForMigration: one user's suggestions for every sentence in
// the migration, single round-trip via JOIN.
func (db *DB) GetSuggestionsForMigration(ctx context.Context, migrationID int, userID string) ([]models.SuggestedChange, error) {
	rows, err := db.Pool.Query(ctx, `
		SELECT sc.suggestion_id, sc.sentence_id, sc.user_id, sc.text, sc.created_at, sc.updated_at
		FROM suggested_change sc
		JOIN sentence s ON s.sentence_id = sc.sentence_id
		WHERE s.migration_id = $1 AND sc.user_id = $2
	`, migrationID, userID)
	if err != nil {
		return nil, fmt.Errorf("get suggestions for migration: %w", err)
	}
	defer rows.Close()
	var out []models.SuggestedChange
	for rows.Next() {
		var s models.SuggestedChange
		if err := rows.Scan(&s.SuggestionID, &s.SentenceID, &s.UserID, &s.Text, &s.CreatedAt, &s.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan suggestion: %w", err)
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// PruneNoOpSuggestionsForMigration deletes suggestions on sentences in the
// given migration whose suggestion text matches the sentence text under
// NormalizeText. These are no-ops with nothing to actually suggest — typically
// left behind when a suggestion's text gets incorporated into the source by a
// later commit and carried forward across exact-match pairings.
// Scoped to current migration so old migrations remain untouched audit data.
// Returns the count deleted.
func (db *DB) PruneNoOpSuggestionsForMigration(ctx context.Context, migrationID int) (int, error) {
	rows, err := db.Pool.Query(ctx, `
		SELECT sc.suggestion_id, sc.text, s.text
		FROM suggested_change sc
		JOIN sentence s ON s.sentence_id = sc.sentence_id
		WHERE s.migration_id = $1
	`, migrationID)
	if err != nil {
		return 0, fmt.Errorf("scan suggestions for prune: %w", err)
	}
	defer rows.Close()
	var noOpIDs []int
	for rows.Next() {
		var id int
		var suggText, sentText string
		if err := rows.Scan(&id, &suggText, &sentText); err != nil {
			return 0, fmt.Errorf("scan suggestion row: %w", err)
		}
		if sentence.NormalizeText(suggText) == sentence.NormalizeText(sentText) {
			noOpIDs = append(noOpIDs, id)
		}
	}
	if err := rows.Err(); err != nil {
		return 0, fmt.Errorf("iter suggestion rows: %w", err)
	}
	if len(noOpIDs) == 0 {
		return 0, nil
	}
	tag, err := db.Pool.Exec(ctx,
		`DELETE FROM suggested_change WHERE suggestion_id = ANY($1)`,
		noOpIDs,
	)
	if err != nil {
		return 0, fmt.Errorf("delete no-op suggestions: %w", err)
	}
	return int(tag.RowsAffected()), nil
}

// CopySuggestionsForward duplicates rows from one sentence to another (used
// by the migration processor on exact-match pairings). On per-user collision
// the existing destination row wins.
// Returns the number of suggestion rows actually inserted (after ON CONFLICT
// dedup). Zero is fine — most paired sentences have no suggestions.
func (db *DB) CopySuggestionsForward(ctx context.Context, fromSentenceID, toSentenceID string) (int, error) {
	tag, err := db.Pool.Exec(ctx, `
		INSERT INTO suggested_change (sentence_id, user_id, text, created_at, updated_at)
		SELECT $2, user_id, text, NOW(), NOW()
		FROM suggested_change
		WHERE sentence_id = $1
		ON CONFLICT (sentence_id, user_id) DO NOTHING
	`, fromSentenceID, toSentenceID)
	if err != nil {
		return 0, fmt.Errorf("copy suggestions: %w", err)
	}
	return int(tag.RowsAffected()), nil
}

// SetPreviousSentenceID: used by the backfill CLI. The migration processor
// sets this at insert time instead.
func (db *DB) SetPreviousSentenceID(ctx context.Context, sentenceID string, previousSentenceID *string) error {
	_, err := db.Pool.Exec(ctx,
		`UPDATE sentence SET previous_sentence_id = $1 WHERE sentence_id = $2`,
		previousSentenceID, sentenceID,
	)
	if err != nil {
		return fmt.Errorf("set previous_sentence_id for %s: %w", sentenceID, err)
	}
	return nil
}

// UpdateSentenceText: used by the raw-text backfill CLI to rewrite sentence
// text in place from the old stripped form to the new raw-with-markers form.
// Sentence_id is unchanged; only the text column is touched.
func (db *DB) UpdateSentenceText(ctx context.Context, sentenceID, text string) error {
	if err := sentence.ValidateSentenceText(text); err != nil {
		return fmt.Errorf("update sentence %s: %w", sentenceID, err)
	}
	_, err := db.Pool.Exec(ctx,
		`UPDATE sentence SET text = $1 WHERE sentence_id = $2`,
		text, sentenceID,
	)
	if err != nil {
		return fmt.Errorf("update sentence text for %s: %w", sentenceID, err)
	}
	return nil
}

func (db *DB) CreateSentences(ctx context.Context, sentences []models.Sentence) error {
	// Validate up-front so a bad row anywhere in the batch aborts before any
	// writes — easier to debug than partial inserts that survive rollback.
	for _, s := range sentences {
		if err := sentence.ValidateSentenceText(s.Text); err != nil {
			return fmt.Errorf("sentence %s: %w", s.SentenceID, err)
		}
	}

	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	query := `
		INSERT INTO sentence (sentence_id, migration_id, commit_hash, text, ordinal, previous_sentence_id)
		VALUES ($1, $2, $3, $4, $5, $6)
	`

	for _, s := range sentences {
		_, err := tx.Exec(ctx, query,
			s.SentenceID,
			s.MigrationID,
			s.CommitHash,
			s.Text,
			s.Ordinal,
			s.PreviousSentenceID,
		)
		if err != nil {
			return fmt.Errorf("failed to insert sentence %s: %w", s.SentenceID, err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("failed to commit transaction: %w", err)
	}

	return nil
}

// StoreCommandSlugs writes the static-slug index for a migration. Each
// migration derives its own slug set (from the #slugs in its block-command
// sentences), so this is an insert of that migration's rows — re-migration
// naturally re-points a slug to the new sentence because the new migration
// writes fresh rows keyed by its own migration_id. Idempotent per migration:
// clears any existing rows for the migration first.
func (db *DB) StoreCommandSlugs(ctx context.Context, migrationID int, slugs []sentence.StaticSlug) error {
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `DELETE FROM command_slug WHERE migration_id = $1`, migrationID); err != nil {
		return fmt.Errorf("failed to clear command_slug for migration %d: %w", migrationID, err)
	}

	const q = `
		INSERT INTO command_slug (migration_id, slug, sentence_id, kind)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (migration_id, slug) DO NOTHING
	`
	for _, s := range slugs {
		if _, err := tx.Exec(ctx, q, migrationID, s.Slug, s.SentenceID, string(s.Kind)); err != nil {
			return fmt.Errorf("failed to insert slug %q for migration %d: %w", s.Slug, migrationID, err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("failed to commit command_slug: %w", err)
	}
	return nil
}

// CommandSlug is a row of the slug index, joined with its sentence for reads.
type CommandSlug struct {
	Slug       string `json:"slug"`
	SentenceID string `json:"sentence_id"`
	Kind       string `json:"kind"`
}

// GetSlugsForMigration returns the static-slug index for a migration.
func (db *DB) GetSlugsForMigration(ctx context.Context, migrationID int) ([]CommandSlug, error) {
	rows, err := db.Pool.Query(ctx, `
		SELECT slug, sentence_id, kind
		FROM command_slug
		WHERE migration_id = $1
		ORDER BY slug
	`, migrationID)
	if err != nil {
		return nil, fmt.Errorf("failed to query command_slug: %w", err)
	}
	defer rows.Close()

	slugs := []CommandSlug{}
	for rows.Next() {
		var s CommandSlug
		if err := rows.Scan(&s.Slug, &s.SentenceID, &s.Kind); err != nil {
			return nil, fmt.Errorf("failed to scan command_slug: %w", err)
		}
		slugs = append(slugs, s)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating command_slug: %w", err)
	}
	return slugs, nil
}

// ResolveSlug returns the sentence_id a slug points at within a migration, or
// "" if the slug is not found (a dangling reference).
func (db *DB) ResolveSlug(ctx context.Context, migrationID int, slug string) (string, error) {
	var sentenceID string
	err := db.Pool.QueryRow(ctx, `
		SELECT sentence_id FROM command_slug WHERE migration_id = $1 AND slug = $2
	`, migrationID, slug).Scan(&sentenceID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("failed to resolve slug %q: %w", slug, err)
	}
	return sentenceID, nil
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

func (db *DB) GetSentencesByMigration(ctx context.Context, migrationID int) ([]models.Sentence, error) {
	query := `
		SELECT sentence_id, migration_id, commit_hash, text, ordinal, created_at, previous_sentence_id
		FROM sentence
		WHERE migration_id = $1
		ORDER BY ordinal
	`

	rows, err := db.Pool.Query(ctx, query, migrationID)
	if err != nil {
		return nil, fmt.Errorf("failed to query sentences: %w", err)
	}
	defer rows.Close()

	var sentences []models.Sentence
	for rows.Next() {
		var s models.Sentence
		err := rows.Scan(
			&s.SentenceID,
			&s.MigrationID,
			&s.CommitHash,
			&s.Text,
			&s.Ordinal,
			&s.CreatedAt,
			&s.PreviousSentenceID,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to scan sentence: %w", err)
		}
		sentences = append(sentences, s)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating sentences: %w", err)
	}

	return sentences, nil
}

func (db *DB) GetNotesByCommit(ctx context.Context, commitHash, username string) ([]models.Note, error) {
	query := `
		SELECT a.note_id, a.sentence_id, a.user_id, a.color, a.body,
		       a.priority, a.flagged, a.position, a.created_at, a.updated_at, a.deleted_at, a.completed_at
		FROM note a
		JOIN sentence s ON a.sentence_id = s.sentence_id
		WHERE s.commit_hash = $1
		  AND a.user_id = $2
		  AND a.deleted_at IS NULL
		  AND a.completed_at IS NULL
		ORDER BY s.ordinal, a.position
	`

	rows, err := db.Pool.Query(ctx, query, commitHash, username)
	if err != nil {
		return nil, fmt.Errorf("failed to query notes by commit: %w", err)
	}
	defer rows.Close()

	var notes []models.Note
	for rows.Next() {
		var a models.Note
		err := rows.Scan(
			&a.NoteID,
			&a.SentenceID,
			&a.UserID,
			&a.Color,
			&a.Body,
			&a.Priority,
			&a.Flagged,
			&a.Position,
			&a.CreatedAt,
			&a.UpdatedAt,
			&a.DeletedAt,
			&a.CompletedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to scan note: %w", err)
		}
		notes = append(notes, a)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating notes: %w", err)
	}

	// Tags are needed for the in-memory note cache the frontend reads
	// per-sentence-click. Loading them here keeps clicks free of network
	// roundtrips. Per-note query — N+1 in shape, but the manuscript
	// has at most a few hundred notes and each tag list is tiny.
	for i := range notes {
		tags, err := db.GetTagsForNote(ctx, notes[i].NoteID)
		if err != nil {
			return nil, fmt.Errorf("failed to get tags for note %d: %w", notes[i].NoteID, err)
		}
		notes[i].Tags = tags
	}

	return notes, nil
}

func getNoteOriginInfo(ctx context.Context, tx pgx.Tx, noteID int) (originSentenceID, originCommitHash, createdBy string, originMigrationID *int, err error) {
	query := `
		SELECT
			MIN(origin_sentence_id),
			MIN(origin_migration_id),
			MIN(origin_commit_hash),
			MIN(created_by)
		FROM note_version
		WHERE note_id = $1
	`
	err = tx.QueryRow(ctx, query, noteID).Scan(&originSentenceID, &originMigrationID, &originCommitHash, &createdBy)
	return
}

// Read sentence_id_history from the given version and append newSentenceID.
func getSentenceHistory(ctx context.Context, tx pgx.Tx, noteID int, version int, newSentenceID string) ([]byte, error) {
	query := `
		SELECT sentence_id_history
		FROM note_version
		WHERE note_id = $1 AND version = $2
	`
	var historyJSON []byte
	if err := tx.QueryRow(ctx, query, noteID, version).Scan(&historyJSON); err != nil {
		return nil, fmt.Errorf("failed to get sentence history: %w", err)
	}

	var history []string
	if len(historyJSON) > 0 {
		// A corrupt history row must surface, not be silently replaced by a
		// fresh one-element chain — that would destroy the audit trail.
		if err := json.Unmarshal(historyJSON, &history); err != nil {
			return nil, fmt.Errorf("corrupt sentence_id_history for note %d version %d: %w", noteID, version, err)
		}
	}
	history = append(history, newSentenceID)
	newHistoryJSON, err := json.Marshal(history)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal sentence history: %w", err)
	}
	return newHistoryJSON, nil
}

func insertNoteVersion(ctx context.Context, tx pgx.Tx, version *models.NoteVersion, historyJSON []byte) error {
	query := `
		INSERT INTO note_version (
			note_id, version, sentence_id, color, body, priority, flagged,
			migration_confidence, origin_sentence_id, origin_migration_id, origin_commit_hash,
			sentence_id_history, created_by
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
		RETURNING created_at
	`
	return tx.QueryRow(ctx, query,
		version.NoteID,
		version.Version,
		version.SentenceID,
		version.Color,
		version.Body,
		version.Priority,
		version.Flagged,
		version.MigrationConfidence,
		version.OriginSentenceID,
		version.OriginMigrationID,
		version.OriginCommitHash,
		historyJSON,
		version.CreatedBy,
	).Scan(&version.CreatedAt)
}

func (db *DB) GetNotesBySentence(ctx context.Context, sentenceID, username string) ([]models.Note, error) {
	query := `
		SELECT a.note_id, a.sentence_id, a.user_id, a.color, a.body,
		       a.priority, a.flagged, a.position, a.created_at, a.updated_at, a.deleted_at, a.completed_at
		FROM note a
		WHERE a.sentence_id = $1
		  AND a.user_id = $2
		  AND a.deleted_at IS NULL
		  AND a.completed_at IS NULL
		ORDER BY a.position
	`

	rows, err := db.Pool.Query(ctx, query, sentenceID, username)
	if err != nil {
		return nil, fmt.Errorf("failed to query notes by sentence: %w", err)
	}
	defer rows.Close()

	notes := []models.Note{} // non-nil so JSON encodes [] not null

	for rows.Next() {
		var a models.Note
		err := rows.Scan(
			&a.NoteID,
			&a.SentenceID,
			&a.UserID,
			&a.Color,
			&a.Body,
			&a.Priority,
			&a.Flagged,
			&a.Position,
			&a.CreatedAt,
			&a.UpdatedAt,
			&a.DeletedAt,
			&a.CompletedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to scan note: %w", err)
		}

		tags, err := db.GetTagsForNote(ctx, a.NoteID)
		if err != nil {
			return nil, fmt.Errorf("failed to get tags for note %d: %w", a.NoteID, err)
		}
		a.Tags = tags

		notes = append(notes, a)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating notes: %w", err)
	}

	return notes, nil
}

// createNoteMu serializes position assignment across concurrent
// creates: MAX(position) + increment is not atomic, and the schema has no
// unique constraint on (sentence_id, position) to catch a duplicate.
// Single-instance server, so a process-level mutex is sufficient.
var createNoteMu sync.Mutex

// CreateNote writes the note and its first version row.
func (db *DB) CreateNote(ctx context.Context, note *models.Note, version *models.NoteVersion) error {
	createNoteMu.Lock()
	defer createNoteMu.Unlock()

	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	// Append after the current max via the fractional indexer —
	// ReorderNote writes extended-precision / carried-prefix positions
	// (e.g. "a00015", "b0000") that a fixed "a%04d" parse would misread and
	// collide with.
	var maxPosition string
	queryMaxPos := `SELECT COALESCE(MAX(position), '') FROM note WHERE sentence_id = $1`
	if err := tx.QueryRow(ctx, queryMaxPos, note.SentenceID).Scan(&maxPosition); err != nil {
		return fmt.Errorf("failed to get max position: %w", err)
	}

	nextPosition, err := fractional.GeneratePositionBetween(maxPosition, "")
	if err != nil {
		return fmt.Errorf("failed to compute next position after %q: %w", maxPosition, err)
	}

	query1 := `
		INSERT INTO note (sentence_id, user_id, color, body, priority, flagged, position)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		RETURNING note_id, created_at, updated_at
	`
	err = tx.QueryRow(ctx, query1,
		note.SentenceID,
		note.UserID,
		note.Color,
		note.Body,
		note.Priority,
		note.Flagged,
		nextPosition,
	).Scan(
		&note.NoteID,
		&note.CreatedAt,
		&note.UpdatedAt,
	)
	if err != nil {
		return fmt.Errorf("failed to create note: %w", err)
	}

	note.Position = nextPosition

	// Sentence's commit_hash and migration_id become the note's origin.
	var commitHash string
	var migrationID int
	query_commit := `SELECT commit_hash, migration_id FROM sentence WHERE sentence_id = $1 LIMIT 1`
	if err := tx.QueryRow(ctx, query_commit, note.SentenceID).Scan(&commitHash, &migrationID); err != nil {
		return fmt.Errorf("failed to get commit hash and migration_id for sentence: %w", err)
	}

	historyJSON, _ := json.Marshal([]string{})

	version.NoteID = note.NoteID
	version.Version = 1
	version.SentenceID = note.SentenceID
	version.Color = note.Color
	version.Body = note.Body
	version.Priority = note.Priority
	version.Flagged = note.Flagged
	version.OriginSentenceID = note.SentenceID
	version.OriginMigrationID = &migrationID
	version.OriginCommitHash = commitHash
	version.CreatedBy = note.UserID

	if err := insertNoteVersion(ctx, tx, version, historyJSON); err != nil {
		return fmt.Errorf("failed to create note version: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("failed to commit transaction: %w", err)
	}

	return nil
}

// UpdateNote mutates the head row and appends a new version.
func (db *DB) UpdateNote(ctx context.Context, noteID int, note *models.Note, version *models.NoteVersion) error {
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	query1 := `
		UPDATE note
		SET sentence_id = $1, color = $2, body = $3, priority = $4, flagged = $5, updated_at = NOW()
		WHERE note_id = $6
		RETURNING updated_at
	`
	err = tx.QueryRow(ctx, query1,
		note.SentenceID,
		note.Color,
		note.Body,
		note.Priority,
		note.Flagged,
		noteID,
	).Scan(&note.UpdatedAt)
	if err != nil {
		return fmt.Errorf("failed to update note: %w", err)
	}

	var maxVersion int
	query2 := `SELECT COALESCE(MAX(version), 0) FROM note_version WHERE note_id = $1`
	if err := tx.QueryRow(ctx, query2, noteID).Scan(&maxVersion); err != nil {
		return fmt.Errorf("failed to get max version: %w", err)
	}

	originSentenceID, originCommitHash, createdBy, originMigrationID, err := getNoteOriginInfo(ctx, tx, noteID)
	if err != nil {
		return fmt.Errorf("failed to get origin info: %w", err)
	}

	newHistoryJSON, err := getSentenceHistory(ctx, tx, noteID, maxVersion, note.SentenceID)
	if err != nil {
		return err
	}

	version.NoteID = noteID
	version.Version = maxVersion + 1
	version.SentenceID = note.SentenceID
	version.Color = note.Color
	version.Body = note.Body
	version.Priority = note.Priority
	version.Flagged = note.Flagged
	version.OriginSentenceID = originSentenceID
	version.OriginMigrationID = originMigrationID
	version.OriginCommitHash = originCommitHash
	version.CreatedBy = createdBy

	if err := insertNoteVersion(ctx, tx, version, newHistoryJSON); err != nil {
		return fmt.Errorf("failed to create note version: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("failed to commit transaction: %w", err)
	}

	return nil
}

// NoteMigrationItem: one note to repoint to a new sentence.
type NoteMigrationItem struct {
	NoteID  int
	NewSentenceID string
	Confidence    float64
}

// MigrateNotes is all-or-nothing: error means zero rows committed.
// Each item produces one note UPDATE and one note_version INSERT.
func (db *DB) MigrateNotes(ctx context.Context, items []NoteMigrationItem) (int, error) {
	if len(items) == 0 {
		return 0, nil
	}

	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	// Same per-note flow as UpdateNote, batched in one tx.
	updateNote := `
		UPDATE note
		SET sentence_id = $1, updated_at = NOW()
		WHERE note_id = $2
		  AND deleted_at IS NULL
		  AND completed_at IS NULL
	`

	for _, item := range items {
		// Read latest version first so copied-forward fields + history are authoritative.
		var (
			color      string
			body       *string
			priority   string
			flagged    bool
			maxVersion int
		)
		if err := tx.QueryRow(ctx, `
			SELECT color, body, priority, flagged, version
			FROM note_version
			WHERE note_id = $1
			ORDER BY version DESC
			LIMIT 1
		`, item.NoteID).Scan(&color, &body, &priority, &flagged, &maxVersion); err != nil {
			return 0, fmt.Errorf("note %d: get latest version: %w", item.NoteID, err)
		}

		tag, err := tx.Exec(ctx, updateNote, item.NewSentenceID, item.NoteID)
		if err != nil {
			return 0, fmt.Errorf("note %d: update sentence_id: %w", item.NoteID, err)
		}
		if tag.RowsAffected() == 0 {
			// Hard fail so the whole migration rolls back rather than desyncing versions.
			return 0, fmt.Errorf("note %d: not found or already deleted", item.NoteID)
		}

		originSentenceID, originCommitHash, createdBy, originMigrationID, err := getNoteOriginInfo(ctx, tx, item.NoteID)
		if err != nil {
			return 0, fmt.Errorf("note %d: get origin info: %w", item.NoteID, err)
		}

		newHistoryJSON, err := getSentenceHistory(ctx, tx, item.NoteID, maxVersion, item.NewSentenceID)
		if err != nil {
			return 0, fmt.Errorf("note %d: %w", item.NoteID, err)
		}

		conf := item.Confidence
		newVersion := &models.NoteVersion{
			NoteID:        item.NoteID,
			Version:             maxVersion + 1,
			SentenceID:          item.NewSentenceID,
			Color:               color,
			Body:                body,
			Priority:            priority,
			Flagged:             flagged,
			MigrationConfidence: &conf,
			OriginSentenceID:    originSentenceID,
			OriginMigrationID:   originMigrationID,
			OriginCommitHash:    originCommitHash,
			CreatedBy:           createdBy,
		}
		if err := insertNoteVersion(ctx, tx, newVersion, newHistoryJSON); err != nil {
			return 0, fmt.Errorf("note %d: insert version: %w", item.NoteID, err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("commit migration: %w", err)
	}
	return len(items), nil
}

func (db *DB) SoftDeleteNote(ctx context.Context, noteID int) error {
	query := `
		UPDATE note
		SET deleted_at = NOW()
		WHERE note_id = $1
		  AND deleted_at IS NULL
	`
	result, err := db.Pool.Exec(ctx, query, noteID)
	if err != nil {
		return fmt.Errorf("failed to soft delete note: %w", err)
	}

	rowsAffected := result.RowsAffected()
	if rowsAffected == 0 {
		return fmt.Errorf("note not found or already deleted")
	}

	return nil
}

func (db *DB) CompleteNote(ctx context.Context, noteID int) error {
	query := `
		UPDATE note
		SET completed_at = NOW()
		WHERE note_id = $1
		  AND deleted_at IS NULL
		  AND completed_at IS NULL
	`
	result, err := db.Pool.Exec(ctx, query, noteID)
	if err != nil {
		return fmt.Errorf("failed to complete note: %w", err)
	}

	rowsAffected := result.RowsAffected()
	if rowsAffected == 0 {
		return fmt.Errorf("note not found or already completed")
	}

	return nil
}

func (db *DB) GetLatestNoteVersion(ctx context.Context, noteID int) (*models.NoteVersion, error) {
	query := `
		SELECT
			note_id, version, sentence_id, color, body, priority, flagged,
			sentence_id_history, migration_confidence,
			origin_sentence_id, origin_migration_id, origin_commit_hash, created_at, created_by
		FROM note_version
		WHERE note_id = $1
		ORDER BY version DESC
		LIMIT 1
	`

	var av models.NoteVersion
	var historyJSON []byte

	err := db.Pool.QueryRow(ctx, query, noteID).Scan(
		&av.NoteID,
		&av.Version,
		&av.SentenceID,
		&av.Color,
		&av.Body,
		&av.Priority,
		&av.Flagged,
		&historyJSON,
		&av.MigrationConfidence,
		&av.OriginSentenceID,
		&av.OriginMigrationID,
		&av.OriginCommitHash,
		&av.CreatedAt,
		&av.CreatedBy,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to get note version: %w", err)
	}

	if err := json.Unmarshal(historyJSON, &av.SentenceIDHistory); err != nil {
		return nil, fmt.Errorf("failed to unmarshal history: %w", err)
	}

	return &av, nil
}

func (db *DB) GetActiveNotesForSentence(ctx context.Context, sentenceID string) ([]models.Note, error) {
	query := `
		SELECT a.note_id, a.sentence_id, a.user_id, a.color, a.body,
		       a.priority, a.flagged, a.position, a.created_at, a.updated_at, a.deleted_at, a.completed_at
		FROM note a
		WHERE a.sentence_id = $1
		  AND a.deleted_at IS NULL
		  AND a.completed_at IS NULL
	`

	rows, err := db.Pool.Query(ctx, query, sentenceID)
	if err != nil {
		return nil, fmt.Errorf("failed to query notes: %w", err)
	}
	defer rows.Close()

	var notes []models.Note
	for rows.Next() {
		var a models.Note
		err := rows.Scan(
			&a.NoteID,
			&a.SentenceID,
			&a.UserID,
			&a.Color,
			&a.Body,
			&a.Priority,
			&a.Flagged,
			&a.Position,
			&a.CreatedAt,
			&a.UpdatedAt,
			&a.DeletedAt,
			&a.CompletedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to scan note: %w", err)
		}
		notes = append(notes, a)
	}

	// A connection drop mid-iteration would otherwise return a PARTIAL list
	// as success — the migration processor would silently strand the missing
	// notes on old sentences.
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating notes: %w", err)
	}

	return notes, nil
}

func (db *DB) GetOrCreateTag(ctx context.Context, tagName string, migrationID int) (*models.Tag, error) {
	var tag models.Tag
	query := `
		SELECT tag_id, tag_name, migration_id, created_at
		FROM tag
		WHERE tag_name = $1 AND migration_id = $2
	`
	err := db.Pool.QueryRow(ctx, query, tagName, migrationID).Scan(
		&tag.TagID,
		&tag.TagName,
		&tag.MigrationID,
		&tag.CreatedAt,
	)
	if err == nil {
		return &tag, nil
	}
	if err != pgx.ErrNoRows {
		return nil, fmt.Errorf("failed to query tag: %w", err)
	}

	createQuery := `
		INSERT INTO tag (tag_name, migration_id)
		VALUES ($1, $2)
		RETURNING tag_id, tag_name, migration_id, created_at
	`
	err = db.Pool.QueryRow(ctx, createQuery, tagName, migrationID).Scan(
		&tag.TagID,
		&tag.TagName,
		&tag.MigrationID,
		&tag.CreatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create tag: %w", err)
	}

	return &tag, nil
}

// AddTagToNote is idempotent; creates the tag if missing.
func (db *DB) AddTagToNote(ctx context.Context, noteID int, tagName string, migrationID int) error {
	tag, err := db.GetOrCreateTag(ctx, tagName, migrationID)
	if err != nil {
		return err
	}

	query := `
		INSERT INTO note_tag (note_id, tag_id)
		VALUES ($1, $2)
		ON CONFLICT (note_id, tag_id) DO NOTHING
	`
	_, err = db.Pool.Exec(ctx, query, noteID, tag.TagID)
	if err != nil {
		return fmt.Errorf("failed to add tag to note: %w", err)
	}

	return nil
}

func (db *DB) RemoveTagFromNote(ctx context.Context, noteID int, tagID int) error {
	query := `
		DELETE FROM note_tag
		WHERE note_id = $1 AND tag_id = $2
	`
	result, err := db.Pool.Exec(ctx, query, noteID, tagID)
	if err != nil {
		return fmt.Errorf("failed to remove tag from note: %w", err)
	}

	rowsAffected := result.RowsAffected()
	if rowsAffected == 0 {
		return fmt.Errorf("tag not found on note")
	}

	return nil
}

func (db *DB) GetTagsForNote(ctx context.Context, noteID int) ([]models.Tag, error) {
	query := `
		SELECT t.tag_id, t.tag_name, t.migration_id, t.created_at
		FROM tag t
		JOIN note_tag at ON t.tag_id = at.tag_id
		WHERE at.note_id = $1
		ORDER BY t.tag_name
	`

	rows, err := db.Pool.Query(ctx, query, noteID)
	if err != nil {
		return nil, fmt.Errorf("failed to query tags: %w", err)
	}
	defer rows.Close()

	tags := []models.Tag{}
	for rows.Next() {
		var tag models.Tag
		err := rows.Scan(
			&tag.TagID,
			&tag.TagName,
			&tag.MigrationID,
			&tag.CreatedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to scan tag: %w", err)
		}
		tags = append(tags, tag)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating tags: %w", err)
	}

	return tags, nil
}

func (db *DB) GetAllTagsForMigration(ctx context.Context, migrationID int) ([]models.Tag, error) {
	query := `
		SELECT tag_id, tag_name, migration_id, created_at
		FROM tag
		WHERE migration_id = $1
		ORDER BY tag_name
	`

	rows, err := db.Pool.Query(ctx, query, migrationID)
	if err != nil {
		return nil, fmt.Errorf("failed to query tags: %w", err)
	}
	defer rows.Close()

	tags := []models.Tag{}
	for rows.Next() {
		var tag models.Tag
		err := rows.Scan(
			&tag.TagID,
			&tag.TagName,
			&tag.MigrationID,
			&tag.CreatedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to scan tag: %w", err)
		}
		tags = append(tags, tag)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating tags: %w", err)
	}

	return tags, nil
}

// ReorderNote assigns a fractional-index position for the target slot.
func (db *DB) ReorderNote(ctx context.Context, noteID int, sentenceID string, newIndex int) error {
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	query := `SELECT position FROM note WHERE sentence_id = $1 AND deleted_at IS NULL AND completed_at IS NULL ORDER BY position`
	rows, err := tx.Query(ctx, query, sentenceID)
	if err != nil {
		return fmt.Errorf("failed to query positions: %w", err)
	}
	defer rows.Close()

	var positions []string
	for rows.Next() {
		var pos string
		if err := rows.Scan(&pos); err != nil {
			return fmt.Errorf("failed to scan position: %w", err)
		}
		positions = append(positions, pos)
	}

	if err := rows.Err(); err != nil {
		return fmt.Errorf("error iterating positions: %w", err)
	}

	newPosition, err := fractional.GetPositionAtIndex(positions, newIndex)
	if err != nil {
		return fmt.Errorf("failed to calculate new position: %w", err)
	}

	updateQuery := `UPDATE note SET position = $1, updated_at = NOW() WHERE note_id = $2`
	_, err = tx.Exec(ctx, updateQuery, newPosition, noteID)
	if err != nil {
		return fmt.Errorf("failed to update note position: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("failed to commit transaction: %w", err)
	}

	return nil
}

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

func (db *DB) GetNoteByID(ctx context.Context, noteID int) (*models.Note, error) {
	query := `
		SELECT note_id, sentence_id, user_id, color, body,
		       priority, flagged, position, created_at, updated_at, deleted_at, completed_at
		FROM note
		WHERE note_id = $1
		  AND deleted_at IS NULL
		  AND completed_at IS NULL
	`

	var a models.Note
	err := db.Pool.QueryRow(ctx, query, noteID).Scan(
		&a.NoteID,
		&a.SentenceID,
		&a.UserID,
		&a.Color,
		&a.Body,
		&a.Priority,
		&a.Flagged,
		&a.Position,
		&a.CreatedAt,
		&a.UpdatedAt,
		&a.DeletedAt,
		&a.CompletedAt,
	)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get note: %w", err)
	}

	return &a, nil
}
