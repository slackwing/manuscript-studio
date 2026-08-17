package database

// Note + note_version rows: creates, versioned updates, migration repointing,
// reorder, lifecycle (split out of queries.go, 2026-08 — pure code motion).

import (
	"context"
	"encoding/json"
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
const noteColumns = `a.note_id, COALESCE(a.sentence_id, '') AS sentence_id, a.manuscript_id, a.scratchpad_id, a.user_id, a.color, a.body,
	       a.priority, COALESCE(a.task_type, '') AS task_type, a.impact, a.blocked, a.position, a.created_at, a.updated_at, a.deleted_at, a.completed_at, a.sketch_id`

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
	)
	return a, err
}

func (db *DB) GetNotesByCommit(ctx context.Context, commitHash, username string) ([]models.Note, error) {
	query := `
		SELECT ` + noteColumns + `
		FROM note a
		JOIN sentence s ON a.sentence_id = s.sentence_id
		WHERE s.commit_hash = $1
		  AND a.user_id = $2
		  AND a.deleted_at IS NULL
		  AND a.completed_at IS NULL
		ORDER BY s.ordinal, a.position
	`

	rows, err := db.Pool.Query(ctx, query, commitHash, username)
	if err != nil {
		return nil, fmt.Errorf("failed to query notes by commit: %w", err)
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

func getNoteOriginInfo(ctx context.Context, tx pgx.Tx, noteID int) (originSentenceID, originCommitHash, createdBy string, originMigrationID *int, err error) {
	query := `
		SELECT
			MIN(origin_sentence_id),
			MIN(origin_migration_id),
			MIN(origin_commit_hash),
			MIN(created_by)
		FROM note_version
		WHERE note_id = $1
	`
	err = tx.QueryRow(ctx, query, noteID).Scan(&originSentenceID, &originMigrationID, &originCommitHash, &createdBy)
	return
}

// Read sentence_id_history from the given version and append newSentenceID.
func getSentenceHistory(ctx context.Context, tx pgx.Tx, noteID int, version int, newSentenceID string) ([]byte, error) {
	query := `
		SELECT sentence_id_history
		FROM note_version
		WHERE note_id = $1 AND version = $2
	`
	var historyJSON []byte
	if err := tx.QueryRow(ctx, query, noteID, version).Scan(&historyJSON); err != nil {
		return nil, fmt.Errorf("failed to get sentence history: %w", err)
	}

	var history []string
	if len(historyJSON) > 0 {
		// A corrupt history row must surface, not be silently replaced by a
		// fresh one-element chain — that would destroy the audit trail.
		if err := json.Unmarshal(historyJSON, &history); err != nil {
			return nil, fmt.Errorf("corrupt sentence_id_history for note %d version %d: %w", noteID, version, err)
		}
	}
	history = append(history, newSentenceID)
	newHistoryJSON, err := json.Marshal(history)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal sentence history: %w", err)
	}
	return newHistoryJSON, nil
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
	return tx.QueryRow(ctx, query,
		version.NoteID,
		version.Version,
		version.SentenceID,
		version.Color,
		version.Body,
		version.Priority,
		version.Flagged,
		version.MigrationConfidence,
		version.OriginSentenceID,
		version.OriginMigrationID,
		version.OriginCommitHash,
		historyJSON,
		version.CreatedBy,
	).Scan(&version.CreatedAt)
}

func (db *DB) GetNotesBySentence(ctx context.Context, sentenceID, username string) ([]models.Note, error) {
	query := `
		SELECT ` + noteColumns + `
		FROM note a
		WHERE a.sentence_id = $1
		  AND a.user_id = $2
		  AND a.deleted_at IS NULL
		  AND a.completed_at IS NULL
		ORDER BY a.position
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
	queryMaxPos := `SELECT COALESCE(MAX(position), '') FROM note WHERE sentence_id = $1`
	if err := tx.QueryRow(ctx, queryMaxPos, note.SentenceID).Scan(&maxPosition); err != nil {
		return fmt.Errorf("failed to get max position: %w", err)
	}

	nextPosition, err := fractional.GeneratePositionBetween(maxPosition, "")
	if err != nil {
		return fmt.Errorf("failed to compute next position after %q: %w", maxPosition, err)
	}

	query1 := `
		INSERT INTO note (sentence_id, user_id, color, body, priority, task_type, impact, blocked, position)
		VALUES ($1, $2, $3, $4, $5, NULLIF($6, ''), $7, $8, $9)
		RETURNING note_id, created_at, updated_at
	`
	err = tx.QueryRow(ctx, query1,
		note.SentenceID,
		note.UserID,
		note.Color,
		note.Body,
		note.Priority,
		note.TaskType,
		note.Impact,
		note.Blocked,
		nextPosition,
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

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("failed to commit transaction: %w", err)
	}

	return nil
}

// CreateScratchpadNote creates a note homed in a scratchpad (NOTES_PLAN.md
// Phase 2). Unlike CreateNote it has NO sentence: no fractional position scoped
// to a sentence, and NO note_version row (versioning/history is a manuscript
// migration concept; note_version requires a sentence, and scratchpad notes
// never migrate). Sets scratchpad_id; sentence_id stays NULL. manuscript_id is
// set only if note.ManuscriptID is non-nil (inherited from a linked pad).
func (db *DB) CreateScratchpadNote(ctx context.Context, note *models.Note, scratchpadID int) error {
	// Same treatment as CreateNote: the MAX(position) read-then-insert is a
	// check-then-act, so concurrent creates on one pad could mint duplicate
	// positions without the mutex + tx (single-instance server — see
	// createNoteMu).
	createNoteMu.Lock()
	defer createNoteMu.Unlock()

	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	// Position is per-context; scratchpad notes rarely need cross-note ordering,
	// but keep the column populated (append after the max in this scratchpad).
	var maxPosition string
	if err := tx.QueryRow(ctx,
		`SELECT COALESCE(MAX(position), '') FROM note WHERE scratchpad_id = $1`, scratchpadID,
	).Scan(&maxPosition); err != nil {
		return fmt.Errorf("failed to get max position: %w", err)
	}
	nextPosition, err := fractional.GeneratePositionBetween(maxPosition, "")
	if err != nil {
		return fmt.Errorf("failed to compute next position: %w", err)
	}

	err = tx.QueryRow(ctx, `
		INSERT INTO note (user_id, color, body, priority, task_type, impact, blocked, position, scratchpad_id, manuscript_id)
		VALUES ($1, $2, $3, $4, NULLIF($5, ''), $6, $7, $8, $9, $10)
		RETURNING note_id, created_at, updated_at
	`,
		note.UserID, note.Color, note.Body, note.Priority, note.TaskType, note.Impact, note.Blocked, nextPosition, scratchpadID, note.ManuscriptID,
	).Scan(&note.NoteID, &note.CreatedAt, &note.UpdatedAt)
	if err != nil {
		return fmt.Errorf("failed to create scratchpad note: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("failed to commit transaction: %w", err)
	}
	note.Position = nextPosition
	note.ScratchpadID = &scratchpadID
	return nil
}

// UpdateScratchpadNote mutates a scratchpad note's mutable fields directly (no
// version row — see CreateScratchpadNote). Only touches notes with the given id.
// UpdateScratchpadNote directly updates a VERSIONLESS note — scratchpad or
// sketch notes (neither has a sentence origin, so no note_version rows).
// The guard makes sentence notes unreachable here: they must go through
// UpdateNote's versioned path.
func (db *DB) UpdateScratchpadNote(ctx context.Context, noteID int, color *string, body *string, priority *string, taskType *string, impact *string, blocked *bool) error {
	_, err := db.Pool.Exec(ctx, `
		UPDATE note SET
			color     = COALESCE($2, color),
			body      = CASE WHEN $3::boolean THEN $4 ELSE body END,
			priority  = COALESCE($5, priority),
			task_type = CASE WHEN $6::text IS NULL THEN task_type ELSE NULLIF($6, '') END,
			impact    = COALESCE($7, impact),
			blocked   = COALESCE($8, blocked),
			updated_at = NOW()
		WHERE note_id = $1 AND (scratchpad_id IS NOT NULL OR sketch_id IS NOT NULL) AND deleted_at IS NULL
	`, noteID, color, body != nil, body, priority, taskType, impact, blocked)
	return err
}

// UpdateNote mutates the head row and appends a new version.
func (db *DB) UpdateNote(ctx context.Context, noteID int, note *models.Note, version *models.NoteVersion) error {
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	query1 := `
		UPDATE note
		SET sentence_id = $1, color = $2, body = $3, priority = $4, task_type = NULLIF($5, ''), impact = $6, blocked = $7, updated_at = NOW()
		WHERE note_id = $8
		RETURNING updated_at
	`
	err = tx.QueryRow(ctx, query1,
		note.SentenceID,
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

	var maxVersion int
	query2 := `SELECT COALESCE(MAX(version), 0) FROM note_version WHERE note_id = $1`
	if err := tx.QueryRow(ctx, query2, noteID).Scan(&maxVersion); err != nil {
		return fmt.Errorf("failed to get max version: %w", err)
	}

	originSentenceID, originCommitHash, createdBy, originMigrationID, err := getNoteOriginInfo(ctx, tx, noteID)
	if err != nil {
		return fmt.Errorf("failed to get origin info: %w", err)
	}

	newHistoryJSON, err := getSentenceHistory(ctx, tx, noteID, maxVersion, note.SentenceID)
	if err != nil {
		return err
	}

	version.NoteID = noteID
	version.Version = maxVersion + 1
	version.SentenceID = note.SentenceID
	version.Color = note.Color
	version.Body = note.Body
	version.Priority = note.Priority
	version.Flagged = false // note.flagged is gone (031); the version column is legacy
	version.OriginSentenceID = originSentenceID
	version.OriginMigrationID = originMigrationID
	version.OriginCommitHash = originCommitHash
	version.CreatedBy = createdBy

	if err := insertNoteVersion(ctx, tx, version, newHistoryJSON); err != nil {
		return fmt.Errorf("failed to create note version: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("failed to commit transaction: %w", err)
	}

	return nil
}

// NoteMigrationItem: one note to repoint to a new sentence.
type NoteMigrationItem struct {
	NoteID        int
	NewSentenceID string
	Confidence    float64
}

// MigrateNotes is all-or-nothing: error means zero rows committed.
// Each item produces one note UPDATE and one note_version INSERT.
func (db *DB) MigrateNotes(ctx context.Context, items []NoteMigrationItem) (int, error) {
	if len(items) == 0 {
		return 0, nil
	}

	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	// Same per-note flow as UpdateNote, batched in one tx. The
	// `sentence_id IS NOT NULL` guard means ONLY sentence notes migrate — a
	// scratchpad/free note (null sentence_id) is never repointed by a manuscript
	// re-migration. (Items only ever come from GetActiveNotesForSentence, which
	// already can't return null-sentence notes, so this is defense-in-depth.)
	updateNote := `
		UPDATE note
		SET sentence_id = $1, updated_at = NOW()
		WHERE note_id = $2
		  AND sentence_id IS NOT NULL
		  AND deleted_at IS NULL
		  AND completed_at IS NULL
	`

	for _, item := range items {
		// Read latest version first so copied-forward fields + history are authoritative.
		var (
			color      string
			body       *string
			priority   string
			flagged    bool
			maxVersion int
		)
		if err := tx.QueryRow(ctx, `
			SELECT color, body, priority, flagged, version
			FROM note_version
			WHERE note_id = $1
			ORDER BY version DESC
			LIMIT 1
		`, item.NoteID).Scan(&color, &body, &priority, &flagged, &maxVersion); err != nil {
			return 0, fmt.Errorf("note %d: get latest version: %w", item.NoteID, err)
		}

		tag, err := tx.Exec(ctx, updateNote, item.NewSentenceID, item.NoteID)
		if err != nil {
			return 0, fmt.Errorf("note %d: update sentence_id: %w", item.NoteID, err)
		}
		if tag.RowsAffected() == 0 {
			// Hard fail so the whole migration rolls back rather than desyncing versions.
			return 0, fmt.Errorf("note %d: not found or already deleted", item.NoteID)
		}

		originSentenceID, originCommitHash, createdBy, originMigrationID, err := getNoteOriginInfo(ctx, tx, item.NoteID)
		if err != nil {
			return 0, fmt.Errorf("note %d: get origin info: %w", item.NoteID, err)
		}

		newHistoryJSON, err := getSentenceHistory(ctx, tx, item.NoteID, maxVersion, item.NewSentenceID)
		if err != nil {
			return 0, fmt.Errorf("note %d: %w", item.NoteID, err)
		}

		conf := item.Confidence
		newVersion := &models.NoteVersion{
			NoteID:              item.NoteID,
			Version:             maxVersion + 1,
			SentenceID:          item.NewSentenceID,
			Color:               color,
			Body:                body,
			Priority:            priority,
			Flagged:             flagged,
			MigrationConfidence: &conf,
			OriginSentenceID:    originSentenceID,
			OriginMigrationID:   originMigrationID,
			OriginCommitHash:    originCommitHash,
			CreatedBy:           createdBy,
		}
		if err := insertNoteVersion(ctx, tx, newVersion, newHistoryJSON); err != nil {
			return 0, fmt.Errorf("note %d: insert version: %w", item.NoteID, err)
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
func (db *DB) ScorePoints(ctx context.Context, noteID, points int) error {
	_, err := db.Pool.Exec(ctx, `
		INSERT INTO point_event (note_id, points) VALUES ($1, $2)
	`, noteID, points)
	if err != nil {
		return fmt.Errorf("score points on note %d: %w", noteID, err)
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
	query := `
		SELECT
			note_id, version, sentence_id, color, body, priority, flagged,
			sentence_id_history, migration_confidence,
			origin_sentence_id, origin_migration_id, origin_commit_hash, created_at, created_by
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
	rows, err := db.Pool.Query(ctx, `
		SELECT `+noteColumns+`
		FROM note a
		WHERE a.sentence_id = ANY($1)
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
		SELECT ` + noteColumns + `
		FROM note a
		WHERE a.sentence_id = $1
		  AND a.deleted_at IS NULL
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
func (db *DB) ReorderNote(ctx context.Context, noteID int, newIndex int) error {
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	var sentenceID *string
	var userID string
	if err := tx.QueryRow(ctx,
		`SELECT sentence_id, user_id FROM note WHERE note_id = $1 AND deleted_at IS NULL AND completed_at IS NULL`,
		noteID,
	).Scan(&sentenceID, &userID); err != nil {
		return fmt.Errorf("failed to load note for reorder: %w", err)
	}
	if sentenceID == nil {
		return fmt.Errorf("note %d has no sentence to reorder within", noteID)
	}

	query := `SELECT position FROM note WHERE sentence_id = $1 AND user_id = $2 AND deleted_at IS NULL AND completed_at IS NULL ORDER BY position`
	rows, err := tx.Query(ctx, query, *sentenceID, userID)
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

	updateQuery := `UPDATE note SET position = $1, updated_at = NOW() WHERE note_id = $2`
	_, err = tx.Exec(ctx, updateQuery, newPosition, noteID)
	if err != nil {
		return fmt.Errorf("failed to update note position: %w", err)
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
