package database

import (
	"testing"
)

// The picker's feed (NOTE_UI_PLAN.md phase 2): my live notes, others' notes
// on manuscripts I hold a role on; not others' free notes, not notes I hid,
// not deleted ones; newest first; text search.
func TestListRecentNotesForUser(t *testing.T) {
	f := newITFixture(t)
	_, sids := f.makeDoneMigration(t, "recent", "A sentence for recent notes.", "Another one.")
	if _, err := f.pool.Exec(f.ctx, `INSERT INTO role (username, manuscript_id, role) VALUES ($1, $2, 'author') ON CONFLICT DO NOTHING`, f.username, f.manuscriptID); err != nil {
		t.Fatal(err)
	}
	other := "other-" + f.username
	if _, err := f.pool.Exec(f.ctx, `INSERT INTO "user" (username, password_hash, role) VALUES ($1, 'x', 'author') ON CONFLICT DO NOTHING`, other); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		f.pool.Exec(f.ctx, `DELETE FROM note WHERE user_id = $1`, other)
		f.pool.Exec(f.ctx, `DELETE FROM "user" WHERE username = $1`, other)
	})
	mine := f.createNote(t, sids[0], "mine on the book")
	pad, err := f.db.CreateScratchpad(f.ctx, f.username, "Recent pad")
	if err != nil {
		t.Fatal(err)
	}
	minePad := f.createPadNote(t, pad.ScratchpadID, "mine in a pad")
	// Others': on my manuscript's sentence (visible), free (not visible), deleted (not).
	var theirs, theirsFree, theirsDeleted int
	f.pool.QueryRow(f.ctx, `INSERT INTO note (user_id, color, body, priority) VALUES ($1, 'blue', 'theirs on the book', 'none') RETURNING note_id`, other).Scan(&theirs)
	f.pool.Exec(f.ctx, `INSERT INTO note_sentence (note_id, sentence_id, position, origin_sentence_id, created_by) VALUES ($1, $2, 'a0', $2, $3)`, theirs, sids[1], other)
	f.pool.QueryRow(f.ctx, `INSERT INTO note (user_id, color, body, priority) VALUES ($1, 'blue', 'theirs free', 'none') RETURNING note_id`, other).Scan(&theirsFree)
	f.pool.QueryRow(f.ctx, `INSERT INTO note (user_id, color, body, priority, deleted_at) VALUES ($1, 'blue', 'theirs deleted', 'none', now()) RETURNING note_id`, other).Scan(&theirsDeleted)
	f.pool.Exec(f.ctx, `INSERT INTO note_sentence (note_id, sentence_id, position, origin_sentence_id, created_by) VALUES ($1, $2, 'a1', $2, $3)`, theirsDeleted, sids[1], other)
	// One of mine, hidden by me.
	hidden := f.createNote(t, sids[0], "mine but hidden")
	f.pool.Exec(f.ctx, `INSERT INTO note_hide (note_id, username) VALUES ($1, $2)`, hidden.NoteID, f.username)
	// Make `theirs` the newest, then minePad, then mine.
	f.pool.Exec(f.ctx, `UPDATE note SET updated_at = now() - interval '3 minutes' WHERE note_id = $1`, mine.NoteID)
	f.pool.Exec(f.ctx, `UPDATE note SET updated_at = now() - interval '2 minutes' WHERE note_id = $1`, minePad.NoteID)
	f.pool.Exec(f.ctx, `UPDATE note SET updated_at = now() - interval '1 minute' WHERE note_id = $1`, theirs)

	got, err := f.db.ListRecentNotesForUser(f.ctx, f.username, "", 50)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	ids := map[int]HomeNote{}
	var order []int
	for _, h := range got {
		ids[h.NoteID] = h
		if h.NoteID == mine.NoteID || h.NoteID == minePad.NoteID || h.NoteID == theirs {
			order = append(order, h.NoteID)
		}
	}
	for _, want := range []int{mine.NoteID, minePad.NoteID, theirs} {
		if _, ok := ids[want]; !ok {
			t.Fatalf("note %d should be listed; got %v", want, order)
		}
	}
	for _, no := range []int{theirsFree, theirsDeleted, hidden.NoteID} {
		if _, ok := ids[no]; ok {
			t.Fatalf("note %d must NOT be listed", no)
		}
	}
	if len(order) != 3 || order[0] != theirs || order[1] != minePad.NoteID || order[2] != mine.NoteID {
		t.Fatalf("newest first: got %v", order)
	}
	if ids[theirs].Owner != other || ids[mine.NoteID].Owner != f.username {
		t.Fatalf("owner column: %q / %q", ids[theirs].Owner, ids[mine.NoteID].Owner)
	}
	if ids[minePad.NoteID].ScratchpadTitle != "Recent pad" {
		t.Fatalf("pad context: %q", ids[minePad.NoteID].ScratchpadTitle)
	}
	// `theirs` was raw-inserted without manuscript_id: its book comes from
	// the placement.
	if ids[theirs].ManuscriptID != nil || ids[theirs].PlacedManuscriptID == nil || *ids[theirs].PlacedManuscriptID != f.manuscriptID {
		t.Fatalf("placed manuscript fallback: %v / %v", ids[theirs].ManuscriptID, ids[theirs].PlacedManuscriptID)
	}
	// Search narrows by text, case-insensitively.
	got, err = f.db.ListRecentNotesForUser(f.ctx, f.username, "IN A PAD", 50)
	if err != nil || len(got) != 1 || got[0].NoteID != minePad.NoteID {
		t.Fatalf("search: %v (%v)", got, err)
	}
	// Limit.
	got, _ = f.db.ListRecentNotesForUser(f.ctx, f.username, "", 1)
	if len(got) != 1 {
		t.Fatalf("limit 1: %d", len(got))
	}
}
