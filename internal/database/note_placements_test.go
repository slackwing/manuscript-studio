package database

// Note placements (NOTE_PLACEMENTS_PLAN.md phase 1): every write path that
// touches a note's home also writes its junction row, the pad index mirrors
// the pad doc, and the boot reconcile repairs drift. Phase 1 readers still
// use the legacy columns, so these tests assert PARITY: junction == column.

import (
	"encoding/json"
	"fmt"
	"testing"
)

type sentencePlacement struct {
	sentenceID string
	position   string
	origin     string
	history    []string
	confidence *float64
}

func (f *itFixture) sentencePlacements(t *testing.T, noteID int) []sentencePlacement {
	t.Helper()
	rows, err := f.pool.Query(f.ctx, `
		SELECT sentence_id, position, COALESCE(origin_sentence_id, ''), sentence_id_history, migration_confidence
		FROM note_sentence WHERE note_id = $1 ORDER BY sentence_id`, noteID)
	if err != nil {
		t.Fatalf("placements: %v", err)
	}
	defer rows.Close()
	var out []sentencePlacement
	for rows.Next() {
		var p sentencePlacement
		var hist []byte
		if err := rows.Scan(&p.sentenceID, &p.position, &p.origin, &hist, &p.confidence); err != nil {
			t.Fatalf("scan placement: %v", err)
		}
		_ = json.Unmarshal(hist, &p.history)
		out = append(out, p)
	}
	return out
}

// padPlacements returns note_id → removed? for a pad.
func (f *itFixture) padPlacements(t *testing.T, padID int) map[int]bool {
	t.Helper()
	rows, err := f.pool.Query(f.ctx, `SELECT note_id, removed_at IS NOT NULL FROM note_scratchpad WHERE scratchpad_id = $1`, padID)
	if err != nil {
		t.Fatalf("pad placements: %v", err)
	}
	defer rows.Close()
	out := map[int]bool{}
	for rows.Next() {
		var id int
		var removed bool
		if err := rows.Scan(&id, &removed); err != nil {
			t.Fatalf("scan: %v", err)
		}
		out[id] = removed
	}
	return out
}

func padDoc(noteIDs ...int) json.RawMessage {
	refs := ""
	for i, id := range noteIDs {
		if i > 0 {
			refs += ","
		}
		refs += fmt.Sprintf(`{"type":"noteRef","attrs":{"noteId":%d,"text":"anchor %d"}}`, id, id)
	}
	return json.RawMessage(fmt.Sprintf(`{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"before "},%s]}]}`, refs))
}

func TestPlacements_CreateNoteWritesSentencePlacement(t *testing.T) {
	f := newITFixture(t)
	_, sids := f.makeDoneMigration(t, "pl-create", "Alpha sentence here.", "Beta sentence here.")
	n := f.createNote(t, sids[0], "placed")

	got := f.sentencePlacements(t, n.NoteID)
	if len(got) != 1 {
		t.Fatalf("want 1 placement, got %d", len(got))
	}
	p := got[0]
	if p.sentenceID != sids[0] || p.position != n.Position || p.origin != sids[0] {
		t.Fatalf("placement mismatch: %+v (note position %q)", p, n.Position)
	}
	if len(p.history) != 0 || p.confidence != nil {
		t.Fatalf("fresh placement must have empty history and no confidence: %+v", p)
	}
}

func TestPlacements_CreatePadNoteWritesScratchpadPlacement(t *testing.T) {
	f := newITFixture(t)
	pad, err := f.db.CreateScratchpad(f.ctx, f.username, "Placement pad")
	if err != nil {
		t.Fatalf("CreateScratchpad: %v", err)
	}
	n := f.createPadNote(t, pad.ScratchpadID, "pad placed")
	pp := f.padPlacements(t, pad.ScratchpadID)
	if removed, ok := pp[n.NoteID]; !ok || removed {
		t.Fatalf("want a live placement for note %d in pad %d, got %v", n.NoteID, pad.ScratchpadID, pp)
	}
	if len(f.sentencePlacements(t, n.NoteID)) != 0 {
		t.Fatal("a pad note must have no sentence placement")
	}
}

func TestPlacements_SyncMirrorsThePadDoc(t *testing.T) {
	f := newITFixture(t)
	pad, err := f.db.CreateScratchpad(f.ctx, f.username, "Sync pad")
	if err != nil {
		t.Fatalf("CreateScratchpad: %v", err)
	}
	a := f.createPadNote(t, pad.ScratchpadID, "a")
	b := f.createPadNote(t, pad.ScratchpadID, "b")
	_, sids := f.makeDoneMigration(t, "pl-sync", "A sentence for a note.")
	s := f.createNote(t, sids[0], "sentence note pasted into the pad")

	// The doc holds a, b and the sentence note (a paste across contexts), plus
	// an id that is not a note at all.
	if err := f.db.SyncScratchpadPlacements(f.ctx, pad.ScratchpadID, padDoc(a.NoteID, b.NoteID, s.NoteID, 987654321)); err != nil {
		t.Fatalf("sync: %v", err)
	}
	pp := f.padPlacements(t, pad.ScratchpadID)
	for _, id := range []int{a.NoteID, b.NoteID, s.NoteID} {
		if removed, ok := pp[id]; !ok || removed {
			t.Fatalf("note %d should be live in the pad: %v", id, pp)
		}
	}
	if _, ok := pp[987654321]; ok {
		t.Fatal("an unknown id must not create a placement")
	}

	// b's anchor leaves the doc → its placement closes; the others stay.
	if err := f.db.SyncScratchpadPlacements(f.ctx, pad.ScratchpadID, padDoc(a.NoteID, s.NoteID)); err != nil {
		t.Fatalf("sync 2: %v", err)
	}
	pp = f.padPlacements(t, pad.ScratchpadID)
	if !pp[b.NoteID] {
		t.Fatalf("b's placement should be closed (removed_at set): %v", pp)
	}
	if pp[a.NoteID] || pp[s.NoteID] {
		t.Fatalf("a and s must stay live: %v", pp)
	}
	// The sentence note is untouched as a note: still on its sentence.
	if got := f.sentencePlacements(t, s.NoteID); len(got) != 1 || got[0].sentenceID != sids[0] {
		t.Fatalf("sentence placement must survive a pad sync: %+v", got)
	}

	// b comes back (undo) → re-opened, not duplicated.
	if err := f.db.SyncScratchpadPlacements(f.ctx, pad.ScratchpadID, padDoc(a.NoteID, b.NoteID, s.NoteID)); err != nil {
		t.Fatalf("sync 3: %v", err)
	}
	pp = f.padPlacements(t, pad.ScratchpadID)
	if pp[b.NoteID] || len(pp) != 3 {
		t.Fatalf("b should be live again and the pad should hold exactly 3 rows: %v", pp)
	}

	// A doc that isn't a doc fails loudly (the handler logs; the save stands).
	if err := f.db.SyncScratchpadPlacements(f.ctx, pad.ScratchpadID, json.RawMessage(`not json`)); err == nil {
		t.Fatal("garbage doc must error")
	}
}

func TestPlacements_LegacyNoteAnchorShapeIsRead(t *testing.T) {
	doc := json.RawMessage(`{"type":"doc","content":[{"type":"paragraph","content":[
		{"type":"noteAnchor","attrs":{"note_id":41,"color":"yellow"}},
		{"type":"text","text":"x","marks":[{"type":"noteHighlight","attrs":{"color":"yellow"}}]},
		{"type":"noteRef","attrs":{"noteId":42,"text":"y"}},
		{"type":"noteRef","attrs":{"noteId":42,"text":"again"}}]}]}`)
	ids, err := noteIDsInDoc(doc)
	if err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(ids) != "[41 42]" {
		t.Fatalf("want [41 42] (deduped, doc order), got %v", ids)
	}
}

func TestPlacements_SoftDeleteScratchpadClosesPlacements(t *testing.T) {
	f := newITFixture(t)
	pad, err := f.db.CreateScratchpad(f.ctx, f.username, "Doomed pad")
	if err != nil {
		t.Fatalf("CreateScratchpad: %v", err)
	}
	n := f.createPadNote(t, pad.ScratchpadID, "going down with the pad (phase 1)")
	if err := f.db.SoftDeleteScratchpad(f.ctx, pad.ScratchpadID); err != nil {
		t.Fatalf("SoftDeleteScratchpad: %v", err)
	}
	if pp := f.padPlacements(t, pad.ScratchpadID); !pp[n.NoteID] {
		t.Fatalf("placement should be closed after the pad is deleted: %v", pp)
	}
}

func TestPlacements_ReorderUpdatesPlacementPosition(t *testing.T) {
	f := newITFixture(t)
	_, sids := f.makeDoneMigration(t, "pl-reorder", "One sentence to stack notes on.")
	n1 := f.createNote(t, sids[0], "first")
	n2 := f.createNote(t, sids[0], "second")
	if err := f.db.ReorderNote(f.ctx, n2.NoteID, 0); err != nil {
		t.Fatalf("ReorderNote: %v", err)
	}
	var notePos string
	if err := f.pool.QueryRow(f.ctx, `SELECT position FROM note WHERE note_id = $1`, n2.NoteID).Scan(&notePos); err != nil {
		t.Fatal(err)
	}
	got := f.sentencePlacements(t, n2.NoteID)
	if len(got) != 1 || got[0].position != notePos {
		t.Fatalf("placement position %q should equal note position %q", got[0].position, notePos)
	}
	if got[0].position >= f.sentencePlacements(t, n1.NoteID)[0].position {
		t.Fatalf("after moving to slot 0 the placement should sort before the first note")
	}
}

func TestPlacements_MigrateNotesRepointsAndMerges(t *testing.T) {
	f := newITFixture(t)
	_, sids := f.makeDoneMigration(t, "pl-mig-1", "Sentence one is here.", "Sentence two is here.", "Sentence three is here.")
	n := f.createNote(t, sids[0], "carried")
	// A second placement of the SAME note on sentence two (phase 2 will make
	// this reachable from the API; the row shape exists now).
	if err := insertSentencePlacement(f.ctx, f.pool, n.NoteID, sids[1], "a1", sids[1], nil, "", f.username); err != nil {
		t.Fatal(err)
	}

	// Both placements carry to sentence three (a merge): one row survives.
	if _, err := f.db.MigrateNotes(f.ctx, []NoteMigrationItem{{NoteID: n.NoteID, NewSentenceID: sids[2], Confidence: 0.9}}); err != nil {
		t.Fatalf("MigrateNotes: %v", err)
	}
	// MigrateNotes repoints the note's CURRENT legacy sentence (sids[0]); the
	// extra row on sids[1] is a phase-2 concern and must simply survive.
	got := f.sentencePlacements(t, n.NoteID)
	bySentence := map[string]sentencePlacement{}
	for _, p := range got {
		bySentence[p.sentenceID] = p
	}
	if _, stillThere := bySentence[sids[0]]; stillThere {
		t.Fatalf("old placement should be retired: %+v", got)
	}
	moved, ok := bySentence[sids[2]]
	if !ok {
		t.Fatalf("placement should now be on sentence three: %+v", got)
	}
	if moved.confidence == nil || *moved.confidence != 0.9 {
		t.Fatalf("confidence should be recorded on the placement: %+v", moved)
	}
	if len(moved.history) != 1 || moved.history[0] != sids[2] {
		t.Fatalf("history should chain the carry: %+v", moved.history)
	}
	if moved.origin != sids[0] {
		t.Fatalf("origin must stay the sentence the note was made on: %q", moved.origin)
	}
	if _, ok := bySentence[sids[1]]; !ok {
		t.Fatalf("the untouched second placement must survive: %+v", got)
	}

	// Now carry sids[1] onto sids[2] as well — the rows merge, keeping the
	// higher confidence.
	if err := repointSentencePlacement(f.ctx, f.pool, n.NoteID, sids[1], sids[2], 0.5); err != nil {
		t.Fatal(err)
	}
	got = f.sentencePlacements(t, n.NoteID)
	if len(got) != 1 || got[0].sentenceID != sids[2] || got[0].confidence == nil || *got[0].confidence != 0.9 {
		t.Fatalf("merge should leave one row on sentence three at confidence 0.9: %+v", got)
	}
	// Parity with the legacy column the phase-1 readers use.
	if sid := f.noteSentenceID(t, n.NoteID); sid == nil || *sid != sids[2] {
		t.Fatalf("legacy sentence_id should be sentence three, got %v", sid)
	}
}

func TestPlacements_ReconcileRepairsDriftAndIsIdempotent(t *testing.T) {
	f := newITFixture(t)
	_, sids := f.makeDoneMigration(t, "pl-recon", "A sentence to drift from.")
	n := f.createNote(t, sids[0], "drifted")
	pad, err := f.db.CreateScratchpad(f.ctx, f.username, "Drift pad")
	if err != nil {
		t.Fatal(err)
	}
	pn := f.createPadNote(t, pad.ScratchpadID, "pad drifted")
	// The pad doc references pn (so the reconcile must keep it live) and the
	// sentence note too (a paste), which has no pad row yet.
	if err := f.db.UpdateScratchpad(f.ctx, pad.ScratchpadID, "Drift pad", padDoc(pn.NoteID, n.NoteID)); err != nil {
		t.Fatal(err)
	}
	// Simulate the dual-write window: the previous container wrote the notes
	// without junction rows.
	if _, err := f.pool.Exec(f.ctx, `DELETE FROM note_sentence WHERE note_id = $1`, n.NoteID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(f.ctx, `DELETE FROM note_scratchpad WHERE note_id IN ($1, $2)`, pn.NoteID, n.NoteID); err != nil {
		t.Fatal(err)
	}

	s, p, pads, err := f.db.ReconcileNotePlacements(f.ctx)
	if err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if s < 1 || p < 1 || pads < 1 {
		t.Fatalf("reconcile should have added rows and synced pads: s=%d p=%d pads=%d", s, p, pads)
	}
	got := f.sentencePlacements(t, n.NoteID)
	if len(got) != 1 || got[0].sentenceID != sids[0] || got[0].origin != sids[0] {
		t.Fatalf("sentence placement should be rebuilt from the column + version 1: %+v", got)
	}
	pp := f.padPlacements(t, pad.ScratchpadID)
	if removed, ok := pp[pn.NoteID]; !ok || removed {
		t.Fatalf("pad note should be live again (the doc holds it): %v", pp)
	}
	if removed, ok := pp[n.NoteID]; !ok || removed {
		t.Fatalf("the pasted sentence note should get a live pad row from the doc: %v", pp)
	}

	// Second run: nothing new to add for these notes.
	before := f.sentencePlacements(t, n.NoteID)
	if _, _, _, err := f.db.ReconcileNotePlacements(f.ctx); err != nil {
		t.Fatalf("reconcile 2: %v", err)
	}
	after := f.sentencePlacements(t, n.NoteID)
	if fmt.Sprint(before) != fmt.Sprint(after) {
		t.Fatalf("reconcile must be idempotent: %v → %v", before, after)
	}

	// Parity check the deploy uses.
	c, err := f.db.CountNotePlacements(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	if c.SentencePlacements < c.LegacySentenceNotes || c.ScratchpadPlacements < c.LegacyPadNotes {
		t.Fatalf("after reconcile every legacy home must have a placement: %+v", c)
	}
}
