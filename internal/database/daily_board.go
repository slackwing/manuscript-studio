package database

// The daily-tasks board as ONE function of (user, manuscript, instant) —
// the page, the points stamp and the points backfill all call it, so the
// three can never disagree about what was on the board (049).

import (
	"context"
	"fmt"
	"time"
)

// DailyBoardSize is the board's page size (4 × 4).
const DailyBoardSize = 16

// DailyBoard returns the board for the day containing asOf (in loc), AS OF
// that instant: pins first (pinned at or before asOf), then the day's
// date-seeded pick under the rules that existed then. Returns the day's
// seed (YYYY-MM-DD) too. Pins and rules are enhancements — a failure there
// degrades to "none" rather than failing the board.
func (db *DB) DailyBoard(ctx context.Context, username string, manuscriptID int, asOf time.Time, loc *time.Location) ([]HomeNote, string, error) {
	t := asOf.In(loc)
	dayStart := time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, loc)
	seed := dayStart.Format("2006-01-02")
	candidates, err := db.ListDailyTaskNotes(ctx, username, manuscriptID, seed, dayStart, asOf)
	if err != nil {
		return nil, seed, err
	}
	pinned, err := db.ListPinnedDailyNotes(ctx, username, manuscriptID, dayStart, asOf)
	if err != nil {
		pinned = nil
	}
	rules, err := db.ListDailyRulesAsOf(ctx, username, asOf)
	if err != nil {
		rules = nil
	}
	return ApplyDailyRules(rules, pinned, candidates, DailyBoardSize), seed, nil
}

// OnDailyBoard: was noteID on its manuscript's board at asOf?
func (db *DB) OnDailyBoard(ctx context.Context, username string, manuscriptID, noteID int, asOf time.Time, loc *time.Location) (bool, error) {
	board, _, err := db.DailyBoard(ctx, username, manuscriptID, asOf, loc)
	if err != nil {
		return false, err
	}
	for _, n := range board {
		if n.NoteID == noteID {
			return true, nil
		}
	}
	return false, nil
}

// BackfillPointDailyFlags classifies every point_event still NULL in
// from_daily (scored before 049) by rebuilding its board as of the event:
// the note's manuscript, its owner, its scored_at. username "" = every
// user (the startup pass); a name = that user's only (the points API's
// lazy pass). Idempotent — only NULL rows are touched. Best-effort history:
// created/deleted/completed timestamps are exact; task types and rule
// edits have no history (today's apply); pins carry only their latest time.
func (db *DB) BackfillPointDailyFlags(ctx context.Context, username string, loc *time.Location) (daily, other int, err error) {
	rows, err := db.Pool.Query(ctx, `
		SELECT pe.point_event_id, pe.note_id, n.user_id, n.manuscript_id, pe.scored_at
		FROM point_event pe
		JOIN note n ON n.note_id = pe.note_id
		WHERE pe.from_daily IS NULL
		  AND ($1 = '' OR n.user_id = $1)
		ORDER BY pe.scored_at
	`, username)
	if err != nil {
		return 0, 0, fmt.Errorf("backfill point flags: list: %w", err)
	}
	type ev struct {
		id, noteID int
		user       string
		ms         *int
		at         time.Time
	}
	var evs []ev
	for rows.Next() {
		var e ev
		if err := rows.Scan(&e.id, &e.noteID, &e.user, &e.ms, &e.at); err != nil {
			rows.Close()
			return 0, 0, fmt.Errorf("backfill point flags: scan: %w", err)
		}
		evs = append(evs, e)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, 0, err
	}
	for _, e := range evs {
		on := false
		if e.ms != nil {
			if on, err = db.OnDailyBoard(ctx, e.user, *e.ms, e.noteID, e.at, loc); err != nil {
				return daily, other, fmt.Errorf("backfill point flags: board for event %d: %w", e.id, err)
			}
		}
		if _, err := db.Pool.Exec(ctx, `UPDATE point_event SET from_daily = $2 WHERE point_event_id = $1 AND from_daily IS NULL`, e.id, on); err != nil {
			return daily, other, fmt.Errorf("backfill point flags: stamp %d: %w", e.id, err)
		}
		if on {
			daily++
		} else {
			other++
		}
	}
	return daily, other, nil
}

// HasUnclassifiedPoints: does the user have point events still NULL in
// from_daily (the points API backfills lazily when so)?
func (db *DB) HasUnclassifiedPoints(ctx context.Context, username string) (bool, error) {
	var any bool
	err := db.Pool.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM point_event pe JOIN note n ON n.note_id = pe.note_id
		               WHERE pe.from_daily IS NULL AND n.user_id = $1)
	`, username).Scan(&any)
	return any, err
}
