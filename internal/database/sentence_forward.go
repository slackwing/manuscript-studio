package database

// Write-forwarding (2026-10-19): a write aimed at a sentence of an OLDER
// migration — a tab loaded before a commit — lands on that sentence's
// counterpart in the newest one instead of being orphaned (or refused).

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// ForwardSentenceID follows previous_sentence_id links (each new sentence
// names its best match in the migration before — the same pairing the
// migration's carry-forward uses) from sentenceID to its counterpart in
// migration toMigrationID. "" when it has none there: the sentence was
// deleted, or merged into a neighbor that kept the other's lineage.
func (db *DB) ForwardSentenceID(ctx context.Context, sentenceID string, toMigrationID int) (string, error) {
	var id string
	err := db.Pool.QueryRow(ctx, `
		WITH RECURSIVE chain(id, migration_id, ordinal, depth) AS (
			SELECT sentence_id, migration_id, ordinal, 0 FROM sentence WHERE sentence_id = $1
			UNION ALL
			SELECT s.sentence_id, s.migration_id, s.ordinal, c.depth + 1
			  FROM sentence s JOIN chain c ON s.previous_sentence_id = c.id
			 WHERE c.migration_id <> $2 AND c.depth < 500
		)
		SELECT id FROM chain WHERE migration_id = $2 ORDER BY ordinal LIMIT 1
	`, sentenceID, toMigrationID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("forward sentence %s: %w", sentenceID, err)
	}
	return id, nil
}

// HasActiveMigration: is a migration of this manuscript pending or running?
// Its carry-forward copies suggestions mid-run, so a write landing on the
// old migration meanwhile would be left behind.
func (db *DB) HasActiveMigration(ctx context.Context, manuscriptID int) (bool, error) {
	var active bool
	err := db.Pool.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM migration
		               WHERE manuscript_id = $1 AND status IN ('pending', 'running'))
	`, manuscriptID).Scan(&active)
	if err != nil {
		return false, fmt.Errorf("active migration for %d: %w", manuscriptID, err)
	}
	return active, nil
}
