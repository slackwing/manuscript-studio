package database

// 052: note.default_body — what a note shows while its owner's text is
// blank. Derived by the server, never written into body.

import (
	"testing"
	"time"
)

func deref(s *string) string {
	if s == nil {
		return "<nil>"
	}
	return *s
}

func (f *varFixture) sketchNote(t *testing.T, sketchID string) (id int, body, def *string, updated time.Time) {
	t.Helper()
	if err := f.pool.QueryRow(f.ctx, `
		SELECT note_id, body, default_body, updated_at FROM note WHERE sketch_id = $1 AND deleted_at IS NULL
	`, sketchID).Scan(&id, &body, &def, &updated); err != nil {
		t.Fatalf("read sketch note: %v", err)
	}
	return
}

func TestSketchNoteDefault_FollowsTheSketch(t *testing.T) {
	f := newVarFixture(t)
	vc := f.newSketch(t, nil)
	sk, aID := vc.Sketch.SketchID, vc.Variation.VariationID
	noteID, body, def, updated0 := f.sketchNote(t, sk)
	if body != nil || def != nil {
		t.Fatalf("fresh sketch note: body=%s default=%s, want both empty", deref(body), deref(def))
	}
	if err := f.db.UpdateVariationText(f.ctx, f.user, aID, "&chapter#one{One}\n\nThe *rain* came, _slowly_. Then the wind."); err != nil {
		t.Fatalf("save: %v", err)
	}
	_, body, def, updated1 := f.sketchNote(t, sk)
	if deref(def) != "The rain came, slowly." || body != nil {
		t.Errorf("after a save: body=%s default=%s", deref(body), deref(def))
	}
	if !updated1.Equal(updated0) {
		t.Errorf("updated_at moved on a derived save")
	}
	var versions int
	f.pool.QueryRow(f.ctx, `SELECT COUNT(*) FROM note_version WHERE note_id = $1`, noteID).Scan(&versions)
	if versions != 0 {
		t.Errorf("derived save wrote %d note_version rows", versions)
	}
	// Fill-ins win over the first sentence.
	f.db.UpdateVariationText(f.ctx, f.user, aID, "It was {adjective}. Then {something else}.")
	if _, _, def, _ = f.sketchNote(t, sk); deref(def) != "{adjective} {something else}" {
		t.Errorf("fill-ins: default = %s", deref(def))
	}
	// The owner's own text lives in body; the default keeps following.
	mine := "My own words"
	f.db.UpdateScratchpadNote(f.ctx, noteID, nil, &mine, nil, nil, nil, nil)
	f.db.UpdateVariationText(f.ctx, f.user, aID, "Wind first.")
	if _, body, def, _ = f.sketchNote(t, sk); deref(body) != mine || deref(def) != "Wind first." {
		t.Errorf("owner text + default: body=%s default=%s", deref(body), deref(def))
	}
	if _, err := f.db.CreateVariationFromText(f.ctx, f.user, sk, "Brand new take. More.", nil); err != nil {
		t.Fatalf("new variation: %v", err)
	}
	if _, _, def, _ = f.sketchNote(t, sk); deref(def) != "Brand new take." {
		t.Errorf("after new variation: default = %s", deref(def))
	}
}

func TestSketchNoteDefault_PlacedFromSelection(t *testing.T) {
	f := newVarFixture(t)
	mID := f.newManuscript(t)
	padID := f.newPad(t, "bench")
	vc, err := f.db.CreatePlacedSketchFromSelection(f.ctx, f.user, mID, "Book", "So, forgive me. The rest follows.", padID)
	if err != nil {
		t.Fatalf("place: %v", err)
	}
	if _, body, def, _ := f.sketchNote(t, vc.Sketch.SketchID); body != nil || deref(def) != "So, forgive me." {
		t.Errorf("placed sketch note: body=%s default=%s", deref(body), deref(def))
	}
}

func (f *itFixture) noteDefault(t *testing.T, noteID int) string {
	t.Helper()
	var d *string
	if err := f.pool.QueryRow(f.ctx, `SELECT default_body FROM note WHERE note_id = $1`, noteID).Scan(&d); err != nil {
		t.Fatalf("read default: %v", err)
	}
	return deref(d)
}

func TestSentenceNoteDefaults(t *testing.T) {
	f := newITFixture(t)
	migID, sids := f.makeDoneMigration(t, "nd-c1", "The telephone rang twice before anyone moved.", "Short one.")
	note := f.createNote(t, sids[0], "")
	if err := f.db.RefreshSentenceNoteDefaults(f.ctx, []string{sids[0]}); err != nil {
		t.Fatal(err)
	}
	if got := f.noteDefault(t, note.NoteID); got != "The telephone rang..." {
		t.Errorf("committed text: default = %q", got)
	}
	// The OWNER's suggested edit is the sentence as they see it.
	if _, err := f.db.UpsertSuggestion(f.ctx, sids[0], f.username, "The telephone was {adjective} and {loud}."); err != nil {
		t.Fatal(err)
	}
	f.db.RefreshSentenceNoteDefaults(f.ctx, []string{sids[0]})
	if got := f.noteDefault(t, note.NoteID); got != "{adjective} {loud}" {
		t.Errorf("owner's suggestion: default = %q", got)
	}
	// Someone else's suggestion doesn't count.
	other := f.newUser(t)
	f.db.UpsertSuggestion(f.ctx, sids[0], other, "{nope} from someone else.")
	f.db.RefreshSentenceNoteDefaults(f.ctx, []string{sids[0]})
	if got := f.noteDefault(t, note.NoteID); got != "{adjective} {loud}" {
		t.Errorf("another user's suggestion leaked in: %q", got)
	}
	// A deletion proposal keeps the committed text.
	f.db.UpsertSuggestion(f.ctx, sids[0], f.username, "")
	f.db.RefreshSentenceNoteDefaults(f.ctx, []string{sids[0]})
	if got := f.noteDefault(t, note.NoteID); got != "The telephone rang..." {
		t.Errorf("deletion proposal: default = %q", got)
	}
	// Per-migration refresh + backfill.
	n2 := f.createNote(t, sids[1], "")
	if _, err := f.db.RefreshNoteDefaultsForMigration(f.ctx, migID); err != nil {
		t.Fatal(err)
	}
	if got := f.noteDefault(t, n2.NoteID); got != "Short one." {
		t.Errorf("migration refresh: default = %q", got)
	}
	f.pool.Exec(f.ctx, `UPDATE note SET default_body = NULL WHERE note_id = $1`, n2.NoteID)
	if _, err := f.db.BackfillNoteDefaults(f.ctx); err != nil {
		t.Fatal(err)
	}
	if got := f.noteDefault(t, n2.NoteID); got != "Short one." {
		t.Errorf("backfill: default = %q", got)
	}
}
