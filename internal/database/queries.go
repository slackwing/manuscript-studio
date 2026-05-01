package database

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

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
		RETURNING manuscript_id, repo_path, file_path, created_at
	`

	var m models.Manuscript
	err := db.Pool.QueryRow(ctx, query, repoPath, filePath).Scan(
		&m.ManuscriptID,
		&m.RepoPath,
		&m.FilePath,
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
		`SELECT manuscript_id, repo_path, file_path, created_at FROM manuscript WHERE manuscript_id = $1`,
		manuscriptID,
	).Scan(&m.ManuscriptID, &m.RepoPath, &m.FilePath, &m.CreatedAt)
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
		SELECT manuscript_id, repo_path, file_path, created_at
		FROM manuscript
		WHERE repo_path = $1 AND file_path = $2
	`

	var m models.Manuscript
	err := db.Pool.QueryRow(ctx, query, repoPath, filePath).Scan(
		&m.ManuscriptID,
		&m.RepoPath,
		&m.FilePath,
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
		branchName        *string
		sentenceCount     *int
		additionsCount    *int
		deletionsCount    *int
		changesCount      *int
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
	Text             string
	PreviousID       *string
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

func (db *DB) GetAnnotationsByCommit(ctx context.Context, commitHash, username string) ([]models.Annotation, error) {
	query := `
		SELECT a.annotation_id, a.sentence_id, a.user_id, a.color, a.note,
		       a.priority, a.flagged, a.position, a.created_at, a.updated_at, a.deleted_at, a.completed_at
		FROM annotation a
		JOIN sentence s ON a.sentence_id = s.sentence_id
		WHERE s.commit_hash = $1
		  AND a.user_id = $2
		  AND a.deleted_at IS NULL
		  AND a.completed_at IS NULL
		ORDER BY s.ordinal, a.position
	`

	rows, err := db.Pool.Query(ctx, query, commitHash, username)
	if err != nil {
		return nil, fmt.Errorf("failed to query annotations by commit: %w", err)
	}
	defer rows.Close()

	var annotations []models.Annotation
	for rows.Next() {
		var a models.Annotation
		err := rows.Scan(
			&a.AnnotationID,
			&a.SentenceID,
			&a.UserID,
			&a.Color,
			&a.Note,
			&a.Priority,
			&a.Flagged,
			&a.Position,
			&a.CreatedAt,
			&a.UpdatedAt,
			&a.DeletedAt,
			&a.CompletedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to scan annotation: %w", err)
		}
		annotations = append(annotations, a)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating annotations: %w", err)
	}

	// Tags are needed for the in-memory annotation cache the frontend reads
	// per-sentence-click. Loading them here keeps clicks free of network
	// roundtrips. Per-annotation query — N+1 in shape, but the manuscript
	// has at most a few hundred annotations and each tag list is tiny.
	for i := range annotations {
		tags, err := db.GetTagsForAnnotation(ctx, annotations[i].AnnotationID)
		if err != nil {
			return nil, fmt.Errorf("failed to get tags for annotation %d: %w", annotations[i].AnnotationID, err)
		}
		annotations[i].Tags = tags
	}

	return annotations, nil
}

func getAnnotationOriginInfo(ctx context.Context, tx pgx.Tx, annotationID int) (originSentenceID, originCommitHash, createdBy string, originMigrationID *int, err error) {
	query := `
		SELECT
			MIN(origin_sentence_id),
			MIN(origin_migration_id),
			MIN(origin_commit_hash),
			MIN(created_by)
		FROM annotation_version
		WHERE annotation_id = $1
	`
	err = tx.QueryRow(ctx, query, annotationID).Scan(&originSentenceID, &originMigrationID, &originCommitHash, &createdBy)
	return
}

// Read sentence_id_history from the given version and append newSentenceID.
func getSentenceHistory(ctx context.Context, tx pgx.Tx, annotationID int, version int, newSentenceID string) ([]byte, error) {
	query := `
		SELECT sentence_id_history
		FROM annotation_version
		WHERE annotation_id = $1 AND version = $2
	`
	var historyJSON []byte
	if err := tx.QueryRow(ctx, query, annotationID, version).Scan(&historyJSON); err != nil {
		return nil, fmt.Errorf("failed to get sentence history: %w", err)
	}

	var history []string
	json.Unmarshal(historyJSON, &history)
	history = append(history, newSentenceID)
	newHistoryJSON, _ := json.Marshal(history)
	return newHistoryJSON, nil
}

func insertAnnotationVersion(ctx context.Context, tx pgx.Tx, version *models.AnnotationVersion, historyJSON []byte) error {
	query := `
		INSERT INTO annotation_version (
			annotation_id, version, sentence_id, color, note, priority, flagged,
			migration_confidence, origin_sentence_id, origin_migration_id, origin_commit_hash,
			sentence_id_history, created_by
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
		RETURNING created_at
	`
	return tx.QueryRow(ctx, query,
		version.AnnotationID,
		version.Version,
		version.SentenceID,
		version.Color,
		version.Note,
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

func (db *DB) GetAnnotationsBySentence(ctx context.Context, sentenceID, username string) ([]models.Annotation, error) {
	query := `
		SELECT a.annotation_id, a.sentence_id, a.user_id, a.color, a.note,
		       a.priority, a.flagged, a.position, a.created_at, a.updated_at, a.deleted_at, a.completed_at
		FROM annotation a
		WHERE a.sentence_id = $1
		  AND a.user_id = $2
		  AND a.deleted_at IS NULL
		  AND a.completed_at IS NULL
		ORDER BY a.position
	`

	rows, err := db.Pool.Query(ctx, query, sentenceID, username)
	if err != nil {
		return nil, fmt.Errorf("failed to query annotations by sentence: %w", err)
	}
	defer rows.Close()

	annotations := []models.Annotation{} // non-nil so JSON encodes [] not null

	for rows.Next() {
		var a models.Annotation
		err := rows.Scan(
			&a.AnnotationID,
			&a.SentenceID,
			&a.UserID,
			&a.Color,
			&a.Note,
			&a.Priority,
			&a.Flagged,
			&a.Position,
			&a.CreatedAt,
			&a.UpdatedAt,
			&a.DeletedAt,
			&a.CompletedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to scan annotation: %w", err)
		}

		tags, err := db.GetTagsForAnnotation(ctx, a.AnnotationID)
		if err != nil {
			return nil, fmt.Errorf("failed to get tags for annotation %d: %w", a.AnnotationID, err)
		}
		a.Tags = tags

		annotations = append(annotations, a)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating annotations: %w", err)
	}

	return annotations, nil
}

// CreateAnnotation writes the annotation and its first version row.
func (db *DB) CreateAnnotation(ctx context.Context, annotation *models.Annotation, version *models.AnnotationVersion) error {
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	// Append-only "a0000" counter for create; ReorderAnnotation uses fractional indexing.
	var maxPosition string
	queryMaxPos := `SELECT COALESCE(MAX(position), 'a') FROM annotation WHERE sentence_id = $1`
	if err := tx.QueryRow(ctx, queryMaxPos, annotation.SentenceID).Scan(&maxPosition); err != nil {
		return fmt.Errorf("failed to get max position: %w", err)
	}

	var nextPosition string
	if maxPosition == "a" {
		nextPosition = "a0000"
	} else {
		var num int
		fmt.Sscanf(maxPosition, "a%d", &num)
		nextPosition = fmt.Sprintf("a%04d", num+1)
	}

	query1 := `
		INSERT INTO annotation (sentence_id, user_id, color, note, priority, flagged, position)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		RETURNING annotation_id, created_at, updated_at
	`
	err = tx.QueryRow(ctx, query1,
		annotation.SentenceID,
		annotation.UserID,
		annotation.Color,
		annotation.Note,
		annotation.Priority,
		annotation.Flagged,
		nextPosition,
	).Scan(
		&annotation.AnnotationID,
		&annotation.CreatedAt,
		&annotation.UpdatedAt,
	)
	if err != nil {
		return fmt.Errorf("failed to create annotation: %w", err)
	}

	annotation.Position = nextPosition

	// Sentence's commit_hash and migration_id become the annotation's origin.
	var commitHash string
	var migrationID int
	query_commit := `SELECT commit_hash, migration_id FROM sentence WHERE sentence_id = $1 LIMIT 1`
	if err := tx.QueryRow(ctx, query_commit, annotation.SentenceID).Scan(&commitHash, &migrationID); err != nil {
		return fmt.Errorf("failed to get commit hash and migration_id for sentence: %w", err)
	}

	historyJSON, _ := json.Marshal([]string{})

	version.AnnotationID = annotation.AnnotationID
	version.Version = 1
	version.SentenceID = annotation.SentenceID
	version.Color = annotation.Color
	version.Note = annotation.Note
	version.Priority = annotation.Priority
	version.Flagged = annotation.Flagged
	version.OriginSentenceID = annotation.SentenceID
	version.OriginMigrationID = &migrationID
	version.OriginCommitHash = commitHash
	version.CreatedBy = annotation.UserID

	if err := insertAnnotationVersion(ctx, tx, version, historyJSON); err != nil {
		return fmt.Errorf("failed to create annotation version: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("failed to commit transaction: %w", err)
	}

	return nil
}

// UpdateAnnotation mutates the head row and appends a new version.
func (db *DB) UpdateAnnotation(ctx context.Context, annotationID int, annotation *models.Annotation, version *models.AnnotationVersion) error {
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	query1 := `
		UPDATE annotation
		SET sentence_id = $1, color = $2, note = $3, priority = $4, flagged = $5, updated_at = NOW()
		WHERE annotation_id = $6
		RETURNING updated_at
	`
	err = tx.QueryRow(ctx, query1,
		annotation.SentenceID,
		annotation.Color,
		annotation.Note,
		annotation.Priority,
		annotation.Flagged,
		annotationID,
	).Scan(&annotation.UpdatedAt)
	if err != nil {
		return fmt.Errorf("failed to update annotation: %w", err)
	}

	var maxVersion int
	query2 := `SELECT COALESCE(MAX(version), 0) FROM annotation_version WHERE annotation_id = $1`
	if err := tx.QueryRow(ctx, query2, annotationID).Scan(&maxVersion); err != nil {
		return fmt.Errorf("failed to get max version: %w", err)
	}

	originSentenceID, originCommitHash, createdBy, originMigrationID, err := getAnnotationOriginInfo(ctx, tx, annotationID)
	if err != nil {
		return fmt.Errorf("failed to get origin info: %w", err)
	}

	newHistoryJSON, err := getSentenceHistory(ctx, tx, annotationID, maxVersion, annotation.SentenceID)
	if err != nil {
		return err
	}

	version.AnnotationID = annotationID
	version.Version = maxVersion + 1
	version.SentenceID = annotation.SentenceID
	version.Color = annotation.Color
	version.Note = annotation.Note
	version.Priority = annotation.Priority
	version.Flagged = annotation.Flagged
	version.OriginSentenceID = originSentenceID
	version.OriginMigrationID = originMigrationID
	version.OriginCommitHash = originCommitHash
	version.CreatedBy = createdBy

	if err := insertAnnotationVersion(ctx, tx, version, newHistoryJSON); err != nil {
		return fmt.Errorf("failed to create annotation version: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("failed to commit transaction: %w", err)
	}

	return nil
}

// AnnotationMigrationItem: one annotation to repoint to a new sentence.
type AnnotationMigrationItem struct {
	AnnotationID  int
	NewSentenceID string
	Confidence    float64
}

// MigrateAnnotations is all-or-nothing: error means zero rows committed.
// Each item produces one annotation UPDATE and one annotation_version INSERT.
func (db *DB) MigrateAnnotations(ctx context.Context, items []AnnotationMigrationItem) (int, error) {
	if len(items) == 0 {
		return 0, nil
	}

	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	// Same per-annotation flow as UpdateAnnotation, batched in one tx.
	updateAnnotation := `
		UPDATE annotation
		SET sentence_id = $1, updated_at = NOW()
		WHERE annotation_id = $2
		  AND deleted_at IS NULL
		  AND completed_at IS NULL
	`

	for _, item := range items {
		// Read latest version first so copied-forward fields + history are authoritative.
		var (
			color       string
			note        *string
			priority    string
			flagged     bool
			maxVersion  int
		)
		if err := tx.QueryRow(ctx, `
			SELECT color, note, priority, flagged, version
			FROM annotation_version
			WHERE annotation_id = $1
			ORDER BY version DESC
			LIMIT 1
		`, item.AnnotationID).Scan(&color, &note, &priority, &flagged, &maxVersion); err != nil {
			return 0, fmt.Errorf("annotation %d: get latest version: %w", item.AnnotationID, err)
		}

		tag, err := tx.Exec(ctx, updateAnnotation, item.NewSentenceID, item.AnnotationID)
		if err != nil {
			return 0, fmt.Errorf("annotation %d: update sentence_id: %w", item.AnnotationID, err)
		}
		if tag.RowsAffected() == 0 {
			// Hard fail so the whole migration rolls back rather than desyncing versions.
			return 0, fmt.Errorf("annotation %d: not found or already deleted", item.AnnotationID)
		}

		originSentenceID, originCommitHash, createdBy, originMigrationID, err := getAnnotationOriginInfo(ctx, tx, item.AnnotationID)
		if err != nil {
			return 0, fmt.Errorf("annotation %d: get origin info: %w", item.AnnotationID, err)
		}

		newHistoryJSON, err := getSentenceHistory(ctx, tx, item.AnnotationID, maxVersion, item.NewSentenceID)
		if err != nil {
			return 0, fmt.Errorf("annotation %d: %w", item.AnnotationID, err)
		}

		conf := item.Confidence
		newVersion := &models.AnnotationVersion{
			AnnotationID:        item.AnnotationID,
			Version:             maxVersion + 1,
			SentenceID:          item.NewSentenceID,
			Color:               color,
			Note:                note,
			Priority:            priority,
			Flagged:             flagged,
			MigrationConfidence: &conf,
			OriginSentenceID:    originSentenceID,
			OriginMigrationID:   originMigrationID,
			OriginCommitHash:    originCommitHash,
			CreatedBy:           createdBy,
		}
		if err := insertAnnotationVersion(ctx, tx, newVersion, newHistoryJSON); err != nil {
			return 0, fmt.Errorf("annotation %d: insert version: %w", item.AnnotationID, err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("commit migration: %w", err)
	}
	return len(items), nil
}

func (db *DB) SoftDeleteAnnotation(ctx context.Context, annotationID int) error {
	query := `
		UPDATE annotation
		SET deleted_at = NOW()
		WHERE annotation_id = $1
		  AND deleted_at IS NULL
	`
	result, err := db.Pool.Exec(ctx, query, annotationID)
	if err != nil {
		return fmt.Errorf("failed to soft delete annotation: %w", err)
	}

	rowsAffected := result.RowsAffected()
	if rowsAffected == 0 {
		return fmt.Errorf("annotation not found or already deleted")
	}

	return nil
}

func (db *DB) CompleteAnnotation(ctx context.Context, annotationID int) error {
	query := `
		UPDATE annotation
		SET completed_at = NOW()
		WHERE annotation_id = $1
		  AND deleted_at IS NULL
		  AND completed_at IS NULL
	`
	result, err := db.Pool.Exec(ctx, query, annotationID)
	if err != nil {
		return fmt.Errorf("failed to complete annotation: %w", err)
	}

	rowsAffected := result.RowsAffected()
	if rowsAffected == 0 {
		return fmt.Errorf("annotation not found or already completed")
	}

	return nil
}

func (db *DB) GetLatestAnnotationVersion(ctx context.Context, annotationID int) (*models.AnnotationVersion, error) {
	query := `
		SELECT
			annotation_id, version, sentence_id, color, note, priority, flagged,
			sentence_id_history, migration_confidence,
			origin_sentence_id, origin_migration_id, origin_commit_hash, created_at, created_by
		FROM annotation_version
		WHERE annotation_id = $1
		ORDER BY version DESC
		LIMIT 1
	`

	var av models.AnnotationVersion
	var historyJSON []byte

	err := db.Pool.QueryRow(ctx, query, annotationID).Scan(
		&av.AnnotationID,
		&av.Version,
		&av.SentenceID,
		&av.Color,
		&av.Note,
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
		return nil, fmt.Errorf("failed to get annotation version: %w", err)
	}

	if err := json.Unmarshal(historyJSON, &av.SentenceIDHistory); err != nil {
		return nil, fmt.Errorf("failed to unmarshal history: %w", err)
	}

	return &av, nil
}

func (db *DB) GetActiveAnnotationsForSentence(ctx context.Context, sentenceID string) ([]models.Annotation, error) {
	query := `
		SELECT a.annotation_id, a.sentence_id, a.user_id, a.color, a.note,
		       a.priority, a.flagged, a.position, a.created_at, a.updated_at, a.deleted_at, a.completed_at
		FROM annotation a
		WHERE a.sentence_id = $1
		  AND a.deleted_at IS NULL
		  AND a.completed_at IS NULL
	`

	rows, err := db.Pool.Query(ctx, query, sentenceID)
	if err != nil {
		return nil, fmt.Errorf("failed to query annotations: %w", err)
	}
	defer rows.Close()

	var annotations []models.Annotation
	for rows.Next() {
		var a models.Annotation
		err := rows.Scan(
			&a.AnnotationID,
			&a.SentenceID,
			&a.UserID,
			&a.Color,
			&a.Note,
			&a.Priority,
			&a.Flagged,
			&a.Position,
			&a.CreatedAt,
			&a.UpdatedAt,
			&a.DeletedAt,
			&a.CompletedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to scan annotation: %w", err)
		}
		annotations = append(annotations, a)
	}

	return annotations, nil
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

// AddTagToAnnotation is idempotent; creates the tag if missing.
func (db *DB) AddTagToAnnotation(ctx context.Context, annotationID int, tagName string, migrationID int) error {
	tag, err := db.GetOrCreateTag(ctx, tagName, migrationID)
	if err != nil {
		return err
	}

	query := `
		INSERT INTO annotation_tag (annotation_id, tag_id)
		VALUES ($1, $2)
		ON CONFLICT (annotation_id, tag_id) DO NOTHING
	`
	_, err = db.Pool.Exec(ctx, query, annotationID, tag.TagID)
	if err != nil {
		return fmt.Errorf("failed to add tag to annotation: %w", err)
	}

	return nil
}

func (db *DB) RemoveTagFromAnnotation(ctx context.Context, annotationID int, tagID int) error {
	query := `
		DELETE FROM annotation_tag
		WHERE annotation_id = $1 AND tag_id = $2
	`
	result, err := db.Pool.Exec(ctx, query, annotationID, tagID)
	if err != nil {
		return fmt.Errorf("failed to remove tag from annotation: %w", err)
	}

	rowsAffected := result.RowsAffected()
	if rowsAffected == 0 {
		return fmt.Errorf("tag not found on annotation")
	}

	return nil
}

func (db *DB) GetTagsForAnnotation(ctx context.Context, annotationID int) ([]models.Tag, error) {
	query := `
		SELECT t.tag_id, t.tag_name, t.migration_id, t.created_at
		FROM tag t
		JOIN annotation_tag at ON t.tag_id = at.tag_id
		WHERE at.annotation_id = $1
		ORDER BY t.tag_name
	`

	rows, err := db.Pool.Query(ctx, query, annotationID)
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

// ReorderAnnotation assigns a fractional-index position for the target slot.
func (db *DB) ReorderAnnotation(ctx context.Context, annotationID int, sentenceID string, newIndex int) error {
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	query := `SELECT position FROM annotation WHERE sentence_id = $1 AND deleted_at IS NULL AND completed_at IS NULL ORDER BY position`
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

	updateQuery := `UPDATE annotation SET position = $1, updated_at = NOW() WHERE annotation_id = $2`
	_, err = tx.Exec(ctx, updateQuery, newPosition, annotationID)
	if err != nil {
		return fmt.Errorf("failed to update annotation position: %w", err)
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

func (db *DB) GetAllUsers(ctx context.Context) ([]models.User, error) {
	query := `
		SELECT username, password_hash, role, created_at
		FROM "user"
		ORDER BY username
	`

	rows, err := db.Pool.Query(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("failed to query users: %w", err)
	}
	defer rows.Close()

	var users []models.User
	for rows.Next() {
		var u models.User
		if err := rows.Scan(&u.Username, &u.PasswordHash, &u.Role, &u.CreatedAt); err != nil {
			return nil, fmt.Errorf("failed to scan user: %w", err)
		}
		users = append(users, u)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating users: %w", err)
	}

	return users, nil
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

func (db *DB) GetAnnotationByID(ctx context.Context, annotationID int) (*models.Annotation, error) {
	query := `
		SELECT annotation_id, sentence_id, user_id, color, note,
		       priority, flagged, position, created_at, updated_at, deleted_at, completed_at
		FROM annotation
		WHERE annotation_id = $1
		  AND deleted_at IS NULL
		  AND completed_at IS NULL
	`

	var a models.Annotation
	err := db.Pool.QueryRow(ctx, query, annotationID).Scan(
		&a.AnnotationID,
		&a.SentenceID,
		&a.UserID,
		&a.Color,
		&a.Note,
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
		return nil, fmt.Errorf("failed to get annotation: %w", err)
	}

	return &a, nil
}
