package database

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/slackwing/manuscript-studio/internal/fractional"
	"github.com/slackwing/manuscript-studio/internal/models"

	"github.com/jackc/pgx/v5"
)

// CreateManuscript creates a new manuscript record
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

// GetManuscript retrieves a manuscript by repo and file path
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

// GetLatestMigration gets the most recent migration for a manuscript
func (db *DB) GetLatestMigration(ctx context.Context, manuscriptID int) (*models.Migration, error) {
	query := `
		SELECT migration_id, manuscript_id, commit_hash, segmenter,
		       parent_migration_id, branch_name, processed_at, sentence_count,
		       additions_count, deletions_count, changes_count, sentence_id_array
		FROM migration
		WHERE manuscript_id = $1
		ORDER BY processed_at DESC
		LIMIT 1
	`

	var m models.Migration
	var sentenceIDArrayJSON []byte

	err := db.Pool.QueryRow(ctx, query, manuscriptID).Scan(
		&m.MigrationID,
		&m.ManuscriptID,
		&m.CommitHash,
		&m.Segmenter,
		&m.ParentMigrationID,
		&m.BranchName,
		&m.ProcessedAt,
		&m.SentenceCount,
		&m.AdditionsCount,
		&m.DeletionsCount,
		&m.ChangesCount,
		&sentenceIDArrayJSON,
	)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get latest migration: %w", err)
	}

	// Parse JSONB array
	if err := json.Unmarshal(sentenceIDArrayJSON, &m.SentenceIDArray); err != nil {
		return nil, fmt.Errorf("failed to parse sentence_id_array: %w", err)
	}

	return &m, nil
}

// GetMigrations gets all migrations for a manuscript, ordered by most recent first
func (db *DB) GetMigrations(ctx context.Context, manuscriptID int) ([]models.Migration, error) {
	query := `
		SELECT migration_id, manuscript_id, commit_hash, segmenter,
		       parent_migration_id, branch_name, processed_at, sentence_count,
		       additions_count, deletions_count, changes_count, sentence_id_array
		FROM migration
		WHERE manuscript_id = $1
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
		var sentenceIDArrayJSON []byte

		err := rows.Scan(
			&m.MigrationID,
			&m.ManuscriptID,
			&m.CommitHash,
			&m.Segmenter,
			&m.ParentMigrationID,
			&m.BranchName,
			&m.ProcessedAt,
			&m.SentenceCount,
			&m.AdditionsCount,
			&m.DeletionsCount,
			&m.ChangesCount,
			&sentenceIDArrayJSON,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to scan migration: %w", err)
		}

		// Parse JSONB array
		if err := json.Unmarshal(sentenceIDArrayJSON, &m.SentenceIDArray); err != nil {
			return nil, fmt.Errorf("failed to parse sentence_id_array: %w", err)
		}

		migrations = append(migrations, m)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating migrations: %w", err)
	}

	return migrations, nil
}

// CreateMigration creates a new migration record and returns the migration_id
func (db *DB) CreateMigration(ctx context.Context, m *models.Migration) error {
	// Convert sentence ID array to JSON
	sentenceIDArrayJSON, err := json.Marshal(m.SentenceIDArray)
	if err != nil {
		return fmt.Errorf("failed to marshal sentence_id_array: %w", err)
	}

	query := `
		INSERT INTO migration (
			manuscript_id, commit_hash, segmenter, parent_migration_id,
			branch_name, sentence_count, additions_count, deletions_count,
			changes_count, sentence_id_array
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
		RETURNING migration_id, processed_at
	`

	err = db.Pool.QueryRow(ctx, query,
		m.ManuscriptID,
		m.CommitHash,
		m.Segmenter,
		m.ParentMigrationID,
		m.BranchName,
		m.SentenceCount,
		m.AdditionsCount,
		m.DeletionsCount,
		m.ChangesCount,
		sentenceIDArrayJSON,
	).Scan(&m.MigrationID, &m.ProcessedAt)
	if err != nil {
		return fmt.Errorf("failed to create migration: %w", err)
	}

	return nil
}

// CreateSentences creates multiple sentence records in a transaction
func (db *DB) CreateSentences(ctx context.Context, sentences []models.Sentence) error {
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	query := `
		INSERT INTO sentence (sentence_id, migration_id, commit_hash, text, word_count, ordinal)
		VALUES ($1, $2, $3, $4, $5, $6)
	`

	for _, s := range sentences {
		_, err := tx.Exec(ctx, query,
			s.SentenceID,
			s.MigrationID,
			s.CommitHash,
			s.Text,
			s.WordCount,
			s.Ordinal,
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

// GetMigrationByID retrieves a migration by its ID
func (db *DB) GetMigrationByID(ctx context.Context, migrationID int) (*models.Migration, error) {
	query := `
		SELECT migration_id, manuscript_id, commit_hash, segmenter,
		       parent_migration_id, branch_name, processed_at, sentence_count,
		       additions_count, deletions_count, changes_count, sentence_id_array
		FROM migration
		WHERE migration_id = $1
	`

	var m models.Migration
	var sentenceIDArrayJSON []byte

	err := db.Pool.QueryRow(ctx, query, migrationID).Scan(
		&m.MigrationID,
		&m.ManuscriptID,
		&m.CommitHash,
		&m.Segmenter,
		&m.ParentMigrationID,
		&m.BranchName,
		&m.ProcessedAt,
		&m.SentenceCount,
		&m.AdditionsCount,
		&m.DeletionsCount,
		&m.ChangesCount,
		&sentenceIDArrayJSON,
	)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get migration by ID: %w", err)
	}

	// Parse JSONB array
	if err := json.Unmarshal(sentenceIDArrayJSON, &m.SentenceIDArray); err != nil {
		return nil, fmt.Errorf("failed to parse sentence_id_array: %w", err)
	}

	return &m, nil
}

// GetMigrationByCommitAndSegmenter retrieves a migration by commit hash and segmenter version
func (db *DB) GetMigrationByCommitAndSegmenter(ctx context.Context, manuscriptID int, commitHash, segmenter string) (*models.Migration, error) {
	query := `
		SELECT migration_id, manuscript_id, commit_hash, segmenter,
		       parent_migration_id, branch_name, processed_at, sentence_count,
		       additions_count, deletions_count, changes_count, sentence_id_array
		FROM migration
		WHERE manuscript_id = $1 AND commit_hash = $2 AND segmenter = $3
	`

	var m models.Migration
	var sentenceIDArrayJSON []byte

	err := db.Pool.QueryRow(ctx, query, manuscriptID, commitHash, segmenter).Scan(
		&m.MigrationID,
		&m.ManuscriptID,
		&m.CommitHash,
		&m.Segmenter,
		&m.ParentMigrationID,
		&m.BranchName,
		&m.ProcessedAt,
		&m.SentenceCount,
		&m.AdditionsCount,
		&m.DeletionsCount,
		&m.ChangesCount,
		&sentenceIDArrayJSON,
	)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get migration by commit and segmenter: %w", err)
	}

	// Parse JSONB array
	if err := json.Unmarshal(sentenceIDArrayJSON, &m.SentenceIDArray); err != nil {
		return nil, fmt.Errorf("failed to parse sentence_id_array: %w", err)
	}

	return &m, nil
}

// GetSentencesByMigration retrieves all sentences for a given migration_id
func (db *DB) GetSentencesByMigration(ctx context.Context, migrationID int) ([]models.Sentence, error) {
	query := `
		SELECT sentence_id, migration_id, commit_hash, text, word_count, ordinal, created_at
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
			&s.WordCount,
			&s.Ordinal,
			&s.CreatedAt,
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

// GetSentencesByCommit retrieves all sentences for a given commit hash (for backward compatibility)
func (db *DB) GetSentencesByCommit(ctx context.Context, commitHash string) ([]models.Sentence, error) {
	query := `
		SELECT sentence_id, migration_id, commit_hash, text, word_count, ordinal, created_at
		FROM sentence
		WHERE commit_hash = $1
		ORDER BY ordinal
	`

	rows, err := db.Pool.Query(ctx, query, commitHash)
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
			&s.WordCount,
			&s.Ordinal,
			&s.CreatedAt,
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

// GetAnnotationsByCommit retrieves all active annotations for sentences in a commit for a specific user
func (db *DB) GetAnnotationsByCommit(ctx context.Context, commitHash, username string) ([]models.Annotation, error) {
	query := `
		SELECT a.annotation_id, a.sentence_id, a.user_id, a.color, a.note,
		       a.priority, a.flagged, a.position, a.created_at, a.updated_at, a.deleted_at
		FROM annotation a
		JOIN sentence s ON a.sentence_id = s.sentence_id
		WHERE s.commit_hash = $1
		  AND a.user_id = $2
		  AND a.deleted_at IS NULL
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
		)
		if err != nil {
			return nil, fmt.Errorf("failed to scan annotation: %w", err)
		}
		annotations = append(annotations, a)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating annotations: %w", err)
	}

	return annotations, nil
}

// getAnnotationOriginInfo retrieves origin metadata for an annotation
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

// getSentenceHistory retrieves and appends to the sentence_id_history for an annotation
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

// insertAnnotationVersion creates a new annotation version record
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

// GetAnnotationsBySentence retrieves all active annotations for a specific sentence
func (db *DB) GetAnnotationsBySentence(ctx context.Context, sentenceID, username string) ([]models.Annotation, error) {
	query := `
		SELECT a.annotation_id, a.sentence_id, a.user_id, a.color, a.note,
		       a.priority, a.flagged, a.position, a.created_at, a.updated_at, a.deleted_at
		FROM annotation a
		WHERE a.sentence_id = $1
		  AND a.user_id = $2
		  AND a.deleted_at IS NULL
		ORDER BY a.position
	`

	rows, err := db.Pool.Query(ctx, query, sentenceID, username)
	if err != nil {
		return nil, fmt.Errorf("failed to query annotations by sentence: %w", err)
	}
	defer rows.Close()

	// Initialize as empty slice (not nil) so JSON serialization returns [] instead of null
	annotations := []models.Annotation{}
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
		)
		if err != nil {
			return nil, fmt.Errorf("failed to scan annotation: %w", err)
		}

		// Load tags for this annotation
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

// CreateAnnotation creates a new annotation with its first version
func (db *DB) CreateAnnotation(ctx context.Context, annotation *models.Annotation, version *models.AnnotationVersion) error {
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	// Calculate position for new annotation
	// Get the maximum position for this sentence
	var maxPosition string
	queryMaxPos := `SELECT COALESCE(MAX(position), 'a') FROM annotation WHERE sentence_id = $1`
	if err := tx.QueryRow(ctx, queryMaxPos, annotation.SentenceID).Scan(&maxPosition); err != nil {
		return fmt.Errorf("failed to get max position: %w", err)
	}

	// Generate next position (simple increment for now)
	// Format: "a0000", "a0001", "a0002", etc.
	var nextPosition string
	if maxPosition == "a" {
		nextPosition = "a0000"
	} else {
		// Extract numeric part and increment
		var num int
		fmt.Sscanf(maxPosition, "a%d", &num)
		nextPosition = fmt.Sprintf("a%04d", num+1)
	}

	// Create annotation record
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

	// Set the position in the annotation struct
	// Parse the string position to float64
	posValue, _ := strconv.ParseFloat(nextPosition, 64)
	annotation.Position = posValue

	// Get commit_hash and migration_id for this sentence (for origin_commit_hash and origin_migration_id)
	var commitHash string
	var migrationID int
	query_commit := `SELECT commit_hash, migration_id FROM sentence WHERE sentence_id = $1 LIMIT 1`
	if err := tx.QueryRow(ctx, query_commit, annotation.SentenceID).Scan(&commitHash, &migrationID); err != nil {
		return fmt.Errorf("failed to get commit hash and migration_id for sentence: %w", err)
	}

	// Create first version using helper
	historyJSON, _ := json.Marshal([]string{})

	version.AnnotationID = annotation.AnnotationID
	version.Version = 1
	version.SentenceID = annotation.SentenceID
	version.Color = annotation.Color
	version.Note = annotation.Note
	version.Priority = annotation.Priority
	version.Flagged = annotation.Flagged
	version.OriginSentenceID = annotation.SentenceID
	version.OriginMigrationID = migrationID
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

// UpdateAnnotation updates an existing annotation and creates a new version
func (db *DB) UpdateAnnotation(ctx context.Context, annotationID int, annotation *models.Annotation, version *models.AnnotationVersion) error {
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	// Update annotation record
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

	// Get current max version
	var maxVersion int
	query2 := `SELECT COALESCE(MAX(version), 0) FROM annotation_version WHERE annotation_id = $1`
	if err := tx.QueryRow(ctx, query2, annotationID).Scan(&maxVersion); err != nil {
		return fmt.Errorf("failed to get max version: %w", err)
	}

	// Get origin info
	originSentenceID, originCommitHash, createdBy, originMigrationID, err := getAnnotationOriginInfo(ctx, tx, annotationID)
	if err != nil {
		return fmt.Errorf("failed to get origin info: %w", err)
	}

	// Get updated sentence history
	newHistoryJSON, err := getSentenceHistory(ctx, tx, annotationID, maxVersion, annotation.SentenceID)
	if err != nil {
		return err
	}

	// Create new version
	version.AnnotationID = annotationID
	version.Version = maxVersion + 1
	version.SentenceID = annotation.SentenceID
	version.Color = annotation.Color
	version.Note = annotation.Note
	version.Priority = annotation.Priority
	version.Flagged = annotation.Flagged
	version.OriginSentenceID = originSentenceID
	// Handle nil pointer
	if originMigrationID != nil {
		version.OriginMigrationID = *originMigrationID
	}
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

// SoftDeleteAnnotation marks an annotation as deleted
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

// GetLatestAnnotationVersion retrieves the latest version of an annotation
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

	// Unmarshal history
	if err := json.Unmarshal(historyJSON, &av.SentenceIDHistory); err != nil {
		return nil, fmt.Errorf("failed to unmarshal history: %w", err)
	}

	return &av, nil
}

// GetActiveAnnotationsForSentence retrieves all active annotations for a sentence
func (db *DB) GetActiveAnnotationsForSentence(ctx context.Context, sentenceID string) ([]models.Annotation, error) {
	query := `
		SELECT a.annotation_id, a.sentence_id, a.user_id, a.color, a.note,
		       a.priority, a.flagged, a.position, a.created_at, a.updated_at, a.deleted_at
		FROM annotation a
		WHERE a.sentence_id = $1
		  AND a.deleted_at IS NULL
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
		)
		if err != nil {
			return nil, fmt.Errorf("failed to scan annotation: %w", err)
		}
		annotations = append(annotations, a)
	}

	return annotations, nil
}

// GetOrCreateTag gets an existing tag or creates it if it doesn't exist
func (db *DB) GetOrCreateTag(ctx context.Context, tagName string, migrationID int) (*models.Tag, error) {
	// First try to get existing tag
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

	// Tag doesn't exist, create it
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

// AddTagToAnnotation adds a tag to an annotation (creates tag if needed)
func (db *DB) AddTagToAnnotation(ctx context.Context, annotationID int, tagName string, migrationID int) error {
	// Get or create the tag
	tag, err := db.GetOrCreateTag(ctx, tagName, migrationID)
	if err != nil {
		return err
	}

	// Add the tag to the annotation (ignore if already exists)
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

// RemoveTagFromAnnotation removes a tag from an annotation
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

// GetTagsForAnnotation retrieves all tags for a specific annotation
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

// GetAllTagsForMigration retrieves all unique tags used in a migration
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

// ReorderAnnotation updates the position of an annotation based on the target index
// within the list of annotations for a given sentence
func (db *DB) ReorderAnnotation(ctx context.Context, annotationID int, sentenceID string, newIndex int) error {
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	// Get all positions for this sentence, ordered by position
	query := `SELECT position FROM annotation WHERE sentence_id = $1 AND deleted_at IS NULL ORDER BY position`
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

	// Use fractional indexing to calculate new position
	newPosition, err := fractional.GetPositionAtIndex(positions, newIndex)
	if err != nil {
		return fmt.Errorf("failed to calculate new position: %w", err)
	}

	// Update the annotation's position
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

// GetUserByUsername retrieves a user by username
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

// GetAllUsers retrieves all users
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

// GetManuscriptAccessForUser retrieves all manuscripts a user can access
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

// HasManuscriptAccess checks if a user has access to a specific manuscript
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

// GetAnnotationByID retrieves an annotation by its ID
func (db *DB) GetAnnotationByID(ctx context.Context, annotationID int) (*models.Annotation, error) {
	query := `
		SELECT annotation_id, sentence_id, user_id, color, note,
		       priority, flagged, position, created_at, updated_at, deleted_at
		FROM annotation
		WHERE annotation_id = $1
		  AND deleted_at IS NULL
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
	)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get annotation: %w", err)
	}

	return &a, nil
}
