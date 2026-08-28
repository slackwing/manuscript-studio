package database

// Suggested-change rows: upsert/delete, per-migration reads, migration
// carry-forward and no-op pruning (split out of queries.go, 2026-08 — pure
// code motion).

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/slackwing/manuscript-studio/internal/models"
	"github.com/slackwing/manuscript-studio/internal/sentence"
)

// suggestionCols is the canonical SELECT list for suggested_change (v3);
// suggestionColsSC is the sc.-qualified twin for JOINed queries.
const suggestionCols = `suggestion_id, sentence_id, user_id, text, created_at, updated_at,
	review_status, COALESCE(reviewed_by, ''), reviewed_at, stale`
const suggestionColsSC = `sc.suggestion_id, sc.sentence_id, sc.user_id, sc.text, sc.created_at, sc.updated_at,
	sc.review_status, COALESCE(sc.reviewed_by, ''), sc.reviewed_at, sc.stale`

func scanSuggestion(row interface{ Scan(...any) error }, s *models.SuggestedChange) error {
	return row.Scan(&s.SuggestionID, &s.SentenceID, &s.UserID, &s.Text, &s.CreatedAt, &s.UpdatedAt,
		&s.ReviewStatus, &s.ReviewedBy, &s.ReviewedAt, &s.Stale)
}

// UpsertSuggestion stores text as-given; collapsing empty / original-equals-text
// into deletes is the caller's responsibility. Editing RESETS the review
// state and staleness — a changed suggestion is a new proposal against the
// current sentence (PERMISSIONS_PLAN §4).
func (db *DB) UpsertSuggestion(ctx context.Context, sentenceID, userID, text string) (*models.SuggestedChange, error) {
	query := `
		INSERT INTO suggested_change (sentence_id, user_id, text, created_at, updated_at)
		VALUES ($1, $2, $3, NOW(), NOW())
		ON CONFLICT (sentence_id, user_id) DO UPDATE
			SET text = EXCLUDED.text, updated_at = NOW(),
			    review_status = NULL, reviewed_by = NULL, reviewed_at = NULL,
			    stale = FALSE
		RETURNING ` + suggestionCols
	var s models.SuggestedChange
	if err := scanSuggestion(db.Pool.QueryRow(ctx, query, sentenceID, userID, text), &s); err != nil {
		return nil, fmt.Errorf("upsert suggestion: %w", err)
	}
	return &s, nil
}

// ErrCompetingAccepted: only ONE suggestion per sentence may be accepted
// (v3.2) — the reviewer must reject/clear the other first. Callers map to 409.
var ErrCompetingAccepted = errors.New("another suggestion on this sentence is already accepted")

// SetSuggestionReview sets/clears the review verdict. status nil clears.
// Accepting is exclusive per sentence: if a DIFFERENT user's suggestion is
// already accepted there, ErrCompetingAccepted (the push applies exactly
// the accepted set — no conflict resolution downstream). Returns false
// when no such suggestion exists.
func (db *DB) SetSuggestionReview(ctx context.Context, sentenceID, targetUser string, status *string, reviewer string) (bool, error) {
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		return false, fmt.Errorf("set suggestion review: begin: %w", err)
	}
	defer tx.Rollback(ctx)

	if status != nil && *status == models.ReviewAccepted {
		var competing bool
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS(
				SELECT 1 FROM suggested_change
				WHERE sentence_id = $1 AND user_id <> $2
				  AND review_status = 'accepted' FOR UPDATE
			)`, sentenceID, targetUser).Scan(&competing); err != nil {
			return false, fmt.Errorf("set suggestion review: competing check: %w", err)
		}
		if competing {
			return false, ErrCompetingAccepted
		}
	}

	tag, err := tx.Exec(ctx, `
		UPDATE suggested_change
		SET review_status = $3::varchar,
		    reviewed_by = CASE WHEN $3::varchar IS NULL THEN NULL ELSE $4 END,
		    reviewed_at = CASE WHEN $3::varchar IS NULL THEN NULL ELSE NOW() END
		WHERE sentence_id = $1 AND user_id = $2`,
		sentenceID, targetUser, status, reviewer)
	if err != nil {
		return false, fmt.Errorf("set suggestion review: %w", err)
	}
	// Verdicts (not clears) land in the append-only history, snapshotting
	// both texts so the event outlives migrations of the sentence.
	if tag.RowsAffected() > 0 && status != nil {
		if _, err := tx.Exec(ctx, `
			INSERT INTO suggestion_review_event
				(manuscript_id, sentence_id, owner_id, reviewer_id, status, committed_text, suggested_text)
			SELECT mg.manuscript_id, sc.sentence_id, sc.user_id, $3, $4, s.text, sc.text
			FROM suggested_change sc
			JOIN sentence s ON s.sentence_id = sc.sentence_id
			JOIN migration mg ON mg.migration_id = s.migration_id
			WHERE sc.sentence_id = $1 AND sc.user_id = $2`,
			sentenceID, targetUser, reviewer, *status); err != nil {
			return false, fmt.Errorf("set suggestion review: history event: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("set suggestion review: commit: %w", err)
	}
	return tag.RowsAffected() > 0, nil
}

// AcceptUncontested marks FRESH, unreviewed suggestions in this migration
// accepted — batch accepts are ALWAYS uncontested-only (a sentence with
// competing live suggestions needs a manual verdict). scope 'own' limits
// to the reviewer's suggestions; 'all' accepts any sentence whose single
// live suggestion is unreviewed, whoever wrote it. Returns the count.
func (db *DB) AcceptUncontested(ctx context.Context, migrationID int, reviewer, scope string) (int, error) {
	ownOnly := scope == "own"
	// The CTE both accepts and logs: every updated row becomes a history
	// event (same snapshot columns as the single-review path), so the
	// INSERT's row count is the accept count.
	tag, err := db.Pool.Exec(ctx, `
		WITH upd AS (
			UPDATE suggested_change sc
			SET review_status = 'accepted', reviewed_by = $2, reviewed_at = NOW()
			FROM sentence s
			WHERE s.sentence_id = sc.sentence_id
			  AND s.migration_id = $1
			  AND ($3::boolean = FALSE OR sc.user_id = $2)
			  AND sc.stale = FALSE
			  AND sc.review_status IS NULL
			  AND NOT EXISTS (
				SELECT 1 FROM suggested_change other
				WHERE other.sentence_id = sc.sentence_id
				  AND other.user_id <> sc.user_id
				  AND other.stale = FALSE
				  AND (other.review_status IS NULL OR other.review_status = 'accepted')
			  )
			RETURNING sc.sentence_id, sc.user_id, sc.text, s.text AS committed
		)
		INSERT INTO suggestion_review_event
			(manuscript_id, sentence_id, owner_id, reviewer_id, status, committed_text, suggested_text)
		SELECT mg.manuscript_id, u.sentence_id, u.user_id, $2, 'accepted', u.committed, u.text
		FROM upd u, migration mg
		WHERE mg.migration_id = $1`, migrationID, reviewer, ownOnly)
	if err != nil {
		return 0, fmt.Errorf("accept uncontested (%s): %w", scope, err)
	}
	return int(tag.RowsAffected()), nil
}

// GetAllSuggestionsForMigration: EVERY user's suggestions on the
// migration's sentences (multi-user view; the handler filters to own-only
// for callers without see-others-edits).
func (db *DB) GetAllSuggestionsForMigration(ctx context.Context, migrationID int) ([]models.SuggestedChange, error) {
	rows, err := db.Pool.Query(ctx, `
		SELECT `+suggestionColsSC+`
		FROM suggested_change sc
		JOIN sentence s ON s.sentence_id = sc.sentence_id
		WHERE s.migration_id = $1
		ORDER BY sc.sentence_id, sc.user_id`, migrationID)
	if err != nil {
		return nil, fmt.Errorf("get all suggestions for migration: %w", err)
	}
	defer rows.Close()
	var out []models.SuggestedChange
	for rows.Next() {
		var s models.SuggestedChange
		if err := scanSuggestion(rows, &s); err != nil {
			return nil, fmt.Errorf("scan suggestion: %w", err)
		}
		out = append(out, s)
	}
	return out, rows.Err()
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
		SELECT `+suggestionColsSC+`
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
		if err := scanSuggestion(rows, &s); err != nil {
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

// CarrySuggestionsForwardBulk copies every (from, to) pair's suggestions in
// ONE statement. v3 (PERMISSIONS_PLAN §4): the processor carries on EVERY
// pairing — fuzzy[i] marks pairings whose text changed, which arrive STALE
// (an already-stale suggestion stays stale even across an exact pairing).
// Review status rides along. Parallel slices; returns rows inserted.
func (db *DB) CarrySuggestionsForwardBulk(ctx context.Context, fromIDs, toIDs []string, fuzzy []bool) (int, error) {
	if len(fromIDs) == 0 {
		return 0, nil
	}
	tag, err := db.Pool.Exec(ctx, `
		INSERT INTO suggested_change (sentence_id, user_id, text, created_at, updated_at,
		                              review_status, reviewed_by, reviewed_at, stale)
		SELECT m.to_id, sc.user_id, sc.text, NOW(), NOW(),
		       sc.review_status, sc.reviewed_by, sc.reviewed_at, (sc.stale OR m.fuzzy)
		FROM unnest($1::text[], $2::text[], $3::boolean[]) AS m(from_id, to_id, fuzzy)
		JOIN suggested_change sc ON sc.sentence_id = m.from_id
		ON CONFLICT (sentence_id, user_id) DO NOTHING
	`, fromIDs, toIDs, fuzzy)
	if err != nil {
		return 0, fmt.Errorf("carry suggestions forward: %w", err)
	}
	return int(tag.RowsAffected()), nil
}

// GetSuggestionReviewEvents: newest-first history events the caller may
// see. seeAllIDs = manuscripts where the caller holds see-others-edits
// (every event shows); ownIDs = other memberships (only events the caller
// wrote or reviewed). The handler builds both sets from the caller's roles.
func (db *DB) GetSuggestionReviewEvents(ctx context.Context, seeAllIDs, ownIDs []int, username string, limit int) ([]models.SuggestionReviewEvent, error) {
	rows, err := db.Pool.Query(ctx, `
		SELECT event_id, manuscript_id, sentence_id, owner_id, reviewer_id,
		       status, committed_text, suggested_text, created_at
		FROM suggestion_review_event
		WHERE manuscript_id = ANY($1)
		   OR (manuscript_id = ANY($2) AND (owner_id = $3 OR reviewer_id = $3))
		ORDER BY event_id DESC
		LIMIT $4`, seeAllIDs, ownIDs, username, limit)
	if err != nil {
		return nil, fmt.Errorf("get suggestion review events: %w", err)
	}
	defer rows.Close()
	var out []models.SuggestionReviewEvent
	for rows.Next() {
		var e models.SuggestionReviewEvent
		if err := rows.Scan(&e.EventID, &e.ManuscriptID, &e.SentenceID, &e.OwnerID,
			&e.ReviewerID, &e.Status, &e.CommittedText, &e.SuggestedText, &e.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan suggestion review event: %w", err)
		}
		out = append(out, e)
	}
	return out, rows.Err()
}
