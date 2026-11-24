package database

// Note PLACEMENTS (NOTE_PLACEMENTS_PLAN.md): where a note appears is rows in
// note_sentence / note_scratchpad, not columns on the note. Phase 1 keeps the
// legacy note.sentence_id / note.scratchpad_id columns authoritative for every
// reader and DUAL-WRITES the junction rows alongside them; phase 2 flips the
// readers. Everything here is idempotent so the boot-time reconcile can run
// against whatever the previous container wrote.

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
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
	_, err := q.Exec(ctx, `
		INSERT INTO note_sentence (note_id, sentence_id, position, origin_sentence_id, origin_migration_id,
		                           origin_commit_hash, sentence_id_history, migration_confidence, created_at, created_by)
		SELECT n.note_id, $3::text,
		       COALESCE(old.position, n.position),
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
// noteRef atom ({"type":"noteRef","attrs":{"noteId":N,"text":"…"}}). The
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
		if t, _ := node["type"].(string); t == "noteRef" || t == "noteAnchor" {
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

// ReconcileNotePlacements brings the junction tables up to date with the
// legacy home columns and the live pad docs. Idempotent; run at boot (the
// previous container may have written notes after the backfill changeset
// committed, and a rolled-back deploy would have kept doing so) and by hand.
// Returns how many sentence / scratchpad placement rows were added and how
// many pads were synced.
func (db *DB) ReconcileNotePlacements(ctx context.Context) (sentences, scratchpads, pads int, err error) {
	tag, err := db.Pool.Exec(ctx, `
		INSERT INTO note_sentence (note_id, sentence_id, position, origin_sentence_id, origin_migration_id,
		                           origin_commit_hash, sentence_id_history, migration_confidence, created_at, created_by)
		SELECT n.note_id, n.sentence_id, n.position,
		       v1.origin_sentence_id, v1.origin_migration_id, v1.origin_commit_hash,
		       COALESCE(vl.sentence_id_history, '[]'::jsonb), vl.migration_confidence,
		       n.created_at, n.user_id
		FROM note n
		LEFT JOIN LATERAL (
			SELECT origin_sentence_id, origin_migration_id, origin_commit_hash
			FROM note_version v WHERE v.note_id = n.note_id ORDER BY v.version ASC LIMIT 1
		) v1 ON true
		LEFT JOIN LATERAL (
			SELECT sentence_id_history, migration_confidence
			FROM note_version v WHERE v.note_id = n.note_id ORDER BY v.version DESC LIMIT 1
		) vl ON true
		WHERE n.sentence_id IS NOT NULL
		ON CONFLICT (note_id, sentence_id) DO NOTHING
	`)
	if err != nil {
		return 0, 0, 0, fmt.Errorf("reconcile sentence placements: %w", err)
	}
	sentences = int(tag.RowsAffected())

	tag, err = db.Pool.Exec(ctx, `
		INSERT INTO note_scratchpad (note_id, scratchpad_id, created_at, removed_at)
		SELECT n.note_id, n.scratchpad_id, n.created_at, n.updated_at
		FROM note n
		WHERE n.scratchpad_id IS NOT NULL
		ON CONFLICT (note_id, scratchpad_id) DO NOTHING
	`)
	if err != nil {
		return sentences, 0, 0, fmt.Errorf("reconcile scratchpad placements: %w", err)
	}
	scratchpads = int(tag.RowsAffected())

	// The docs are the truth for what is LIVE in a pad: re-open what they
	// hold (including the rows just inserted as removed), close what they
	// don't.
	rows, err := db.Pool.Query(ctx, `SELECT scratchpad_id, doc FROM scratchpad WHERE deleted_at IS NULL`)
	if err != nil {
		return sentences, scratchpads, 0, fmt.Errorf("reconcile: list pads: %w", err)
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
			return sentences, scratchpads, 0, fmt.Errorf("reconcile: scan pad: %w", err)
		}
		docs = append(docs, p)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return sentences, scratchpads, 0, err
	}
	for _, p := range docs {
		ids, err := noteIDsInDoc(p.doc)
		if err != nil {
			continue // an unparseable doc is skipped, never fatal (BackfillVariationHomes does the same)
		}
		if err := db.syncScratchpadPlacements(ctx, db.Pool, p.id, ids); err != nil {
			return sentences, scratchpads, pads, err
		}
		pads++
	}
	return sentences, scratchpads, pads, nil
}

// NotePlacementCounts: live rows per table — the parity check the deploy
// verifies against the legacy columns (and the tests assert).
type NotePlacementCounts struct {
	SentencePlacements   int
	LegacySentenceNotes  int
	ScratchpadPlacements int
	LegacyPadNotes       int
}

func (db *DB) CountNotePlacements(ctx context.Context) (NotePlacementCounts, error) {
	var c NotePlacementCounts
	err := db.Pool.QueryRow(ctx, `
		SELECT (SELECT count(*) FROM note_sentence),
		       (SELECT count(*) FROM note WHERE sentence_id IS NOT NULL),
		       (SELECT count(*) FROM note_scratchpad),
		       (SELECT count(*) FROM note WHERE scratchpad_id IS NOT NULL)
	`).Scan(&c.SentencePlacements, &c.LegacySentenceNotes, &c.ScratchpadPlacements, &c.LegacyPadNotes)
	return c, err
}
