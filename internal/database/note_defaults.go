package database

// Note defaults (052): what a note shows while its owner's text is blank —
// note.default_body, derived by sentence.NoteDefault and kept current here.
//   - sentence notes: from the sentence AS ITS OWNER SEES IT (their own
//     suggested edit when they have one, else the committed text) — kept
//     current on note create, on every suggestion save/delete, and after
//     each migration;
//   - sketch notes: from the sketch's text (variations.go keeps it current
//     on every save).

import (
	"context"
	"fmt"
	"strings"

	"github.com/slackwing/manuscript-studio/internal/sentence"
)

// refreshSentenceNoteDefaults recomputes default_body for the sentence
// notes the WHERE clause (on note n) selects; $1 is its argument.
func (db *DB) refreshSentenceNoteDefaults(ctx context.Context, where string, arg any) (int, error) {
	rows, err := db.Pool.Query(ctx, `
		SELECT n.note_id, s.text, sc.text, n.default_body
		FROM note n
		JOIN sentence s ON s.sentence_id = n.sentence_id
		LEFT JOIN suggested_change sc ON sc.sentence_id = n.sentence_id AND sc.user_id = n.user_id
		WHERE n.deleted_at IS NULL AND `+where, arg)
	if err != nil {
		return 0, fmt.Errorf("note defaults: list: %w", err)
	}
	type change struct {
		id  int
		def string
	}
	var todo []change
	for rows.Next() {
		var id int
		var committed string
		var suggestion, cur *string
		if err := rows.Scan(&id, &committed, &suggestion, &cur); err != nil {
			rows.Close()
			return 0, fmt.Errorf("note defaults: scan: %w", err)
		}
		text := committed
		if suggestion != nil && strings.TrimSpace(*suggestion) != "" {
			text = *suggestion // a deletion proposal (empty) keeps the committed text
		}
		def := sentence.NoteDefault(text, false)
		if cur == nil && def == "" || cur != nil && *cur == def {
			continue
		}
		todo = append(todo, change{id, def})
	}
	rows.Close()
	for _, c := range todo {
		if _, err := db.Pool.Exec(ctx, `UPDATE note SET default_body = NULLIF($2, '') WHERE note_id = $1`, c.id, c.def); err != nil {
			return 0, fmt.Errorf("note defaults: update %d: %w", c.id, err)
		}
	}
	return len(todo), nil
}

// RefreshSentenceNoteDefaults: the notes on these sentences (a note was
// made, or a suggestion on the sentence saved/cleared).
func (db *DB) RefreshSentenceNoteDefaults(ctx context.Context, sentenceIDs []string) error {
	_, err := db.refreshSentenceNoteDefaults(ctx, `n.sentence_id = ANY($1)`, sentenceIDs)
	return err
}

// RefreshNoteDefaultsForMigration: every note now on this migration's
// sentences (run after it moved notes and carried suggestions forward).
func (db *DB) RefreshNoteDefaultsForMigration(ctx context.Context, migrationID int) (int, error) {
	return db.refreshSentenceNoteDefaults(ctx, `s.migration_id = $1`, migrationID)
}

// BackfillNoteDefaults fills default_body for every live note still
// without one: sentence notes from their sentence, sketch notes from the
// sketch's most recently edited variation. Idempotent; runs at startup.
func (db *DB) BackfillNoteDefaults(ctx context.Context) (int, error) {
	n, err := db.refreshSentenceNoteDefaults(ctx, `n.default_body IS NULL AND $1::boolean`, true)
	if err != nil {
		return n, err
	}
	rows, err := db.Pool.Query(ctx, `
		SELECT n.note_id,
		       (SELECT v.text FROM variation v
		        WHERE v.sketch_id = n.sketch_id AND coalesce(trim(v.text), '') <> ''
		        ORDER BY v.updated_at DESC, v.variation_id DESC LIMIT 1)
		FROM note n
		WHERE n.sketch_id IS NOT NULL AND n.deleted_at IS NULL AND n.default_body IS NULL
	`)
	if err != nil {
		return n, fmt.Errorf("sketch note defaults: list: %w", err)
	}
	type pending struct {
		id   int
		text *string
	}
	var todo []pending
	for rows.Next() {
		var p pending
		if err := rows.Scan(&p.id, &p.text); err != nil {
			rows.Close()
			return n, fmt.Errorf("sketch note defaults: scan: %w", err)
		}
		todo = append(todo, p)
	}
	rows.Close()
	for _, p := range todo {
		if p.text == nil {
			continue
		}
		def := sentence.NoteDefault(*p.text, true)
		if def == "" {
			continue
		}
		if _, err := db.Pool.Exec(ctx, `UPDATE note SET default_body = $2 WHERE note_id = $1`, p.id, def); err != nil {
			return n, fmt.Errorf("sketch note default %d: %w", p.id, err)
		}
		n++
	}
	return n, nil
}
