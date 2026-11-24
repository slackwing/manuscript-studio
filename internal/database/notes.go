package database

// Note + note_version rows: creates, versioned updates, migration repointing,
// reorder, lifecycle (split out of queries.go, 2026-08 — pure code motion).

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"

	"github.com/slackwing/manuscript-studio/internal/fractional"
	"github.com/slackwing/manuscript-studio/internal/models"

	"github.com/jackc/pgx/v5"
)

// noteColumns is THE canonical note column list (table aliased "a") — a
// single copy shared by every note reader so the shapes can't silently
// drift apart again (two of the five hand-copied lists had lost
// manuscript_id/scratchpad_id). Pairs with scanNote.
//
// NOTE_PLACEMENTS_PLAN.md phase 2: a note's sentence / position / scratchpad
// are PLACEMENTS (note_sentence, note_scratchpad) — the note row itself has
// no home columns since 057. Single-note readers get the PRIMARY placement
// — the earliest sentence placement, the earliest live pad — through these
// subselects; list readers that walk placements use placementColumns (one
// row per placement, that placement's sentence and position).
const noteColumns = `a.note_id,
	       COALESCE((SELECT ns.sentence_id FROM note_sentence ns WHERE ns.note_id = a.note_id ORDER BY ns.created_at, ns.sentence_id LIMIT 1), '') AS sentence_id,
	       a.manuscript_id,
	       (SELECT p.scratchpad_id FROM note_scratchpad p JOIN scratchpad sp ON sp.scratchpad_id = p.scratchpad_id AND sp.deleted_at IS NULL
	        WHERE p.note_id = a.note_id ORDER BY (p.removed_at IS NOT NULL), p.created_at LIMIT 1) AS scratchpad_id,
	       a.user_id, a.color, a.body, a.default_body,
	       a.priority, COALESCE(a.task_type, '') AS task_type, a.impact, a.blocked,
	       COALESCE((SELECT ns.position FROM note_sentence ns WHERE ns.note_id = a.note_id ORDER BY ns.created_at, ns.sentence_id LIMIT 1), '') AS position,
	       a.created_at, a.updated_at, a.deleted_at, a.completed_at, a.sketch_id, a.pinned_at`

// placementColumns: noteColumns for a query that JOINs note_sentence ns —
// the row IS one placement, so sentence_id and position are the row's.
const placementColumns = `a.note_id, ns.sentence_id AS sentence_id, a.manuscript_id,
	       (SELECT p.scratchpad_id FROM note_scratchpad p JOIN scratchpad sp ON sp.scratchpad_id = p.scratchpad_id AND sp.deleted_at IS NULL
	        WHERE p.note_id = a.note_id ORDER BY (p.removed_at IS NOT NULL), p.created_at LIMIT 1) AS scratchpad_id,
	       a.user_id, a.color, a.body, a.default_body,
	       a.priority, COALESCE(a.task_type, '') AS task_type, a.impact, a.blocked, ns.position AS position,
	       a.created_at, a.updated_at, a.deleted_at, a.completed_at, a.sketch_id, a.pinned_at`

// scanNote scans one noteColumns row (works for both QueryRow and Rows).
func scanNote(row pgx.Row) (models.Note, error) {
	var a models.Note
	err := row.Scan(
		&a.NoteID,
		&a.SentenceID,
		&a.ManuscriptID,
		&a.ScratchpadID,
		&a.UserID,
		&a.Color,
		&a.Body,
		&a.DefaultBody,
		&a.Priority,
		&a.TaskType,
		&a.Impact,
		&a.Blocked,
		&a.Position,
		&a.CreatedAt,
		&a.UpdatedAt,
		&a.DeletedAt,
		&a.CompletedAt,
		&a.SketchID,
		&a.PinnedAt,
	)
	return a, err
}

// scanNoteHidden: scanNote + the trailing viewer-relative hidden column.
func scanNoteHidden(row pgx.Row) (models.Note, error) {
	var a models.Note
	err := row.Scan(
		&a.NoteID,
		&a.SentenceID,
		&a.ManuscriptID,
		&a.ScratchpadID,
		&a.UserID,
		&a.Color,
		&a.Body,
		&a.DefaultBody,
		&a.Priority,
		&a.TaskType,
		&a.Impact,
		&a.Blocked,
		&a.Position,
		&a.CreatedAt,
		&a.UpdatedAt,
		&a.DeletedAt,
		&a.CompletedAt,
		&a.SketchID,
		&a.PinnedAt,
		&a.Hidden,
	)
	return a, err
}

func (db *DB) GetNotesByCommit(ctx context.Context, commitHash, username string) ([]models.Note, error) {
	// hidden (note_hide) is viewer-relative and applies to your OWN notes
	// too — the eye hides any note from your view (2026-10-18).
	// One row per PLACEMENT: a note on two of the commit's sentences ships
	// twice, each row carrying its own sentence_id and position, so the
	// margin's per-sentence filter needs no knowledge of placements.
	query := `
		SELECT ` + placementColumns + `,
		       EXISTS(SELECT 1 FROM note_hide h WHERE h.note_id = a.note_id AND h.username = $2) AS hidden
		FROM note a
		JOIN note_sentence ns ON ns.note_id = a.note_id
		JOIN sentence s ON s.sentence_id = ns.sentence_id
		WHERE s.commit_hash = $1
		  AND a.user_id = $2
		  AND a.deleted_at IS NULL
		  AND a.completed_at IS NULL
		ORDER BY s.ordinal, ns.position
	`

	rows, err := db.Pool.Query(ctx, query, commitHash, username)
	if err != nil {
		return nil, fmt.Errorf("failed to query notes by commit: %w", err)
	}
	defer rows.Close()

	var notes []models.Note
	for rows.Next() {
		a, err := scanNoteHidden(rows)
		if err != nil {
			return nil, fmt.Errorf("failed to scan note: %w", err)
		}
		notes = append(notes, a)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating notes: %w", err)
	}

	// Tags are needed for the in-memory note cache the frontend reads
	// per-sentence-click. Loading them here keeps clicks free of network
	// roundtrips. Per-note query — N+1 in shape, but the manuscript
	// has at most a few hundred notes and each tag list is tiny.
	for i := range notes {
		tags, err := db.GetTagsForNote(ctx, notes[i].NoteID)
		if err != nil {
			return nil, fmt.Errorf("failed to get tags for note %d: %w", notes[i].NoteID, err)
		}
		notes[i].Tags = tags
	}

	return notes, nil
}

// GetAllNotesByCommit is the multi-user twin of GetNotesByCommit (v3):
// EVERY user's active notes on the commit, with the viewer-relative Hidden
// flag from note_hide. Hidden notes still ship — the frontend dims and
// demotes them rather than losing them.
func (db *DB) GetAllNotesByCommit(ctx context.Context, commitHash, viewer string) ([]models.Note, error) {
	query := `
		SELECT ` + placementColumns + `,
		       EXISTS(SELECT 1 FROM note_hide h WHERE h.note_id = a.note_id AND h.username = $2) AS hidden
		FROM note a
		JOIN note_sentence ns ON ns.note_id = a.note_id
		JOIN sentence s ON s.sentence_id = ns.sentence_id
		WHERE s.commit_hash = $1
		  AND a.deleted_at IS NULL
		  AND a.completed_at IS NULL
		ORDER BY s.ordinal, ns.position
	`
	rows, err := db.Pool.Query(ctx, query, commitHash, viewer)
	if err != nil {
		return nil, fmt.Errorf("failed to query all notes by commit: %w", err)
	}
	defer rows.Close()
	var notes []models.Note
	for rows.Next() {
		a, err := scanNoteHidden(rows)
		if err != nil {
			return nil, fmt.Errorf("failed to scan note: %w", err)
		}
		notes = append(notes, a)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating notes: %w", err)
	}
	for i := range notes {
		tags, err := db.GetTagsForNote(ctx, notes[i].NoteID)
		if err != nil {
			return nil, fmt.Errorf("failed to get tags for note %d: %w", notes[i].NoteID, err)
		}
		notes[i].Tags = tags
	}
	return notes, nil
}

// GetAllNotesBySentence: every user's active notes on one sentence, with
// the viewer-relative Hidden flag.
func (db *DB) GetAllNotesBySentence(ctx context.Context, sentenceID, viewer string) ([]models.Note, error) {
	query := `
		SELECT ` + placementColumns + `,
		       EXISTS(SELECT 1 FROM note_hide h WHERE h.note_id = a.note_id AND h.username = $2) AS hidden
		FROM note a
		JOIN note_sentence ns ON ns.note_id = a.note_id AND ns.sentence_id = $1
		WHERE a.deleted_at IS NULL
		  AND a.completed_at IS NULL
		ORDER BY ns.position
	`
	rows, err := db.Pool.Query(ctx, query, sentenceID, viewer)
	if err != nil {
		return nil, fmt.Errorf("failed to query all notes by sentence: %w", err)
	}
	defer rows.Close()
	var notes []models.Note
	for rows.Next() {
		a, err := scanNoteHidden(rows)
		if err != nil {
			return nil, fmt.Errorf("failed to scan note: %w", err)
		}
		notes = append(notes, a)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating notes: %w", err)
	}
	for i := range notes {
		tags, err := db.GetTagsForNote(ctx, notes[i].NoteID)
		if err != nil {
			return nil, fmt.Errorf("failed to get tags for note %d: %w", notes[i].NoteID, err)
		}
		notes[i].Tags = tags
	}
	return notes, nil
}

// HideNote / UnhideNote: per-viewer, reversible, owner-invisible (v3).
func (db *DB) HideNote(ctx context.Context, username string, noteID int) error {
	_, err := db.Pool.Exec(ctx, `
		INSERT INTO note_hide (username, note_id) VALUES ($1, $2)
		ON CONFLICT DO NOTHING`, username, noteID)
	if err != nil {
		return fmt.Errorf("hide note: %w", err)
	}
	return nil
}

func (db *DB) UnhideNote(ctx context.Context, username string, noteID int) error {
	_, err := db.Pool.Exec(ctx,
		`DELETE FROM note_hide WHERE username = $1 AND note_id = $2`, username, noteID)
	if err != nil {
		return fmt.Errorf("unhide note: %w", err)
	}
	return nil
}

func insertNoteVersion(ctx context.Context, tx pgx.Tx, version *models.NoteVersion, historyJSON []byte) error {
	query := `
		INSERT INTO note_version (
			note_id, version, sentence_id, color, body, priority, flagged,
			migration_confidence, origin_sentence_id, origin_migration_id, origin_commit_hash,
			sentence_id_history, created_by
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
		RETURNING created_at
	`
	// "" sentence / origin → NULL (056: a free, pad or sketch note's content
	// version has no sentence).
	return tx.QueryRow(ctx, query,
		version.NoteID,
		version.Version,
		nullIfEmpty(version.SentenceID),
		version.Color,
		version.Body,
		version.Priority,
		version.Flagged,
		version.MigrationConfidence,
		nullIfEmpty(version.OriginSentenceID),
		version.OriginMigrationID,
		nullIfEmpty(version.OriginCommitHash),
		historyJSON,
		version.CreatedBy,
	).Scan(&version.CreatedAt)
}

func nullIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func (db *DB) GetNotesBySentence(ctx context.Context, sentenceID, username string) ([]models.Note, error) {
	query := `
		SELECT ` + placementColumns + `
		FROM note a
		JOIN note_sentence ns ON ns.note_id = a.note_id AND ns.sentence_id = $1
		WHERE a.user_id = $2
		  AND a.deleted_at IS NULL
		  AND a.completed_at IS NULL
		ORDER BY ns.position
	`

	rows, err := db.Pool.Query(ctx, query, sentenceID, username)
	if err != nil {
		return nil, fmt.Errorf("failed to query notes by sentence: %w", err)
	}
	defer rows.Close()

	notes := []models.Note{} // non-nil so JSON encodes [] not null

	for rows.Next() {
		a, err := scanNote(rows)
		if err != nil {
			return nil, fmt.Errorf("failed to scan note: %w", err)
		}

		tags, err := db.GetTagsForNote(ctx, a.NoteID)
		if err != nil {
			return nil, fmt.Errorf("failed to get tags for note %d: %w", a.NoteID, err)
		}
		a.Tags = tags

		notes = append(notes, a)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating notes: %w", err)
	}

	return notes, nil
}

// createNoteMu serializes position assignment across concurrent
// creates: MAX(position) + increment is not atomic, and the schema has no
// unique constraint on (sentence_id, position) to catch a duplicate.
// Single-instance server, so a process-level mutex is sufficient.
var createNoteMu sync.Mutex

// CreateNote writes the note and its first version row.
func (db *DB) CreateNote(ctx context.Context, note *models.Note, version *models.NoteVersion) error {
	createNoteMu.Lock()
	defer createNoteMu.Unlock()

	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	// Append after the current max via the fractional indexer —
	// ReorderNote writes extended-precision / carried-prefix positions
	// (e.g. "a00015", "b0000") that a fixed "a%04d" parse would misread and
	// collide with.
	var maxPosition string
	queryMaxPos := `SELECT COALESCE(MAX(position), '') FROM note_sentence WHERE sentence_id = $1`
	if err := tx.QueryRow(ctx, queryMaxPos, note.SentenceID).Scan(&maxPosition); err != nil {
		return fmt.Errorf("failed to get max position: %w", err)
	}

	nextPosition, err := fractional.GeneratePositionBetween(maxPosition, "")
	if err != nil {
		return fmt.Errorf("failed to compute next position after %q: %w", maxPosition, err)
	}

	// The note row carries no home (phase 4): its sentence and position are
	// the note_sentence row written below.
	query1 := `
		INSERT INTO note (user_id, color, body, priority, task_type, impact, blocked)
		VALUES ($1, $2, $3, $4, NULLIF($5, ''), $6, $7)
		RETURNING note_id, created_at, updated_at
	`
	err = tx.QueryRow(ctx, query1,
		note.UserID,
		note.Color,
		note.Body,
		note.Priority,
		note.TaskType,
		note.Impact,
		note.Blocked,
	).Scan(
		&note.NoteID,
		&note.CreatedAt,
		&note.UpdatedAt,
	)
	if err != nil {
		return fmt.Errorf("failed to create note: %w", err)
	}

	note.Position = nextPosition

	// Sentence's commit_hash and migration_id become the note's origin.
	var commitHash string
	var migrationID int
	query_commit := `SELECT commit_hash, migration_id FROM sentence WHERE sentence_id = $1 LIMIT 1`
	if err := tx.QueryRow(ctx, query_commit, note.SentenceID).Scan(&commitHash, &migrationID); err != nil {
		return fmt.Errorf("failed to get commit hash and migration_id for sentence: %w", err)
	}

	// Also stamp the note's manuscript_id (from its sentence's migration) so the
	// landing Notes grid can show/link context WITHOUT a runtime join — the same
	// value migration 019 backfilled for pre-existing sentence notes. Without
	// this, new sentence notes show "no context" and can't open their manuscript.
	// The stamp is part of the note's identity (home cards depend on it), so a
	// lookup failure fails the whole create — never a silent skip.
	var manuscriptID int
	if err := tx.QueryRow(ctx,
		`SELECT manuscript_id FROM migration WHERE migration_id = $1`, migrationID,
	).Scan(&manuscriptID); err != nil {
		return fmt.Errorf("failed to resolve manuscript for note stamp: %w", err)
	}
	if _, err := tx.Exec(ctx,
		`UPDATE note SET manuscript_id = $1 WHERE note_id = $2`, manuscriptID, note.NoteID,
	); err != nil {
		return fmt.Errorf("failed to set note manuscript_id: %w", err)
	}
	note.ManuscriptID = &manuscriptID

	historyJSON, _ := json.Marshal([]string{})

	version.NoteID = note.NoteID
	version.Version = 1
	version.SentenceID = note.SentenceID
	version.Color = note.Color
	version.Body = note.Body
	version.Priority = note.Priority
	version.Flagged = false // note.flagged is gone (031); the version column is legacy
	version.OriginSentenceID = note.SentenceID
	version.OriginMigrationID = &migrationID
	version.OriginCommitHash = commitHash
	version.CreatedBy = note.UserID

	if err := insertNoteVersion(ctx, tx, version, historyJSON); err != nil {
		return fmt.Errorf("failed to create note version: %w", err)
	}

	// The placement (NOTE_PLACEMENTS_PLAN.md): where this note is.
	if err := insertSentencePlacement(ctx, tx, note.NoteID, note.SentenceID, nextPosition,
		note.SentenceID, &migrationID, commitHash, note.UserID); err != nil {
		return err
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("failed to commit transaction: %w", err)
	}

	return nil
}

// CreateScratchpadNote creates a note placed in a scratchpad (NOTES_PLAN.md
// Phase 2 / NOTE_PLACEMENTS_PLAN.md): the note row plus its note_scratchpad
// placement and content version 1 (no sentence). manuscript_id is set only
// if note.ManuscriptID is non-nil (inherited from a linked pad).
func (db *DB) CreateScratchpadNote(ctx context.Context, note *models.Note, scratchpadID int) error {
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback(ctx)
	// A pad's order is its doc's order — a pad note has no position.
	err = tx.QueryRow(ctx, `
		INSERT INTO note (user_id, color, body, priority, task_type, impact, blocked, manuscript_id)
		VALUES ($1, $2, $3, $4, NULLIF($5, ''), $6, $7, $8)
		RETURNING note_id, created_at, updated_at
	`,
		note.UserID, note.Color, note.Body, note.Priority, note.TaskType, note.Impact, note.Blocked, note.ManuscriptID,
	).Scan(&note.NoteID, &note.CreatedAt, &note.UpdatedAt)
	if err != nil {
		return fmt.Errorf("failed to create scratchpad note: %w", err)
	}
	// The placement (NOTE_PLACEMENTS_PLAN.md): which pad holds it.
	if err := insertScratchpadPlacement(ctx, tx, note.NoteID, scratchpadID); err != nil {
		return err
	}
	// Content version 1: every note is versioned; a pad note's version simply
	// has no sentence.
	if err := appendContentVersion(ctx, tx, note.NoteID, note, &models.NoteVersion{}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("failed to commit transaction: %w", err)
	}
	note.Position = ""
	note.ScratchpadID = &scratchpadID
	return nil
}

// UpdateNote mutates the head row and appends a new version.
func (db *DB) UpdateNote(ctx context.Context, noteID int, note *models.Note, version *models.NoteVersion) error {
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	// Placements own where a note sits — an edit never touches them (the
	// legacy sentence_id column is left exactly as it was).
	query1 := `
		UPDATE note
		SET color = $1, body = $2, priority = $3, task_type = NULLIF($4, ''), impact = $5, blocked = $6, updated_at = NOW()
		WHERE note_id = $7 AND deleted_at IS NULL
		RETURNING updated_at
	`
	err = tx.QueryRow(ctx, query1,
		note.Color,
		note.Body,
		note.Priority,
		note.TaskType,
		note.Impact,
		note.Blocked,
		noteID,
	).Scan(&note.UpdatedAt)
	if err != nil {
		return fmt.Errorf("failed to update note: %w", err)
	}

	// CONTENT version (phase 2): one per edit, for every kind of note. The
	// sentence stamped on it is informational (the primary placement, if
	// any); lineage lives on note_sentence now.
	if err := appendContentVersion(ctx, tx, noteID, note, version); err != nil {
		return err
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("failed to commit transaction: %w", err)
	}

	return nil
}

// appendContentVersion writes note_version max+1 as a snapshot of the note's
// content: color / body / priority, the primary placement's sentence (NULL
// for a free, pad or sketch note), the origin carried from version 1 when
// there is one, and the latest version's history carried through unchanged.
// A note that predates versioning for its kind (pad / sketch notes made
// before phase 2 have no version 1) simply starts at version 1 here.
func appendContentVersion(ctx context.Context, tx pgx.Tx, noteID int, note *models.Note, version *models.NoteVersion) error {
	var (
		maxVersion                   int
		primarySentence              *string
		originSentence, originCommit *string
		originMigration              *int
		createdBy                    *string
		history                      []byte
	)
	if err := tx.QueryRow(ctx, `
		SELECT COALESCE(MAX(v.version), 0),
		       (SELECT ns.sentence_id FROM note_sentence ns WHERE ns.note_id = $1 ORDER BY ns.created_at, ns.sentence_id LIMIT 1),
		       (SELECT v1.origin_sentence_id FROM note_version v1 WHERE v1.note_id = $1 ORDER BY v1.version ASC LIMIT 1),
		       (SELECT v1.origin_commit_hash FROM note_version v1 WHERE v1.note_id = $1 ORDER BY v1.version ASC LIMIT 1),
		       (SELECT v1.origin_migration_id FROM note_version v1 WHERE v1.note_id = $1 ORDER BY v1.version ASC LIMIT 1),
		       (SELECT v1.created_by FROM note_version v1 WHERE v1.note_id = $1 ORDER BY v1.version ASC LIMIT 1),
		       (SELECT vl.sentence_id_history FROM note_version vl WHERE vl.note_id = $1 ORDER BY vl.version DESC LIMIT 1)
		FROM note_version v WHERE v.note_id = $1
	`, noteID).Scan(&maxVersion, &primarySentence, &originSentence, &originCommit, &originMigration, &createdBy, &history); err != nil {
		return fmt.Errorf("failed to read version context: %w", err)
	}
	if len(history) == 0 {
		history = []byte("[]")
	}
	version.NoteID = noteID
	version.Version = maxVersion + 1
	version.Color = note.Color
	version.Body = note.Body
	version.Priority = note.Priority
	version.Flagged = false // note.flagged is gone (031); the version column is legacy
	version.MigrationConfidence = nil
	if primarySentence != nil {
		version.SentenceID = *primarySentence
	}
	if originSentence != nil {
		version.OriginSentenceID = *originSentence
	}
	if originCommit != nil {
		version.OriginCommitHash = *originCommit
	}
	version.OriginMigrationID = originMigration
	if createdBy != nil {
		version.CreatedBy = *createdBy
	} else {
		version.CreatedBy = note.UserID
	}
	if err := insertNoteVersion(ctx, tx, version, history); err != nil {
		return fmt.Errorf("failed to create note version: %w", err)
	}
	return nil
}

// NoteMigrationItem: one PLACEMENT to carry — note `NoteID` on
// `OldSentenceID` moves to `NewSentenceID` with the matcher's confidence.
type NoteMigrationItem struct {
	NoteID        int
	OldSentenceID string
	NewSentenceID string
	Confidence    float64
}

// MigrateNotes carries placements across a migration, all-or-nothing: error
// means zero rows committed. Phase 2 (NOTE_PLACEMENTS_PLAN.md): the unit is
// the note_sentence row — repointed with its history and confidence
// (repointSentencePlacement; two placements of one note that land on the
// same sentence merge) — and note_version is not written here (it is
// content history).
func (db *DB) MigrateNotes(ctx context.Context, items []NoteMigrationItem) (int, error) {
	if len(items) == 0 {
		return 0, nil
	}

	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	for _, item := range items {
		var active bool
		if err := tx.QueryRow(ctx,
			`SELECT deleted_at IS NULL AND completed_at IS NULL FROM note WHERE note_id = $1`, item.NoteID,
		).Scan(&active); err != nil {
			// Hard fail so the whole migration rolls back rather than desyncing placements.
			return 0, fmt.Errorf("note %d: not found: %w", item.NoteID, err)
		}
		if !active {
			return 0, fmt.Errorf("note %d: deleted or completed since it was gathered", item.NoteID)
		}
		if err := repointSentencePlacement(ctx, tx, item.NoteID, item.OldSentenceID, item.NewSentenceID, item.Confidence); err != nil {
			return 0, fmt.Errorf("note %d: %w", item.NoteID, err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("commit migration: %w", err)
	}
	return len(items), nil
}

func (db *DB) SoftDeleteNote(ctx context.Context, noteID int) error {
	query := `
		UPDATE note
		SET deleted_at = NOW()
		WHERE note_id = $1
		  AND deleted_at IS NULL
	`
	result, err := db.Pool.Exec(ctx, query, noteID)
	if err != nil {
		return fmt.Errorf("failed to soft delete note: %w", err)
	}

	rowsAffected := result.RowsAffected()
	if rowsAffected == 0 {
		return fmt.Errorf("note not found or already deleted")
	}

	return nil
}

// ScorePoints records one point_event on a note (027). The handler gates
// on task-ness (priority) and 1–99; this just writes the event.
func (db *DB) ScorePoints(ctx context.Context, noteID, points int, fromDaily bool) error {
	_, err := db.Pool.Exec(ctx, `
		INSERT INTO point_event (note_id, points, from_daily) VALUES ($1, $2, $3)
	`, noteID, points, fromDaily)
	if err != nil {
		return fmt.Errorf("score points on note %d: %w", noteID, err)
	}
	return nil
}

// SetNotePinned pins (pinned_at = now) or unpins (NULL) a note on its
// manuscript's daily-tasks board. Not a content edit — no note_version row,
// updated_at untouched (the landing's "recent" order is about writing).
func (db *DB) SetNotePinned(ctx context.Context, noteID int, pinned bool) error {
	_, err := db.Pool.Exec(ctx, `
		UPDATE note
		SET pinned_at = CASE WHEN $2 THEN NOW() ELSE NULL END
		WHERE note_id = $1 AND deleted_at IS NULL
	`, noteID, pinned)
	if err != nil {
		return fmt.Errorf("set note %d pinned=%v: %w", noteID, pinned, err)
	}
	return nil
}

// CompleteNote stamps completed_at. Points are NOT part of completion —
// they're independent point_event rows (ScorePoints).
func (db *DB) CompleteNote(ctx context.Context, noteID int) error {
	query := `
		UPDATE note
		SET completed_at = NOW()
		WHERE note_id = $1
		  AND deleted_at IS NULL
		  AND completed_at IS NULL
	`
	result, err := db.Pool.Exec(ctx, query, noteID)
	if err != nil {
		return fmt.Errorf("failed to complete note: %w", err)
	}

	rowsAffected := result.RowsAffected()
	if rowsAffected == 0 {
		return fmt.Errorf("note not found or already completed")
	}

	return nil
}

func (db *DB) GetLatestNoteVersion(ctx context.Context, noteID int) (*models.NoteVersion, error) {
	// 056: a content version of a free / pad / sketch note has no sentence —
	// NULLs read back as "" (the model's "none" value).
	query := `
		SELECT
			note_id, version, COALESCE(sentence_id, ''), color, body, priority, flagged,
			sentence_id_history, migration_confidence,
			COALESCE(origin_sentence_id, ''), origin_migration_id, COALESCE(origin_commit_hash, ''), created_at, created_by
		FROM note_version
		WHERE note_id = $1
		ORDER BY version DESC
		LIMIT 1
	`

	var av models.NoteVersion
	var historyJSON []byte

	err := db.Pool.QueryRow(ctx, query, noteID).Scan(
		&av.NoteID,
		&av.Version,
		&av.SentenceID,
		&av.Color,
		&av.Body,
		&av.Priority,
		&av.Flagged,
		&historyJSON,
		&av.MigrationConfidence,
		&av.OriginSentenceID,
		&av.OriginMigrationID,
		&av.OriginCommitHash,
		&av.CreatedAt,
		&av.CreatedBy,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to get note version: %w", err)
	}

	if err := json.Unmarshal(historyJSON, &av.SentenceIDHistory); err != nil {
		return nil, fmt.Errorf("failed to unmarshal history: %w", err)
	}

	return &av, nil
}

// GetActiveNotesForSentences: GetActiveNotesForSentence over a whole ID set
// in ONE query — the migration processor asks about every mapped old
// sentence, and a round-trip per sentence made note collection scale with
// manuscript size instead of note count.
func (db *DB) GetActiveNotesForSentences(ctx context.Context, sentenceIDs []string) (map[string][]models.Note, error) {
	byID := make(map[string][]models.Note)
	if len(sentenceIDs) == 0 {
		return byID, nil
	}
	// One row per PLACEMENT on the asked-for sentences; the bucket key (and
	// a.SentenceID) is the placement's sentence, so a note placed on two of
	// them shows up in both buckets and each placement is carried on its own.
	rows, err := db.Pool.Query(ctx, `
		SELECT `+placementColumns+`
		FROM note a
		JOIN note_sentence ns ON ns.note_id = a.note_id
		WHERE ns.sentence_id = ANY($1)
		  AND a.deleted_at IS NULL
		  AND a.completed_at IS NULL
	`, sentenceIDs)
	if err != nil {
		return nil, fmt.Errorf("failed to query notes: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		a, err := scanNote(rows)
		if err != nil {
			return nil, fmt.Errorf("failed to scan note: %w", err)
		}
		byID[a.SentenceID] = append(byID[a.SentenceID], a)
	}
	// A connection drop mid-iteration would otherwise return a PARTIAL map as
	// success — the migration processor would silently strand missing notes.
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating notes: %w", err)
	}
	return byID, nil
}

func (db *DB) GetActiveNotesForSentence(ctx context.Context, sentenceID string) ([]models.Note, error) {
	query := `
		SELECT ` + placementColumns + `
		FROM note a
		JOIN note_sentence ns ON ns.note_id = a.note_id AND ns.sentence_id = $1
		WHERE a.deleted_at IS NULL
		  AND a.completed_at IS NULL
	`

	rows, err := db.Pool.Query(ctx, query, sentenceID)
	if err != nil {
		return nil, fmt.Errorf("failed to query notes: %w", err)
	}
	defer rows.Close()

	var notes []models.Note
	for rows.Next() {
		a, err := scanNote(rows)
		if err != nil {
			return nil, fmt.Errorf("failed to scan note: %w", err)
		}
		notes = append(notes, a)
	}

	// A connection drop mid-iteration would otherwise return a PARTIAL list
	// as success — the migration processor would silently strand the missing
	// notes on old sentences.
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating notes: %w", err)
	}

	return notes, nil
}

// ReorderNote assigns a fractional-index position for the target slot.
// The sentence and owner are derived from the note row itself (never from
// the request body), and the slot positions are computed over the OWNER's
// active notes on that sentence only — the same user-scoped list every
// visible note list shows.
//
// Phase 2: the slot is within ONE placement's stack — `sentenceID` names it;
// "" means the note's primary placement.
func (db *DB) ReorderNote(ctx context.Context, noteID int, sentenceID string, newIndex int) error {
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	var userID string
	if err := tx.QueryRow(ctx,
		`SELECT user_id FROM note WHERE note_id = $1 AND deleted_at IS NULL AND completed_at IS NULL`,
		noteID,
	).Scan(&userID); err != nil {
		return fmt.Errorf("failed to load note for reorder: %w", err)
	}
	if sentenceID == "" {
		var primary *string
		if err := tx.QueryRow(ctx,
			`SELECT sentence_id FROM note_sentence WHERE note_id = $1 ORDER BY created_at, sentence_id LIMIT 1`, noteID,
		).Scan(&primary); err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("failed to load placement for reorder: %w", err)
		}
		if primary == nil {
			return fmt.Errorf("note %d has no sentence to reorder within", noteID)
		}
		sentenceID = *primary
	}

	query := `
		SELECT ns.position FROM note_sentence ns JOIN note n ON n.note_id = ns.note_id
		WHERE ns.sentence_id = $1 AND n.user_id = $2 AND n.deleted_at IS NULL AND n.completed_at IS NULL
		ORDER BY ns.position`
	rows, err := tx.Query(ctx, query, sentenceID, userID)
	if err != nil {
		return fmt.Errorf("failed to query positions: %w", err)
	}
	defer rows.Close()

	var positions []string
	for rows.Next() {
		var pos string
		if err := rows.Scan(&pos); err != nil {
			return fmt.Errorf("failed to scan position: %w", err)
		}
		positions = append(positions, pos)
	}

	if err := rows.Err(); err != nil {
		return fmt.Errorf("error iterating positions: %w", err)
	}

	newPosition, err := fractional.GetPositionAtIndex(positions, newIndex)
	if err != nil {
		return fmt.Errorf("failed to calculate new position: %w", err)
	}

	tag, err := tx.Exec(ctx,
		`UPDATE note_sentence SET position = $1 WHERE note_id = $2 AND sentence_id = $3`,
		newPosition, noteID, sentenceID)
	if err != nil {
		return fmt.Errorf("failed to update placement position: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("note %d is not placed on sentence %s", noteID, sentenceID)
	}
	if _, err := tx.Exec(ctx, `UPDATE note SET updated_at = NOW() WHERE note_id = $1`, noteID); err != nil {
		return fmt.Errorf("failed to touch note: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("failed to commit transaction: %w", err)
	}

	return nil
}

func (db *DB) GetNoteByID(ctx context.Context, noteID int) (*models.Note, error) {
	query := `
		SELECT ` + noteColumns + `
		FROM note a
		WHERE a.note_id = $1
		  AND a.deleted_at IS NULL
		  AND a.completed_at IS NULL
	`

	a, err := scanNote(db.Pool.QueryRow(ctx, query, noteID))
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get note: %w", err)
	}

	return &a, nil
}

// SetNoteManuscript links (or, with manuscriptID nil, unlinks) a note to a
// manuscript. Only the manuscript_id context column changes — the note's
// sentence/scratchpad context is untouched. Ownership/access is enforced by the
// handler before this runs.
func (db *DB) SetNoteManuscript(ctx context.Context, noteID int, manuscriptID *int) error {
	_, err := db.Pool.Exec(ctx,
		`UPDATE note SET manuscript_id = $1, updated_at = NOW() WHERE note_id = $2`,
		manuscriptID, noteID)
	if err != nil {
		return fmt.Errorf("failed to set note manuscript: %w", err)
	}
	return nil
}

// GetManuscriptIDForCommit resolves the manuscript a commit's migration
// belongs to (0 = unknown). Used by the multi-user notes read path.
func (db *DB) GetManuscriptIDForCommit(ctx context.Context, commitHash string) (int, error) {
	var mid int
	err := db.Pool.QueryRow(ctx,
		`SELECT manuscript_id FROM migration WHERE commit_hash = $1 ORDER BY migration_id DESC LIMIT 1`,
		commitHash).Scan(&mid)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("manuscript for commit: %w", err)
	}
	return mid, nil
}
