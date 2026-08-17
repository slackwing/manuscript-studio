package database

// Sentence rows + the command-slug index (split out of queries.go, 2026-08 —
// pure code motion).

import (
	"context"
	"errors"
	"fmt"

	"github.com/slackwing/manuscript-studio/internal/models"
	"github.com/slackwing/manuscript-studio/internal/sentence"

	"github.com/jackc/pgx/v5"
)

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

	// COPY, not row-at-a-time INSERTs: a migration writes ~1000+ rows, and one
	// network round-trip per row made this the slowest phase of every push —
	// any DB latency blip multiplied by the row count.
	rows := make([][]interface{}, len(sentences))
	for i, s := range sentences {
		rows[i] = []interface{}{s.SentenceID, s.MigrationID, s.CommitHash, s.Text, s.Ordinal, s.PreviousSentenceID}
	}
	if _, err := tx.CopyFrom(ctx,
		pgx.Identifier{"sentence"},
		[]string{"sentence_id", "migration_id", "commit_hash", "text", "ordinal", "previous_sentence_id"},
		pgx.CopyFromRows(rows),
	); err != nil {
		return fmt.Errorf("failed to bulk-insert sentences: %w", err)
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

	// One pipelined batch instead of a round-trip per slug (ON CONFLICT rules
	// out COPY here).
	const q = `
		INSERT INTO command_slug (migration_id, slug, sentence_id, kind)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (migration_id, slug) DO NOTHING
	`
	b := &pgx.Batch{}
	for _, s := range slugs {
		b.Queue(q, migrationID, s.Slug, s.SentenceID, string(s.Kind))
	}
	if err := tx.SendBatch(ctx, b).Close(); err != nil {
		return fmt.Errorf("failed to insert slugs for migration %d: %w", migrationID, err)
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
