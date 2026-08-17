package database

// Note actions: point events, restore/uncomplete undo, the settings audit
// table and the points grid (split out of queries.go, 2026-08 — pure code
// motion).

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

// NoteAction: one row of the settings page's "Note actions" audit table —
// points awarded, note (soft-)deleted, or note completed.
type NoteAction struct {
	Kind    string    `json:"kind"` // 'points' | 'deleted' | 'completed'
	At      time.Time `json:"at"`
	NoteID  int       `json:"note_id"`
	EventID *int      `json:"event_id,omitempty"` // point_event_id, points rows only
	Points  *int      `json:"points,omitempty"`
	Color   string    `json:"color"`
	Body    string    `json:"body"` // clamped server-side; preview only
}

// ListNoteActions: the user's newest note actions across all three sources.
func (db *DB) ListNoteActions(ctx context.Context, username string, limit int) ([]NoteAction, error) {
	rows, err := db.Pool.Query(ctx, `
		SELECT kind, at, note_id, event_id, points, color, body FROM (
			SELECT 'points' AS kind, pe.scored_at AS at, n.note_id,
			       pe.point_event_id AS event_id, pe.points, n.color,
			       LEFT(COALESCE(n.body, ''), 300) AS body
			  FROM point_event pe JOIN note n ON n.note_id = pe.note_id
			 WHERE n.user_id = $1 AND pe.deleted_at IS NULL
			UNION ALL
			SELECT 'deleted', n.deleted_at, n.note_id, NULL, NULL, n.color,
			       LEFT(COALESCE(n.body, ''), 300)
			  FROM note n WHERE n.user_id = $1 AND n.deleted_at IS NOT NULL
			UNION ALL
			SELECT 'completed', n.completed_at, n.note_id, NULL, NULL, n.color,
			       LEFT(COALESCE(n.body, ''), 300)
			  FROM note n WHERE n.user_id = $1 AND n.completed_at IS NOT NULL
		) x ORDER BY at DESC LIMIT $2
	`, username, limit)
	if err != nil {
		return nil, fmt.Errorf("list note actions: %w", err)
	}
	defer rows.Close()
	out := []NoteAction{}
	for rows.Next() {
		var a NoteAction
		if err := rows.Scan(&a.Kind, &a.At, &a.NoteID, &a.EventID, &a.Points, &a.Color, &a.Body); err != nil {
			return nil, fmt.Errorf("scan note action: %w", err)
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// DeletePointEvent HARD-deletes one point event (the "unaward" undo — the
// award never happened). Ownership via the event's note. false = no such
// event owned by this user.
func (db *DB) DeletePointEvent(ctx context.Context, eventID int, username string) (bool, error) {
	tag, err := db.Pool.Exec(ctx, `
		DELETE FROM point_event pe USING note n
		WHERE pe.point_event_id = $1 AND n.note_id = pe.note_id AND n.user_id = $2
	`, eventID, username)
	if err != nil {
		return false, fmt.Errorf("delete point event %d: %w", eventID, err)
	}
	return tag.RowsAffected() > 0, nil
}

// UpdatePointEvent edits an award's value in place (the settings table's
// inline "edit N points"). Ownership via the event's note. false = no such
// event owned by this user.
func (db *DB) UpdatePointEvent(ctx context.Context, eventID int, username string, points int) (bool, error) {
	tag, err := db.Pool.Exec(ctx, `
		UPDATE point_event pe SET points = $3
		FROM note n
		WHERE pe.point_event_id = $1 AND n.note_id = pe.note_id AND n.user_id = $2
	`, eventID, username, points)
	if err != nil {
		return false, fmt.Errorf("update point event %d: %w", eventID, err)
	}
	return tag.RowsAffected() > 0, nil
}

// RestoreNote undoes a soft delete. false = no such deleted note owned by
// this user.
func (db *DB) RestoreNote(ctx context.Context, noteID int, username string) (bool, error) {
	tag, err := db.Pool.Exec(ctx, `
		UPDATE note SET deleted_at = NULL, updated_at = NOW()
		WHERE note_id = $1 AND user_id = $2 AND deleted_at IS NOT NULL
	`, noteID, username)
	if err != nil {
		return false, fmt.Errorf("restore note %d: %w", noteID, err)
	}
	return tag.RowsAffected() > 0, nil
}

// UncompleteNote undoes a completion. false = no such completed note owned
// by this user.
func (db *DB) UncompleteNote(ctx context.Context, noteID int, username string) (bool, error) {
	tag, err := db.Pool.Exec(ctx, `
		UPDATE note SET completed_at = NULL, updated_at = NOW()
		WHERE note_id = $1 AND user_id = $2 AND completed_at IS NOT NULL
	`, noteID, username)
	if err != nil {
		return false, fmt.Errorf("uncomplete note %d: %w", noteID, err)
	}
	return tag.RowsAffected() > 0, nil
}

// DailyPoints: one row per day (in the caller's timezone) with the user's
// summed live point events — the landing page's points grid.
type DailyPoints struct {
	Date   string `json:"date"` // YYYY-MM-DD in the configured timezone
	Points int    `json:"points"`
}

// ListDailyPoints returns the user's ENTIRE per-day points history, oldest
// first. The full history (not a window) is intentional: the grid's
// bulldozer overflow cascades left-to-right from the very first day, so a
// huge day far in the past can still spill into the visible window.
func (db *DB) ListDailyPoints(ctx context.Context, username string, tz string) ([]DailyPoints, error) {
	rows, err := db.Pool.Query(ctx, `
		SELECT to_char(pe.scored_at AT TIME ZONE $2, 'YYYY-MM-DD') AS day, SUM(pe.points)::int
		FROM point_event pe
		JOIN note n ON n.note_id = pe.note_id
		WHERE n.user_id = $1 AND pe.deleted_at IS NULL
		GROUP BY 1 ORDER BY 1
	`, username, tz)
	if err != nil {
		return nil, fmt.Errorf("list daily points: %w", err)
	}
	defer rows.Close()
	out := []DailyPoints{}
	for rows.Next() {
		var d DailyPoints
		if err := rows.Scan(&d.Date, &d.Points); err != nil {
			return nil, fmt.Errorf("scan daily points: %w", err)
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// SetNoteActionDate moves one audit-table action to another DAY (settings
// page date edit — e.g. assigning points to yesterday). The action's
// time-of-day in tz is preserved; only the date part changes. kind picks
// the column: 'points' → point_event.scored_at (id = point_event_id),
// 'deleted' → note.deleted_at, 'completed' → note.completed_at (id =
// note_id). false = no such action owned by this user.
func (db *DB) SetNoteActionDate(ctx context.Context, username, kind string, id int, date, tz string) (bool, error) {
	var tag pgconn.CommandTag
	var err error
	// ((date || ' ' || old time-of-day in tz)::timestamp AT TIME ZONE tz):
	// a naive local timestamp on the new date, converted back to an instant.
	switch kind {
	case "points":
		tag, err = db.Pool.Exec(ctx, `
			UPDATE point_event pe
			SET scored_at = (($3 || ' ' || to_char(pe.scored_at AT TIME ZONE $4, 'HH24:MI:SS'))::timestamp AT TIME ZONE $4)
			FROM note n
			WHERE pe.point_event_id = $1 AND n.note_id = pe.note_id AND n.user_id = $2 AND pe.deleted_at IS NULL
		`, id, username, date, tz)
	case "deleted":
		tag, err = db.Pool.Exec(ctx, `
			UPDATE note
			SET deleted_at = (($3 || ' ' || to_char(deleted_at AT TIME ZONE $4, 'HH24:MI:SS'))::timestamp AT TIME ZONE $4)
			WHERE note_id = $1 AND user_id = $2 AND deleted_at IS NOT NULL
		`, id, username, date, tz)
	case "completed":
		tag, err = db.Pool.Exec(ctx, `
			UPDATE note
			SET completed_at = (($3 || ' ' || to_char(completed_at AT TIME ZONE $4, 'HH24:MI:SS'))::timestamp AT TIME ZONE $4)
			WHERE note_id = $1 AND user_id = $2 AND completed_at IS NOT NULL
		`, id, username, date, tz)
	default:
		return false, fmt.Errorf("invalid action kind %q", kind)
	}
	if err != nil {
		return false, fmt.Errorf("set %s action date: %w", kind, err)
	}
	return tag.RowsAffected() > 0, nil
}
