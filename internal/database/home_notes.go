package database

// HomeNote readers: the landing grid and the daily-tasks page (split out of
// queries.go, 2026-08 — pure code motion).

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/slackwing/manuscript-studio/internal/models"
)

// HomeNote is a note plus a display context, for the landing grid.
type HomeNote struct {
	NoteID          int
	Color           string
	Body            *string
	Priority        string
	TaskType        string
	Impact          string
	Blocked         bool
	UpdatedAt       time.Time
	ManuscriptID    *int
	ScratchpadID    *int
	SentenceID      string
	Context         string // fallback manuscript label (repo basename etc.); the handler prefers the config name
	ScratchpadTitle string // the scratchpad title, if the note lives on one — shown alongside the manuscript
	// Set for a sketch note (026): its card context shows "Sketch", not a
	// pad title — a sketch's variations can live across multiple pads.
	SketchID *string
	Tags     []models.Tag
	// DoneToday: the daily-tasks page's "already worked" marker — points
	// were awarded to this note today. Only ListDailyTaskNotes sets it.
	DoneToday bool
}

// homeNoteSelect is the shared column list of the two home-note readers
// (ListNotesForHome, ListDailyTaskNotes) — one copy so they can't drift
// (they had ~35 lines duplicated verbatim). Pairs with homeNoteFrom.
const homeNoteSelect = `
		SELECT n.note_id, n.color, n.body, n.priority, COALESCE(n.task_type, '') AS task_type, n.impact, n.blocked, n.updated_at,
		       n.manuscript_id,
		       -- A sketch note has no pad of its own — its card deep-links
		       -- to the sketch's HOME pad (earliest variation's scratchpad).
		       COALESCE(n.scratchpad_id,
		           (SELECT sk.scratchpad_id FROM variation sk
		            WHERE sk.sketch_id = n.sketch_id AND sk.scratchpad_id IS NOT NULL
		            ORDER BY sk.variation_id LIMIT 1)),
		       COALESCE(n.sentence_id, ''),
		       -- Fallback manuscript label (used only when the note has a
		       -- manuscript_id but the handler can't resolve a config name):
		       -- display_name, else the repo folder name (minus a trailing .git).
		       COALESCE(
		           NULLIF(m.display_name, ''),
		           NULLIF(regexp_replace(regexp_replace(m.repo_path, '\.git/?$', ''), '^.*/', ''), ''),
		           ''
		       ) AS context,
		       COALESCE(sp.title, '') AS scratchpad_title,
		       n.sketch_id,
		       -- Tags for the card (read-only chips). Aggregated here to avoid an
		       -- N+1 per note; empty array when none.
		       COALESCE(
		           (SELECT json_agg(json_build_object('tag_id', t.tag_id, 'tag_name', t.tag_name) ORDER BY t.tag_name)
		            FROM note_tag nt JOIN tag t ON t.tag_id = nt.tag_id
		            WHERE nt.note_id = n.note_id),
		           '[]'::json
		       ) AS tags`

const homeNoteFrom = `
		FROM note n
		LEFT JOIN scratchpad sp ON sp.scratchpad_id = n.scratchpad_id
		LEFT JOIN manuscript  m ON m.manuscript_id  = n.manuscript_id`

// ListNotesForHome returns a user's most-recently-touched active notes with a
// display context. Scratchpad notes show the scratchpad title; manuscript/
// sentence notes show the manuscript's display name (falls back to name).
func (db *DB) ListNotesForHome(ctx context.Context, username string, limit int) ([]HomeNote, error) {
	rows, err := db.Pool.Query(ctx, homeNoteSelect+homeNoteFrom+`
		WHERE n.user_id = $1
		  AND n.deleted_at IS NULL
		  AND n.completed_at IS NULL
		ORDER BY n.updated_at DESC
		LIMIT $2
	`, username, limit)
	if err != nil {
		return nil, fmt.Errorf("list notes for home: %w", err)
	}
	defer rows.Close()
	var out []HomeNote
	for rows.Next() {
		var h HomeNote
		var tagsJSON []byte
		if err := rows.Scan(&h.NoteID, &h.Color, &h.Body, &h.Priority, &h.TaskType, &h.Impact, &h.Blocked, &h.UpdatedAt,
			&h.ManuscriptID, &h.ScratchpadID, &h.SentenceID, &h.Context, &h.ScratchpadTitle, &h.SketchID, &tagsJSON); err != nil {
			return nil, fmt.Errorf("scan home note: %w", err)
		}
		if len(tagsJSON) > 0 {
			_ = json.Unmarshal(tagsJSON, &h.Tags) // best-effort; tags are decorative
		}
		out = append(out, h)
	}
	return out, rows.Err()
}

// ListDailyTaskNotes: the daily-tasks page's deterministic "random" pick of
// a manuscript's live TASK notes. Determinism: rows created before dayStart
// (today's midnight in the configured timezone) ordered by md5(note_id ||
// seed) — same date + same data → same set. DoneToday marks notes that got
// points awarded since dayStart (already worked today).
// Returns ALL eligible candidates in the deterministic order — the caller
// applies the daily rules (ApplyDailyRules) and cuts to the page size.
func (db *DB) ListDailyTaskNotes(ctx context.Context, username string, manuscriptID int, seed string, dayStart time.Time) ([]HomeNote, error) {
	rows, err := db.Pool.Query(ctx, homeNoteSelect+`,
		       (EXISTS(
		           SELECT 1 FROM point_event pe
		           WHERE pe.note_id = n.note_id AND pe.deleted_at IS NULL AND pe.scored_at >= $4
		       ) OR (n.completed_at IS NOT NULL AND n.completed_at >= $4)) AS done_today`+homeNoteFrom+`
		WHERE n.user_id = $1
		  AND n.deleted_at IS NULL
		  -- Completed tasks stay on TODAY'S page (the satisfaction of the
		  -- checkmark); they leave tomorrow.
		  AND (n.completed_at IS NULL OR n.completed_at >= $4)
		  AND n.manuscript_id = $2
		  AND n.created_at < $4
		  AND EXISTS (SELECT 1 FROM task_type tt WHERE tt.name = n.task_type AND tt.is_task)
		ORDER BY md5(n.note_id::text || $3)
	`, username, manuscriptID, seed, dayStart)
	if err != nil {
		return nil, fmt.Errorf("list daily task notes: %w", err)
	}
	defer rows.Close()
	var out []HomeNote
	for rows.Next() {
		var h HomeNote
		var tagsJSON []byte
		if err := rows.Scan(&h.NoteID, &h.Color, &h.Body, &h.Priority, &h.TaskType, &h.Impact, &h.Blocked, &h.UpdatedAt,
			&h.ManuscriptID, &h.ScratchpadID, &h.SentenceID, &h.Context, &h.ScratchpadTitle, &h.SketchID, &tagsJSON, &h.DoneToday); err != nil {
			return nil, fmt.Errorf("scan daily task note: %w", err)
		}
		if len(tagsJSON) > 0 {
			_ = json.Unmarshal(tagsJSON, &h.Tags)
		}
		out = append(out, h)
	}
	return out, rows.Err()
}
