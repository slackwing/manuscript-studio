package database

import (
	"context"
	"fmt"
	"time"

	"github.com/slackwing/manuscript-studio/internal/sentence"
)

// WordcountRow is one day's wordcount for one manuscript, aggregated across
// ALL users (only authors can suggest or link snippets, so this is the
// combined progress of everyone writing toward the book).
type WordcountRow struct {
	ManuscriptID   int       `json:"manuscript_id"`
	Day            time.Time `json:"day"`
	WordsCommitted int       `json:"words_committed"`
	WordsEffective int       `json:"words_effective"`
	WordsSnippets  int       `json:"words_snippets"`
	ComputedAt     time.Time `json:"computed_at"`
}

// Total is the headline number: the effective book (committed with pending
// suggestions substituted in) plus linked, not-yet-canonized snippet words.
// A canonized snippet's text lives in the book as a suggestion, so it is
// counted by WordsEffective and excluded from WordsSnippets — never both.
func (r WordcountRow) Total() int { return r.WordsEffective + r.WordsSnippets }

// ComputeWordcountHistory computes today's row for every manuscript with a
// completed migration and upserts it (keyed by manuscript + day, so hourly
// runs overwrite today's row in place: fresh number, one row per day).
// "Today" is defined by loc — the configured wordcount_history.timezone —
// so the day cutoff lands where the author lives, not where the server does.
// Word counting matches the live count everywhere else: sentence.CountProseWords.
func (db *DB) ComputeWordcountHistory(ctx context.Context, loc *time.Location) ([]WordcountRow, error) {
	if loc == nil {
		loc = time.UTC
	}
	day := time.Now().In(loc).Format("2006-01-02")
	// Linked draft snippet words per manuscript (all users). Sibling
	// variations are alternatives of ONE passage, so each linked,
	// NON-canonized group contributes exactly one representative: its most
	// recently updated lettered variation (VARIATIONS_PLAN §6). Canonized
	// groups count via words_effective only — never both.
	snippetWords := map[int]int{}
	repRows, err := db.Pool.Query(ctx, `
		SELECT s.linked_manuscript_id, v.text
		FROM snippet s
		JOIN LATERAL (
			SELECT text FROM sketch
			WHERE snippet_id = s.snippet_id AND ordinal IS NOT NULL AND deleted_at IS NULL
			ORDER BY updated_at DESC LIMIT 1
		) v ON true
		WHERE s.linked_manuscript_id IS NOT NULL AND s.canon_sketch_id IS NULL
	`)
	if err != nil {
		return nil, fmt.Errorf("list linked snippet representatives: %w", err)
	}
	defer repRows.Close()
	for repRows.Next() {
		var mid int
		var text string
		if err := repRows.Scan(&mid, &text); err != nil {
			return nil, err
		}
		snippetWords[mid] += sentence.CountProseWords(text)
	}
	if err := repRows.Err(); err != nil {
		return nil, err
	}

	midRows, err := db.Pool.Query(ctx, `SELECT manuscript_id FROM manuscript ORDER BY manuscript_id`)
	if err != nil {
		return nil, fmt.Errorf("list manuscripts: %w", err)
	}
	defer midRows.Close()
	var mids []int
	for midRows.Next() {
		var id int
		if err := midRows.Scan(&id); err != nil {
			return nil, err
		}
		mids = append(mids, id)
	}
	if err := midRows.Err(); err != nil {
		return nil, err
	}

	var out []WordcountRow
	for _, mid := range mids {
		mig, err := db.GetLatestMigration(ctx, mid)
		if err != nil || mig == nil {
			continue // no completed migration yet — nothing to count
		}
		// Committed and effective in one pass: each sentence's latest
		// pending suggestion (across all users; most recently updated wins
		// when two users touched the same sentence) substitutes its text.
		rows, err := db.Pool.Query(ctx, `
			SELECT s.text, sug.text
			FROM sentence s
			LEFT JOIN LATERAL (
				SELECT sc.text FROM suggested_change sc
				WHERE sc.sentence_id = s.sentence_id
				ORDER BY sc.updated_at DESC LIMIT 1
			) sug ON true
			WHERE s.migration_id = $1
		`, mig.MigrationID)
		if err != nil {
			return nil, fmt.Errorf("scan sentences for manuscript %d: %w", mid, err)
		}
		committed, effective := 0, 0
		for rows.Next() {
			var text string
			var sug *string
			if err := rows.Scan(&text, &sug); err != nil {
				rows.Close()
				return nil, err
			}
			committed += sentence.CountProseWords(text)
			if sug != nil {
				effective += sentence.CountProseWords(*sug)
			} else {
				effective += sentence.CountProseWords(text)
			}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}

		row := WordcountRow{
			ManuscriptID:   mid,
			WordsCommitted: committed,
			WordsEffective: effective,
			WordsSnippets:  snippetWords[mid],
		}
		if err := db.Pool.QueryRow(ctx, `
			INSERT INTO wordcount_history (manuscript_id, day, words_committed, words_effective, words_snippets, computed_at)
			VALUES ($1, $5::date, $2, $3, $4, NOW())
			ON CONFLICT (manuscript_id, day) DO UPDATE SET
				words_committed = EXCLUDED.words_committed,
				words_effective = EXCLUDED.words_effective,
				words_snippets = EXCLUDED.words_snippets,
				computed_at = EXCLUDED.computed_at
			RETURNING day, computed_at
		`, mid, committed, effective, row.WordsSnippets, day).Scan(&row.Day, &row.ComputedAt); err != nil {
			return nil, fmt.Errorf("upsert wordcount for manuscript %d: %w", mid, err)
		}
		out = append(out, row)
	}
	return out, nil
}

// GetLatestWordcount returns the most recent history row for a manuscript,
// or nil if the cron has never produced one (caller falls back to the live
// count).
func (db *DB) GetLatestWordcount(ctx context.Context, manuscriptID int) (*WordcountRow, error) {
	var r WordcountRow
	err := db.Pool.QueryRow(ctx, `
		SELECT manuscript_id, day, words_committed, words_effective, words_snippets, computed_at
		FROM wordcount_history WHERE manuscript_id = $1
		ORDER BY day DESC LIMIT 1
	`, manuscriptID).Scan(&r.ManuscriptID, &r.Day, &r.WordsCommitted, &r.WordsEffective, &r.WordsSnippets, &r.ComputedAt)
	if err != nil {
		if err.Error() == "no rows in result set" {
			return nil, nil
		}
		return nil, err
	}
	return &r, nil
}

// ListWordcountHistory returns all history rows for a manuscript in day
// order — the wordcount-over-time graph's data.
func (db *DB) ListWordcountHistory(ctx context.Context, manuscriptID int) ([]WordcountRow, error) {
	rows, err := db.Pool.Query(ctx, `
		SELECT manuscript_id, day, words_committed, words_effective, words_snippets, computed_at
		FROM wordcount_history WHERE manuscript_id = $1
		ORDER BY day ASC
	`, manuscriptID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []WordcountRow{}
	for rows.Next() {
		var r WordcountRow
		if err := rows.Scan(&r.ManuscriptID, &r.Day, &r.WordsCommitted, &r.WordsEffective, &r.WordsSnippets, &r.ComputedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
