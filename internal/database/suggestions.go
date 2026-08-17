package database

// Suggested-change rows: upsert/delete, per-migration reads, migration
// carry-forward and no-op pruning (split out of queries.go, 2026-08 — pure
// code motion).

import (
	"context"
	"fmt"
	"strings"

	"github.com/slackwing/manuscript-studio/internal/models"
	"github.com/slackwing/manuscript-studio/internal/sentence"
)

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
// given migration whose text is already fully present in the committed
// document. Two shapes qualify (both compared under NormalizeText):
//
//  1. the suggestion matches its own sentence's text — the classic no-op,
//     left behind when a suggestion's text gets incorporated into the
//     source by a later commit and carried forward across exact-match
//     pairings;
//  2. the suggestion matches its sentence JOINED WITH adjacent committed
//     sentences — the multi-sentence twin of (1). A suggestion that
//     prepends a block command ("&anchor{...} We probably recounted...")
//     is applied as TWO committed sentences; the prose half then pairs
//     exact-match with the old sentence, the suggestion carries forward
//     forever, and every subsequent push mints ANOTHER copy of the
//     anchor. This rule breaks that loop.
//
// Scoped to current migration so old migrations remain untouched audit data.
// Returns the count deleted.
//
// orderedIDs is the migration's sentence order. The processor passes it
// directly because it prunes BEFORE MarkMigrationDone stores
// sentence_id_array; pass nil to fall back to the stored array.
func (db *DB) PruneNoOpSuggestionsForMigration(ctx context.Context, migrationID int, orderedIDs []string) (int, error) {
	// Document order + texts, for the neighbor-window rule.
	if len(orderedIDs) == 0 {
		mig, err := db.GetMigrationByID(ctx, migrationID)
		if err != nil {
			return 0, fmt.Errorf("load migration for prune: %w", err)
		}
		if mig != nil {
			orderedIDs = mig.SentenceIDArray
		}
	}
	orderByID := map[string]int{}
	var orderedTexts []string
	if len(orderedIDs) > 0 {
		textRows, err := db.Pool.Query(ctx,
			`SELECT sentence_id, text FROM sentence WHERE migration_id = $1`, migrationID)
		if err != nil {
			return 0, fmt.Errorf("scan sentences for prune: %w", err)
		}
		textByID := map[string]string{}
		for textRows.Next() {
			var id, text string
			if err := textRows.Scan(&id, &text); err != nil {
				textRows.Close()
				return 0, fmt.Errorf("scan sentence row: %w", err)
			}
			textByID[id] = text
		}
		textRows.Close()
		if err := textRows.Err(); err != nil {
			return 0, fmt.Errorf("iter sentence rows: %w", err)
		}
		orderedTexts = make([]string, 0, len(orderedIDs))
		for _, id := range orderedIDs {
			orderByID[id] = len(orderedTexts)
			orderedTexts = append(orderedTexts, textByID[id])
		}
	}

	rows, err := db.Pool.Query(ctx, `
		SELECT sc.suggestion_id, sc.text, s.sentence_id, s.text
		FROM suggested_change sc
		JOIN sentence s ON s.sentence_id = sc.sentence_id
		WHERE s.migration_id = $1
	`, migrationID)
	if err != nil {
		return 0, fmt.Errorf("scan suggestions for prune: %w", err)
	}
	defer rows.Close()
	var noOpIDs []int
	// windowApplied: does the suggestion equal some contiguous run of
	// committed sentences that includes its own (index j)? Window is
	// capped at 3 neighbors each side — a suggestion rarely segments into
	// more, and the cap keeps this O(1) per suggestion.
	windowApplied := func(normSugg string, j int) bool {
		const w = 3
		for start := max(0, j-w); start <= j; start++ {
			for end := j; end <= min(len(orderedTexts)-1, j+w); end++ {
				if start == j && end == j {
					continue // that's rule (1), already checked
				}
				joined := strings.Join(orderedTexts[start:end+1], "\n")
				if sentence.NormalizeText(joined) == normSugg {
					return true
				}
			}
		}
		return false
	}
	for rows.Next() {
		var id int
		var suggText, sentenceID, sentText string
		if err := rows.Scan(&id, &suggText, &sentenceID, &sentText); err != nil {
			return 0, fmt.Errorf("scan suggestion row: %w", err)
		}
		normSugg := sentence.NormalizeText(suggText)
		if normSugg == sentence.NormalizeText(sentText) {
			noOpIDs = append(noOpIDs, id)
			continue
		}
		// An empty normalized suggestion carries no comparable content —
		// never window-prune those.
		if normSugg == "" {
			continue
		}
		if j, ok := orderByID[sentenceID]; ok && windowApplied(normSugg, j) {
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

// CopySuggestionsForwardBulk: CopySuggestionsForward over every (from, to)
// pair in ONE statement — the migration processor carries suggestions for
// every exact-match pairing, and a round-trip per sentence made this scale
// with manuscript size. Pairs are parallel slices; returns rows inserted.
func (db *DB) CopySuggestionsForwardBulk(ctx context.Context, fromIDs, toIDs []string) (int, error) {
	if len(fromIDs) == 0 {
		return 0, nil
	}
	tag, err := db.Pool.Exec(ctx, `
		INSERT INTO suggested_change (sentence_id, user_id, text, created_at, updated_at)
		SELECT m.to_id, sc.user_id, sc.text, NOW(), NOW()
		FROM unnest($1::text[], $2::text[]) AS m(from_id, to_id)
		JOIN suggested_change sc ON sc.sentence_id = m.from_id
		ON CONFLICT (sentence_id, user_id) DO NOTHING
	`, fromIDs, toIDs)
	if err != nil {
		return 0, fmt.Errorf("copy suggestions forward: %w", err)
	}
	return int(tag.RowsAffected()), nil
}
