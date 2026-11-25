package database

// Note PLACEMENTS (NOTE_PLACEMENTS_PLAN.md): where a note appears is rows in
// note_sentence / note_scratchpad — a note can sit on several sentences, in
// several pads, or nowhere. Everything here is idempotent so the boot-time
// pad reconcile can run against whatever the previous container wrote.

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/slackwing/manuscript-studio/internal/fractional"
	"github.com/slackwing/manuscript-studio/internal/models"
)

// pgExecer is what the placement writers need from either a pool or a tx.
type pgExecer interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// insertSentencePlacement records that `noteID` sits on `sentenceID`, with the
// origin the note was created on. The position is the note's own (phase 1:
// one placement per note, the same stack order the margin shows today).
// ON CONFLICT: an existing row keeps its history; only the origin is filled
// in if it was unknown.
func insertSentencePlacement(ctx context.Context, q pgExecer, noteID int, sentenceID, position string,
	originSentenceID string, originMigrationID *int, originCommitHash, createdBy string) error {
	_, err := q.Exec(ctx, `
		INSERT INTO note_sentence (note_id, sentence_id, position, origin_sentence_id, origin_migration_id,
		                           origin_commit_hash, sentence_id_history, created_by)
		VALUES ($1, $2, $3, NULLIF($4, ''), $5, NULLIF($6, ''), '[]'::jsonb, $7)
		ON CONFLICT (note_id, sentence_id) DO UPDATE SET
			origin_sentence_id  = COALESCE(note_sentence.origin_sentence_id, EXCLUDED.origin_sentence_id),
			origin_migration_id = COALESCE(note_sentence.origin_migration_id, EXCLUDED.origin_migration_id),
			origin_commit_hash  = COALESCE(note_sentence.origin_commit_hash, EXCLUDED.origin_commit_hash)
	`, noteID, sentenceID, position, originSentenceID, originMigrationID, originCommitHash, createdBy)
	if err != nil {
		return fmt.Errorf("insert sentence placement: %w", err)
	}
	return nil
}

// repointSentencePlacement carries the placement (noteID, oldSentenceID) to
// newSentenceID with the carry's confidence, appending the new id to the
// placement's history — the per-placement form of what MigrateNotes wrote into
// note_version. Insert-then-delete rather than UPDATE so that two placements
// of one note whose sentences MERGE collapse into one row (the surviving row
// keeps the higher confidence). A placement row that never existed (drift
// from the dual-write window) is minted from the note itself.
func repointSentencePlacement(ctx context.Context, q pgExecer, noteID int, oldSentenceID, newSentenceID string, confidence float64) error {
	if oldSentenceID == newSentenceID {
		return nil
	}
	// Only a placement that EXISTS is carried: a note that isn't on the old
	// sentence (a pad or free note handed in by mistake) must never be
	// minted onto the new one.
	var exists bool
	if err := q.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM note_sentence WHERE note_id = $1 AND sentence_id = $2)`,
		noteID, oldSentenceID).Scan(&exists); err != nil {
		return fmt.Errorf("repoint: check placement: %w", err)
	}
	if !exists {
		return fmt.Errorf("note %d is not placed on sentence %q", noteID, oldSentenceID)
	}
	_, err := q.Exec(ctx, `
		INSERT INTO note_sentence (note_id, sentence_id, position, origin_sentence_id, origin_migration_id,
		                           origin_commit_hash, sentence_id_history, migration_confidence, created_at, created_by)
		SELECT n.note_id, $3::text,
		       old.position,
		       COALESCE(old.origin_sentence_id, v1.origin_sentence_id),
		       COALESCE(old.origin_migration_id, v1.origin_migration_id),
		       COALESCE(old.origin_commit_hash, v1.origin_commit_hash),
		       COALESCE(old.sentence_id_history, '[]'::jsonb) || to_jsonb($3::text),
		       $4::numeric,
		       COALESCE(old.created_at, n.created_at),
		       COALESCE(old.created_by, n.user_id)
		FROM note n
		LEFT JOIN note_sentence old ON old.note_id = n.note_id AND old.sentence_id = $2::text
		LEFT JOIN LATERAL (
			SELECT origin_sentence_id, origin_migration_id, origin_commit_hash
			FROM note_version v WHERE v.note_id = n.note_id ORDER BY v.version ASC LIMIT 1
		) v1 ON true
		WHERE n.note_id = $1
		ON CONFLICT (note_id, sentence_id) DO UPDATE SET
			migration_confidence = GREATEST(COALESCE(note_sentence.migration_confidence, 0), EXCLUDED.migration_confidence)
	`, noteID, oldSentenceID, newSentenceID, confidence)
	if err != nil {
		return fmt.Errorf("repoint sentence placement: %w", err)
	}
	if _, err := q.Exec(ctx, `DELETE FROM note_sentence WHERE note_id = $1 AND sentence_id = $2`, noteID, oldSentenceID); err != nil {
		return fmt.Errorf("retire old sentence placement: %w", err)
	}
	return nil
}

// insertScratchpadPlacement records that `noteID` appears in `scratchpadID`
// (re-opening a removed placement if the note comes back to the pad).
func insertScratchpadPlacement(ctx context.Context, q pgExecer, noteID, scratchpadID int) error {
	_, err := q.Exec(ctx, `
		INSERT INTO note_scratchpad (note_id, scratchpad_id)
		VALUES ($1, $2)
		ON CONFLICT (note_id, scratchpad_id) DO UPDATE SET removed_at = NULL
	`, noteID, scratchpadID)
	if err != nil {
		return fmt.Errorf("insert scratchpad placement: %w", err)
	}
	return nil
}

// SyncScratchpadPlacements makes note_scratchpad mirror a pad's doc: every
// noteRef the doc holds is a live placement; every live placement the doc no
// longer holds is closed (removed_at). Called after each pad save and from
// the boot reconcile. Unknown note ids in the doc are ignored (the FK would
// reject them; a dangling anchor is the pad's business, not the index's).
func (db *DB) SyncScratchpadPlacements(ctx context.Context, scratchpadID int, doc json.RawMessage) error {
	ids, err := noteIDsInDoc(doc)
	if err != nil {
		return err
	}
	return db.syncScratchpadPlacements(ctx, db.Pool, scratchpadID, ids)
}

func (db *DB) syncScratchpadPlacements(ctx context.Context, q pgExecer, scratchpadID int, ids []int) error {
	if ids == nil {
		ids = []int{}
	}
	if _, err := q.Exec(ctx, `
		INSERT INTO note_scratchpad (note_id, scratchpad_id)
		SELECT n.note_id, $1 FROM note n WHERE n.note_id = ANY($2)
		ON CONFLICT (note_id, scratchpad_id) DO UPDATE SET removed_at = NULL
			WHERE note_scratchpad.removed_at IS NOT NULL
	`, scratchpadID, ids); err != nil {
		return fmt.Errorf("sync scratchpad placements (open): %w", err)
	}
	if _, err := q.Exec(ctx, `
		UPDATE note_scratchpad SET removed_at = NOW()
		WHERE scratchpad_id = $1 AND removed_at IS NULL AND NOT (note_id = ANY($2))
	`, scratchpadID, ids); err != nil {
		return fmt.Errorf("sync scratchpad placements (close): %w", err)
	}
	return nil
}

// closeScratchpadPlacements closes every live placement in a pad (the pad was
// deleted). The notes themselves are untouched here.
func closeScratchpadPlacements(ctx context.Context, q pgExecer, scratchpadID int) error {
	_, err := q.Exec(ctx, `
		UPDATE note_scratchpad SET removed_at = NOW() WHERE scratchpad_id = $1 AND removed_at IS NULL
	`, scratchpadID)
	if err != nil {
		return fmt.Errorf("close scratchpad placements: %w", err)
	}
	return nil
}

// noteIDsInDoc walks a ProseMirror doc and collects the note ids of every
// noteRef atom ({"type":"noteRef","attrs":{"noteId":N,"text":"…"}}) and
// every noteBlock atom (the sticky note drawn as a block, NOTE_UI_PLAN.md —
// same attrs shape without the text). The
// pre-2026-08 shape (a noteAnchor node with a note_id attr) is read too, in
// case a client ever saves one unmodernized. Dedupes; order is doc order.
func noteIDsInDoc(doc json.RawMessage) ([]int, error) {
	var root map[string]any
	if err := json.Unmarshal(doc, &root); err != nil {
		return nil, fmt.Errorf("parse scratchpad doc: %w", err)
	}
	seen := map[int]bool{}
	var out []int
	var walk func(node map[string]any)
	walk = func(node map[string]any) {
		if node == nil {
			return
		}
		if t, _ := node["type"].(string); t == "noteRef" || t == "noteAnchor" || t == "noteBlock" {
			if attrs, ok := node["attrs"].(map[string]any); ok {
				id := 0
				if v, ok := attrs["noteId"].(float64); ok {
					id = int(v)
				} else if v, ok := attrs["note_id"].(float64); ok {
					id = int(v)
				}
				if id > 0 && !seen[id] {
					seen[id] = true
					out = append(out, id)
				}
			}
		}
		if content, ok := node["content"].([]any); ok {
			for _, c := range content {
				if child, ok := c.(map[string]any); ok {
					walk(child)
				}
			}
		}
	}
	walk(root)
	return out, nil
}

// ReconcileNotePlacements re-mirrors every live pad doc into note_scratchpad
// (the doc is the truth for pad placement). Idempotent; run at boot and by
// hand. Returns how many pads were synced.
func (db *DB) ReconcileNotePlacements(ctx context.Context) (pads int, err error) {
	rows, err := db.Pool.Query(ctx, `SELECT scratchpad_id, doc FROM scratchpad WHERE deleted_at IS NULL`)
	if err != nil {
		return 0, fmt.Errorf("reconcile: list pads: %w", err)
	}
	type padDoc struct {
		id  int
		doc []byte
	}
	var docs []padDoc
	for rows.Next() {
		var p padDoc
		if err := rows.Scan(&p.id, &p.doc); err != nil {
			rows.Close()
			return 0, fmt.Errorf("reconcile: scan pad: %w", err)
		}
		docs = append(docs, p)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	for _, p := range docs {
		ids, err := noteIDsInDoc(p.doc)
		if err != nil {
			continue // an unparseable doc is skipped, never fatal (BackfillVariationHomes does the same)
		}
		if err := db.syncScratchpadPlacements(ctx, db.Pool, p.id, ids); err != nil {
			return pads, err
		}
		pads++
	}
	return pads, nil
}

// ---------------------------------------------------------------------------
// Placements are the model (NOTE_PLACEMENTS_PLAN.md): the note row has no
// home columns; the "primary" placement — the earliest sentence a note was
// placed on — is only a convention for single-valued readers.

// CreateFreeNote creates a note placed NOWHERE: a plain thing the user owns,
// optionally about a manuscript (note.manuscript_id — the daily board, pins
// and points read it). Content version 1 has no sentence.
func (db *DB) CreateFreeNote(ctx context.Context, note *models.Note) error {
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback(ctx)
	if err := tx.QueryRow(ctx, `
		INSERT INTO note (user_id, color, body, priority, task_type, impact, blocked, manuscript_id)
		VALUES ($1, $2, $3, $4, NULLIF($5, ''), $6, $7, $8)
		RETURNING note_id, created_at, updated_at
	`, note.UserID, note.Color, note.Body, note.Priority, note.TaskType, note.Impact, note.Blocked, note.ManuscriptID,
	).Scan(&note.NoteID, &note.CreatedAt, &note.UpdatedAt); err != nil {
		return fmt.Errorf("failed to create free note: %w", err)
	}
	note.Position = ""
	if err := appendContentVersion(ctx, tx, note.NoteID, note, &models.NoteVersion{}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// AttachNoteToSentence places an existing note on a sentence: a new
// note_sentence row at the end of that sentence's stack, with its origin
// (sentence / migration / commit) recorded; the note's manuscript_id is
// stamped from the sentence when it had none; the legacy column follows the
// primary placement. Placing a note where it already is is a no-op.
func (db *DB) AttachNoteToSentence(ctx context.Context, noteID int, sentenceID string) error {
	createNoteMu.Lock() // the MAX(position) read-then-insert, same as CreateNote
	defer createNoteMu.Unlock()
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	var userID string
	if err := tx.QueryRow(ctx, `SELECT user_id FROM note WHERE note_id = $1 AND deleted_at IS NULL`, noteID).Scan(&userID); err != nil {
		return fmt.Errorf("attach: load note %d: %w", noteID, err)
	}
	var already bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM note_sentence WHERE note_id = $1 AND sentence_id = $2)`, noteID, sentenceID).Scan(&already); err != nil {
		return fmt.Errorf("attach: check placement: %w", err)
	}
	if already {
		return nil
	}
	var commitHash string
	var migrationID, manuscriptID int
	if err := tx.QueryRow(ctx, `
		SELECT s.commit_hash, s.migration_id, m.manuscript_id
		FROM sentence s JOIN migration m ON m.migration_id = s.migration_id WHERE s.sentence_id = $1
	`, sentenceID).Scan(&commitHash, &migrationID, &manuscriptID); err != nil {
		return fmt.Errorf("attach: load sentence %s: %w", sentenceID, err)
	}
	var maxPosition string
	if err := tx.QueryRow(ctx, `SELECT COALESCE(MAX(position), '') FROM note_sentence WHERE sentence_id = $1`, sentenceID).Scan(&maxPosition); err != nil {
		return fmt.Errorf("attach: max position: %w", err)
	}
	position, err := fractional.GeneratePositionBetween(maxPosition, "")
	if err != nil {
		return fmt.Errorf("attach: position after %q: %w", maxPosition, err)
	}
	if err := insertSentencePlacement(ctx, tx, noteID, sentenceID, position, sentenceID, &migrationID, commitHash, userID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE note SET manuscript_id = COALESCE(manuscript_id, $2), updated_at = NOW() WHERE note_id = $1`, noteID, manuscriptID); err != nil {
		return fmt.Errorf("attach: stamp manuscript: %w", err)
	}
	return tx.Commit(ctx)
}

// DetachNoteFromSentence removes one sentence placement. The note is left
// alone — on its other placements, or free. Returns false when the note
// wasn't placed there.
func (db *DB) DetachNoteFromSentence(ctx context.Context, noteID int, sentenceID string) (bool, error) {
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		return false, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback(ctx)
	tag, err := tx.Exec(ctx, `DELETE FROM note_sentence WHERE note_id = $1 AND sentence_id = $2`, noteID, sentenceID)
	if err != nil {
		return false, fmt.Errorf("detach: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return false, nil
	}
	if _, err := tx.Exec(ctx, `UPDATE note SET updated_at = NOW() WHERE note_id = $1`, noteID); err != nil {
		return false, fmt.Errorf("detach: touch note: %w", err)
	}
	return true, tx.Commit(ctx)
}

// SentencePlacement / ScratchpadPlacement: where a note is, for the API.
type SentencePlacement struct {
	SentenceID   string    `json:"sentence_id"`
	ManuscriptID int       `json:"manuscript_id"`
	MigrationID  int       `json:"migration_id"`
	Position     string    `json:"position"`
	CreatedAt    time.Time `json:"created_at"`
	// The note modal's placement cards (2026-11-25): the sentence's text
	// (the hover hint renders it like the book), whether it is in the
	// manuscript's current version, and the manuscript's display name
	// (filled by the handler from config).
	Text           string `json:"text"`
	Current        bool   `json:"current"`
	ManuscriptName string `json:"manuscript_name"`
}

type ScratchpadPlacement struct {
	ScratchpadID int    `json:"scratchpad_id"`
	Title        string `json:"title"`
	Live         bool   `json:"live"` // the pad doc still holds the anchor
	// Sketch (2026-11-25): a SKETCH note has no placement row of its own —
	// it lives with its sketch, whose variations sit in pads. Those pads are
	// listed as placements with this flag so the note modal can show them.
	Sketch bool `json:"sketch,omitempty"`
}

type NotePlacements struct {
	Sentences   []SentencePlacement   `json:"sentences"`
	Scratchpads []ScratchpadPlacement `json:"scratchpads"`
}

// GetNotePlacements lists a note's placements: sentence placements in the
// order they were made (the first is the primary), pads live-first (deleted
// pads omitted).
func (db *DB) GetNotePlacements(ctx context.Context, noteID int) (*NotePlacements, error) {
	out := &NotePlacements{Sentences: []SentencePlacement{}, Scratchpads: []ScratchpadPlacement{}}
	rows, err := db.Pool.Query(ctx, `
		SELECT ns.sentence_id, COALESCE(m.manuscript_id, 0), COALESCE(s.migration_id, 0), ns.position, ns.created_at,
		       COALESCE(s.text, ''),
		       COALESCE(s.migration_id = (SELECT max(mg2.migration_id) FROM migration mg2 WHERE mg2.manuscript_id = m.manuscript_id), false)
		FROM note_sentence ns
		LEFT JOIN sentence s ON s.sentence_id = ns.sentence_id
		LEFT JOIN migration m ON m.migration_id = s.migration_id
		WHERE ns.note_id = $1
		ORDER BY ns.created_at, ns.sentence_id
	`, noteID)
	if err != nil {
		return nil, fmt.Errorf("placements: sentences: %w", err)
	}
	for rows.Next() {
		var p SentencePlacement
		if err := rows.Scan(&p.SentenceID, &p.ManuscriptID, &p.MigrationID, &p.Position, &p.CreatedAt, &p.Text, &p.Current); err != nil {
			rows.Close()
			return nil, fmt.Errorf("placements: scan sentence: %w", err)
		}
		out.Sentences = append(out.Sentences, p)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows, err = db.Pool.Query(ctx, `
		SELECT p.scratchpad_id, sp.title, p.removed_at IS NULL
		FROM note_scratchpad p JOIN scratchpad sp ON sp.scratchpad_id = p.scratchpad_id AND sp.deleted_at IS NULL
		WHERE p.note_id = $1
		ORDER BY (p.removed_at IS NOT NULL), p.created_at
	`, noteID)
	if err != nil {
		return nil, fmt.Errorf("placements: scratchpads: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var p ScratchpadPlacement
		if err := rows.Scan(&p.ScratchpadID, &p.Title, &p.Live); err != nil {
			return nil, fmt.Errorf("placements: scan scratchpad: %w", err)
		}
		out.Scratchpads = append(out.Scratchpads, p)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// A sketch note's home(s): every live pad holding one of its sketch's
	// variations, earliest variation first; pads already listed are skipped.
	srows, err := db.Pool.Query(ctx, `
		SELECT DISTINCT ON (v.scratchpad_id) v.scratchpad_id, sp.title, v.variation_id
		FROM note n
		JOIN variation v ON v.sketch_id = n.sketch_id AND v.scratchpad_id IS NOT NULL
		JOIN scratchpad sp ON sp.scratchpad_id = v.scratchpad_id AND sp.deleted_at IS NULL
		WHERE n.note_id = $1 AND n.sketch_id IS NOT NULL
		  AND NOT EXISTS (SELECT 1 FROM note_scratchpad p WHERE p.note_id = n.note_id AND p.scratchpad_id = v.scratchpad_id)
		ORDER BY v.scratchpad_id, v.variation_id
	`, noteID)
	if err != nil {
		return nil, fmt.Errorf("placements: sketch pads: %w", err)
	}
	defer srows.Close()
	type sk struct {
		p   ScratchpadPlacement
		vid int
	}
	var sks []sk
	for srows.Next() {
		var s sk
		if err := srows.Scan(&s.p.ScratchpadID, &s.p.Title, &s.vid); err != nil {
			return nil, fmt.Errorf("placements: scan sketch pad: %w", err)
		}
		s.p.Live, s.p.Sketch = true, true
		sks = append(sks, s)
	}
	for i := 0; i < len(sks); i++ { // earliest variation first
		for j := i + 1; j < len(sks); j++ {
			if sks[j].vid < sks[i].vid {
				sks[i], sks[j] = sks[j], sks[i]
			}
		}
	}
	for _, s := range sks {
		out.Scratchpads = append(out.Scratchpads, s.p)
	}
	return out, srows.Err()
}

// ManuscriptIDsForNote: the manuscripts a note is placed in (via its
// sentence placements), primary first. Authorization reads this.
func (db *DB) ManuscriptIDsForNote(ctx context.Context, noteID int) ([]int, error) {
	rows, err := db.Pool.Query(ctx, `
		SELECT DISTINCT ON (m.manuscript_id) m.manuscript_id, min(ns.created_at) OVER (PARTITION BY m.manuscript_id) AS first_placed
		FROM note_sentence ns
		JOIN sentence s ON s.sentence_id = ns.sentence_id
		JOIN migration m ON m.migration_id = s.migration_id
		WHERE ns.note_id = $1
		ORDER BY m.manuscript_id, first_placed
	`, noteID)
	if err != nil {
		return nil, fmt.Errorf("manuscripts for note: %w", err)
	}
	defer rows.Close()
	type row struct {
		id    int
		first time.Time
	}
	var rs []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.id, &r.first); err != nil {
			return nil, err
		}
		rs = append(rs, r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	sort.Slice(rs, func(i, j int) bool { return rs[i].first.Before(rs[j].first) })
	out := make([]int, 0, len(rs))
	for _, r := range rs {
		out = append(out, r.id)
	}
	return out, nil
}
