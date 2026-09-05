package database

import (
	"context"
	"fmt"
	"math"
	"time"

	"github.com/slackwing/manuscript-studio/internal/sentence"
)

// THE COUNTING RULES LIVE IN WORDCOUNT_RULES.md (repo root) — read it
// before touching any counting logic here; the two change together.
//
// WordcountRow is one day's wordcount for one manuscript, aggregated across
// ALL users (only authors can suggest or link sketches, so this is the
// combined progress of everyone writing toward the book). The rate columns
// (024-wordcount-rates) are that day's writing pace as computed ON that
// day — nil while the manuscript has no birthday.
type WordcountRow struct {
	ManuscriptID   int        `json:"manuscript_id"`
	Day            time.Time  `json:"day"`
	WordsCommitted int        `json:"words_committed"`
	WordsEffective int        `json:"words_effective"`
	WordsSketches  int        `json:"words_sketches"`
	ComputedAt     time.Time  `json:"computed_at"`
	RateAverage    *float64   `json:"rate_average"`
	RatePast30d    *float64   `json:"rate_past_30d"`
	ProjectedEnd   *time.Time `json:"projected_end"`
}

// Total is the headline number: the effective book (committed with pending
// suggestions substituted in) plus linked, not-yet-canonized sketch words.
// A canonized sketch's text lives in the book as a suggestion, so it is
// counted by WordsEffective and excluded from WordsSketches — never both.
func (r WordcountRow) Total() int { return r.WordsEffective + r.WordsSketches }

// ComputeRates derives each day's rate columns from the totals history —
// the same math the stats pane uses live, frozen per day:
//   rate_average  = total ÷ days since birthday (floor 1)
//   rate_past_30d = slope across the recorded rows in the trailing 30 days
//                   (the average stands in when the window has no slope)
//   projected_end = day + (goal − total) ÷ rate_average, only while the
//                   goal is ahead and the pace is positive
// Pure: rows must be day-ascending; a nil birthday yields no rates.
func ComputeRates(rows []WordcountRow, birthday *time.Time, goal int) []WordcountRow {
	out := make([]WordcountRow, len(rows))
	copy(out, rows)
	if birthday == nil {
		return out
	}
	for i := range out {
		day := out[i].Day
		total := float64(out[i].Total())
		days := day.Sub(*birthday).Hours() / 24
		if days < 1 {
			days = 1
		}
		avg := total / days
		trend := avg
		winStart := day.AddDate(0, 0, -30)
		j := 0
		for j <= i && out[j].Day.Before(winStart) {
			j++
		}
		if j < i {
			span := out[i].Day.Sub(out[j].Day).Hours() / 24
			if span >= 1 {
				trend = (total - float64(out[j].Total())) / span
			}
		}
		avgCopy, trendCopy := avg, trend
		out[i].RateAverage = &avgCopy
		out[i].RatePast30d = &trendCopy
		out[i].ProjectedEnd = nil
		if avg > 0 && total < float64(goal) {
			end := day.AddDate(0, 0, int(math.Ceil((float64(goal)-total)/avg)))
			out[i].ProjectedEnd = &end
		}
	}
	return out
}

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
	// Linked draft sketch words per manuscript (all users). Sibling
	// variations are alternatives of ONE passage, so each linked,
	// NON-canonized group contributes exactly one representative: its most
	// recently updated lettered variation (VARIATIONS_PLAN §6). Superseded
	// variations are never the representative — "canonized wins, then most
	// recent non-superseded". Canonized
	// groups count via words_effective only — never both.
	sketchWords := map[int]int{}
	repRows, err := db.Pool.Query(ctx, `
		SELECT s.linked_manuscript_id, v.text
		FROM sketch s
		JOIN LATERAL (
			SELECT text FROM variation
			WHERE sketch_id = s.sketch_id AND ordinal IS NOT NULL AND deleted_at IS NULL
			  AND state <> 'superseded'
			ORDER BY updated_at DESC LIMIT 1
		) v ON true
		WHERE s.linked_manuscript_id IS NOT NULL AND s.canon_variation_id IS NULL
	`)
	if err != nil {
		return nil, fmt.Errorf("list linked sketch representatives: %w", err)
	}
	defer repRows.Close()
	for repRows.Next() {
		var mid int
		var text string
		if err := repRows.Scan(&mid, &text); err != nil {
			return nil, err
		}
		sketchWords[mid] += sentence.CountProseWords(text)
	}
	if err := repRows.Err(); err != nil {
		return nil, err
	}

	midRows, err := db.Pool.Query(ctx, `SELECT manuscript_id, birthday, word_goal FROM manuscript ORDER BY manuscript_id`)
	if err != nil {
		return nil, fmt.Errorf("list manuscripts: %w", err)
	}
	defer midRows.Close()
	type msMeta struct {
		id       int
		birthday *time.Time
		goal     int
	}
	var metas []msMeta
	for midRows.Next() {
		var m msMeta
		if err := midRows.Scan(&m.id, &m.birthday, &m.goal); err != nil {
			return nil, err
		}
		metas = append(metas, m)
	}
	if err := midRows.Err(); err != nil {
		return nil, err
	}

	var out []WordcountRow
	for _, meta := range metas {
		mid := meta.id
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
			WordsSketches:  sketchWords[mid],
		}
		if err := db.Pool.QueryRow(ctx, `
			INSERT INTO wordcount_history (manuscript_id, day, words_committed, words_effective, words_sketches, computed_at)
			VALUES ($1, $5::date, $2, $3, $4, NOW())
			ON CONFLICT (manuscript_id, day) DO UPDATE SET
				words_committed = EXCLUDED.words_committed,
				words_effective = EXCLUDED.words_effective,
				words_sketches = EXCLUDED.words_sketches,
				computed_at = EXCLUDED.computed_at
			RETURNING day, computed_at
		`, mid, committed, effective, row.WordsSketches, day).Scan(&row.Day, &row.ComputedAt); err != nil {
			return nil, fmt.Errorf("upsert wordcount for manuscript %d: %w", mid, err)
		}
		// Rates: recompute TODAY's row every run (last write of the day
		// sticks); fill a historical row only while its rates are NULL —
		// which is also the one-time backfill after 024 deploys. Past days
		// stay frozen at whatever goal/birthday was current back then.
		hist, err := db.ListWordcountHistory(ctx, mid)
		if err != nil {
			return nil, fmt.Errorf("list history for rates %d: %w", mid, err)
		}
		rated := ComputeRates(hist, meta.birthday, meta.goal)
		for i := range rated {
			isToday := rated[i].Day.Format("2006-01-02") == day
			if hist[i].RateAverage != nil && !isToday {
				continue
			}
			if rated[i].RateAverage == nil && hist[i].RateAverage == nil {
				continue // nothing to write (no birthday)
			}
			if _, err := db.Pool.Exec(ctx, `
				UPDATE wordcount_history
				SET rate_average = $3, rate_past_30d = $4, projected_end = $5
				WHERE manuscript_id = $1 AND day = $2
			`, mid, rated[i].Day, rated[i].RateAverage, rated[i].RatePast30d, rated[i].ProjectedEnd); err != nil {
				return nil, fmt.Errorf("update rates for manuscript %d day %s: %w", mid, rated[i].Day.Format("2006-01-02"), err)
			}
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
		SELECT manuscript_id, day, words_committed, words_effective, words_sketches, computed_at, rate_average, rate_past_30d, projected_end
		FROM wordcount_history WHERE manuscript_id = $1
		ORDER BY day DESC LIMIT 1
	`, manuscriptID).Scan(&r.ManuscriptID, &r.Day, &r.WordsCommitted, &r.WordsEffective, &r.WordsSketches, &r.ComputedAt, &r.RateAverage, &r.RatePast30d, &r.ProjectedEnd)
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
		SELECT manuscript_id, day, words_committed, words_effective, words_sketches, computed_at, rate_average, rate_past_30d, projected_end
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
		if err := rows.Scan(&r.ManuscriptID, &r.Day, &r.WordsCommitted, &r.WordsEffective, &r.WordsSketches, &r.ComputedAt, &r.RateAverage, &r.RatePast30d, &r.ProjectedEnd); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
