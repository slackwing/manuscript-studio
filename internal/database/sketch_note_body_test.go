package database

// 050: a sketch's note body is DERIVED — the first prose sentence of the
// sketch — until its owner writes one, and derived again if they empty it.

import (
	"testing"
	"time"
)

func (f *varFixture) sketchNote(t *testing.T, sketchID string) (id int, body *string, auto bool, updated time.Time) {
	t.Helper()
	if err := f.pool.QueryRow(f.ctx, `
		SELECT note_id, body, body_auto, updated_at FROM note WHERE sketch_id = $1 AND deleted_at IS NULL
	`, sketchID).Scan(&id, &body, &auto, &updated); err != nil {
		t.Fatalf("read sketch note: %v", err)
	}
	return
}

func deref(s *string) string {
	if s == nil {
		return "<nil>"
	}
	return *s
}

func TestSketchNoteBody_DerivedUntilWritten(t *testing.T) {
	f := newVarFixture(t)
	vc := f.newSketch(t, nil)
	sk, aID := vc.Sketch.SketchID, vc.Variation.VariationID

	noteID, body, auto, updated0 := f.sketchNote(t, sk)
	if body != nil || !auto {
		t.Fatalf("fresh sketch note: body=%s auto=%v, want <nil>/true", deref(body), auto)
	}

	// Every save keeps the body on the sketch's first sentence — without
	// touching updated_at or the note's version history.
	if err := f.db.UpdateVariationText(f.ctx, f.user, aID, "&chapter#one{One}\n\nThe *rain* came, _slowly_. Then the wind."); err != nil {
		t.Fatalf("save: %v", err)
	}
	_, body, _, updated1 := f.sketchNote(t, sk)
	if deref(body) != "The rain came, slowly." {
		t.Errorf("derived body = %q, want %q", deref(body), "The rain came, slowly.")
	}
	if !updated1.Equal(updated0) {
		t.Errorf("updated_at moved on a derived save: %v → %v", updated0, updated1)
	}
	var versions int
	f.pool.QueryRow(f.ctx, `SELECT COUNT(*) FROM note_version WHERE note_id = $1`, noteID).Scan(&versions)
	if versions != 0 {
		t.Errorf("derived save wrote %d note_version rows, want 0", versions)
	}
	if err := f.db.UpdateVariationText(f.ctx, f.user, aID, "Wind first."); err != nil {
		t.Fatalf("save 2: %v", err)
	}
	if _, body, _, _ = f.sketchNote(t, sk); deref(body) != "Wind first." {
		t.Errorf("re-derived body = %q, want %q", deref(body), "Wind first.")
	}

	// The owner writes their own → it sticks through later saves.
	mine := "My own words"
	if err := f.db.UpdateScratchpadNote(f.ctx, noteID, nil, &mine, nil, nil, nil, nil); err != nil {
		t.Fatalf("manual edit: %v", err)
	}
	if err := f.db.UpdateVariationText(f.ctx, f.user, aID, "Something else entirely."); err != nil {
		t.Fatalf("save 3: %v", err)
	}
	if _, body, auto, _ = f.sketchNote(t, sk); deref(body) != mine || auto {
		t.Errorf("after manual edit: body=%q auto=%v, want %q/false", deref(body), auto, mine)
	}
	// A color change is not a body edit — still the owner's text.
	blue := "blue"
	f.db.UpdateScratchpadNote(f.ctx, noteID, &blue, nil, nil, nil, nil, nil)
	if _, _, auto, _ = f.sketchNote(t, sk); auto {
		t.Error("color edit flipped body_auto back on")
	}

	// Emptied → derived again, from the latest text.
	empty := "  "
	if err := f.db.UpdateScratchpadNote(f.ctx, noteID, nil, &empty, nil, nil, nil, nil); err != nil {
		t.Fatalf("empty: %v", err)
	}
	if err := f.db.RederiveSketchNoteBody(f.ctx, noteID); err != nil {
		t.Fatalf("rederive: %v", err)
	}
	if _, body, auto, _ = f.sketchNote(t, sk); deref(body) != "Something else entirely." || !auto {
		t.Errorf("after emptying: body=%q auto=%v, want derived/true", deref(body), auto)
	}

	// A new variation (the sparkles button) is a save too.
	if _, err := f.db.CreateVariationFromText(f.ctx, f.user, sk, "Brand new take. More.", nil); err != nil {
		t.Fatalf("new variation: %v", err)
	}
	if _, body, _, _ = f.sketchNote(t, sk); deref(body) != "Brand new take." {
		t.Errorf("after new variation: body = %q", deref(body))
	}
}

func TestSketchNoteBody_PlacedFromSelection(t *testing.T) {
	f := newVarFixture(t)
	mID := f.newManuscript(t)
	padID := f.newPad(t, "bench")
	vc, err := f.db.CreatePlacedSketchFromSelection(f.ctx, f.user, mID, "Book", "So, forgive me. The rest follows.", padID)
	if err != nil {
		t.Fatalf("place: %v", err)
	}
	if _, body, auto, _ := f.sketchNote(t, vc.Sketch.SketchID); deref(body) != "So, forgive me." || !auto {
		t.Errorf("placed sketch note: body=%q auto=%v", deref(body), auto)
	}
}

func TestBackfillSketchNoteBodies(t *testing.T) {
	f := newVarFixture(t)
	vc := f.newSketch(t, nil)
	sk := vc.Sketch.SketchID
	// Text written behind the derive hook — what pre-050 sketches look like.
	if _, err := f.pool.Exec(f.ctx, `UPDATE variation SET text = $2 WHERE variation_id = $1`,
		vc.Variation.VariationID, "Old text, never summarized. Second."); err != nil {
		t.Fatal(err)
	}
	// And one the owner wrote: never overwritten.
	vc2 := f.newSketch(t, nil)
	f.pool.Exec(f.ctx, `UPDATE variation SET text = 'Ignored.' WHERE variation_id = $1`, vc2.Variation.VariationID)
	f.pool.Exec(f.ctx, `UPDATE note SET body = 'kept', body_auto = false WHERE sketch_id = $1`, vc2.Sketch.SketchID)

	if _, err := f.db.BackfillSketchNoteBodies(f.ctx); err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if _, body, _, _ := f.sketchNote(t, sk); deref(body) != "Old text, never summarized." {
		t.Errorf("backfilled body = %q", deref(body))
	}
	if _, body, _, _ := f.sketchNote(t, vc2.Sketch.SketchID); deref(body) != "kept" {
		t.Errorf("owner's body overwritten: %q", deref(body))
	}
	// Idempotent.
	if _, err := f.db.BackfillSketchNoteBodies(f.ctx); err != nil {
		t.Fatalf("backfill 2: %v", err)
	}
}
