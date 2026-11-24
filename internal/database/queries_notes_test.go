package database

// AREA 2 §2.4 "Notes & versions" — rows #30–#46. (The former PENDING-FIX
// skips #36, #37 race leg, #46 column leg are enabled — their fixes landed.)

import (
	"sync"
	"testing"

	"github.com/slackwing/manuscript-studio/internal/models"
)

// #30: user/deleted/completed filters plus (sentence ordinal, position) order,
// with tags loaded.
func TestGetNotesByCommit_FiltersAndOrders(t *testing.T) {
	f := newITFixture(t)
	other := f.newUser(t)
	_, sids := f.makeDoneMigration(t, "commit-30", "First sentence.", "Second sentence.")

	// Two active notes on the SECOND sentence (created first, so ordinal must
	// drive the ordering, not creation time), one on the first.
	s2a := f.createNote(t, sids[1], "s2 first")
	s2b := f.createNote(t, sids[1], "s2 second")
	s1a := f.createNote(t, sids[0], "s1 only")

	// Noise that must be filtered: other user's, deleted, completed.
	f.createNoteAs(t, other, sids[0], "not mine")
	deleted := f.createNote(t, sids[0], "deleted")
	if err := f.db.SoftDeleteNote(f.ctx, deleted.NoteID); err != nil {
		t.Fatalf("soft delete: %v", err)
	}
	completed := f.createNote(t, sids[0], "completed")
	if err := f.db.CompleteNote(f.ctx, completed.NoteID); err != nil {
		t.Fatalf("complete: %v", err)
	}

	if err := f.db.AddTagToNote(f.ctx, s1a.NoteID, "tag-30", f.username); err != nil {
		t.Fatalf("tag: %v", err)
	}

	notes, err := f.db.GetNotesByCommit(f.ctx, "commit-30", f.username)
	if err != nil {
		t.Fatalf("GetNotesByCommit: %v", err)
	}
	if len(notes) != 3 {
		t.Fatalf("got %d notes, want 3 (mine + active only)", len(notes))
	}
	wantOrder := []int{s1a.NoteID, s2a.NoteID, s2b.NoteID}
	for i, want := range wantOrder {
		if notes[i].NoteID != want {
			t.Errorf("order[%d] = note %d, want %d", i, notes[i].NoteID, want)
		}
	}
	if len(notes[0].Tags) != 1 || notes[0].Tags[0].TagName != "tag-30" {
		t.Errorf("tags not loaded: %+v", notes[0].Tags)
	}
}

// #31: no notes → a non-nil empty slice (encodes as [] not null); with notes,
// position order.
func TestGetNotesBySentence_EmptyIsJSONArray(t *testing.T) {
	f := newITFixture(t)
	_, sids := f.makeDoneMigration(t, "c31", "Lonely sentence.", "Busy sentence.")

	empty, err := f.db.GetNotesBySentence(f.ctx, sids[0], f.username)
	if err != nil {
		t.Fatalf("empty: %v", err)
	}
	if empty == nil {
		t.Error("no-notes result must be a non-nil slice (JSON [] not null)")
	}
	if len(empty) != 0 {
		t.Errorf("len = %d, want 0", len(empty))
	}

	a := f.createNote(t, sids[1], "first")
	b := f.createNote(t, sids[1], "second")
	notes, err := f.db.GetNotesBySentence(f.ctx, sids[1], f.username)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if len(notes) != 2 || notes[0].NoteID != a.NoteID || notes[1].NoteID != b.NoteID {
		t.Errorf("position order broken: %+v", notes)
	}
}

// #34: CreateNote writes version 1 with the sentence's commit/migration as
// origin, and stamps the note's manuscript_id.
func TestCreateNote_FirstVersionAndOrigin(t *testing.T) {
	f := newITFixture(t)
	migID, sids := f.makeDoneMigration(t, "c34", "The annotated sentence.")

	body := "the note"
	note := &models.Note{
		SentenceID: sids[0], UserID: f.username, Color: "yellow",
		Body: &body, Priority: "none", TaskType: "", Impact: "n/a",
	}
	version := &models.NoteVersion{}
	if err := f.db.CreateNote(f.ctx, note, version); err != nil {
		t.Fatalf("CreateNote: %v", err)
	}

	if version.Version != 1 {
		t.Errorf("first version = %d, want 1", version.Version)
	}
	if version.OriginSentenceID != sids[0] || version.OriginCommitHash != "c34" {
		t.Errorf("origin = (%s, %s), want (%s, c34)", version.OriginSentenceID, version.OriginCommitHash, sids[0])
	}
	if version.OriginMigrationID == nil || *version.OriginMigrationID != migID {
		t.Errorf("origin migration = %v, want %d", version.OriginMigrationID, migID)
	}
	if note.ManuscriptID == nil || *note.ManuscriptID != f.manuscriptID {
		t.Errorf("manuscript stamp = %v, want %d", note.ManuscriptID, f.manuscriptID)
	}
	if f.noteVersionCount(t, note.NoteID) != 1 {
		t.Errorf("version rows = %d, want 1", f.noteVersionCount(t, note.NoteID))
	}
	var storedManuscript *int
	if err := f.pool.QueryRow(f.ctx,
		`SELECT manuscript_id FROM note WHERE note_id = $1`, note.NoteID).Scan(&storedManuscript); err != nil {
		t.Fatalf("read: %v", err)
	}
	if storedManuscript == nil || *storedManuscript != f.manuscriptID {
		t.Errorf("stored manuscript_id = %v, want %d", storedManuscript, f.manuscriptID)
	}
}

// #35: the append-after-max handles ReorderNote's extended-precision
// positions ("a00015") instead of misparsing them as fixed-width.
func TestCreateNote_PositionAfterReorderedMax(t *testing.T) {
	f := newITFixture(t)
	_, sids := f.makeDoneMigration(t, "c35", "A sentence.")

	first := f.createNote(t, sids[0], "first")
	// Positions live on the PLACEMENT (NOTE_PLACEMENTS_PLAN.md phase 2).
	if _, err := f.pool.Exec(f.ctx,
		`UPDATE note_sentence SET position = 'a00015' WHERE note_id = $1`, first.NoteID); err != nil {
		t.Fatalf("set fractional position: %v", err)
	}

	second := f.createNote(t, sids[0], "second")
	if !(second.Position > "a00015") {
		t.Errorf("new position %q does not sort after the fractional max a00015", second.Position)
	}
}

// #36 (fixed): CreateNote's manuscript-stamp step used to swallow the lookup
// error (`if err == nil { ... }` silently skipped the stamp). Semantics now
// enforced: a sentence note ALWAYS comes out stamped with its manuscript, or
// the create fails loudly (notes.go CreateNote fails the tx).
func TestCreateNote_ManuscriptStampNeverSilentlySkipped(t *testing.T) {
	f := newITFixture(t)
	_, sids := f.makeDoneMigration(t, "c36", "A sentence.")

	body := "stamped"
	note := &models.Note{
		SentenceID: sids[0], UserID: f.username, Color: "yellow",
		Body: &body, Priority: "none", TaskType: "", Impact: "n/a",
	}
	if err := f.db.CreateNote(f.ctx, note, &models.NoteVersion{}); err != nil {
		t.Fatalf("CreateNote: %v", err)
	}
	// Post-fix invariant: success implies the stamp happened — both on the
	// returned struct and in the row. (Today a lookup failure would return
	// success with manuscript_id NULL.)
	if note.ManuscriptID == nil || *note.ManuscriptID != f.manuscriptID {
		t.Errorf("returned manuscript stamp = %v, want %d", note.ManuscriptID, f.manuscriptID)
	}
	var stored *int
	if err := f.pool.QueryRow(f.ctx,
		`SELECT manuscript_id FROM note WHERE note_id = $1`, note.NoteID).Scan(&stored); err != nil {
		t.Fatalf("read: %v", err)
	}
	if stored == nil || *stored != f.manuscriptID {
		t.Errorf("stored manuscript stamp = %v, want %d", stored, f.manuscriptID)
	}
}

// A scratchpad note (NOTES_PLAN.md Phase 2) has no sentence; since
// NOTE_PLACEMENTS_PLAN.md phase 2 it still gets CONTENT version 1 — with a
// NULL sentence — like every other note. Pad notes have no position.
func TestCreateScratchpadNote_VersionOneWithoutSentence(t *testing.T) {
	f := newITFixture(t)
	pad, err := f.db.CreateScratchpad(f.ctx, f.username, "pad 38")
	if err != nil {
		t.Fatalf("pad: %v", err)
	}
	a := f.createPadNote(t, pad.ScratchpadID, "first")
	b := f.createPadNote(t, pad.ScratchpadID, "second")
	if a.ScratchpadID == nil || *a.ScratchpadID != pad.ScratchpadID {
		t.Errorf("scratchpad_id = %v, want %d", a.ScratchpadID, pad.ScratchpadID)
	}
	if sid := f.noteSentenceID(t, a.NoteID); sid != nil {
		t.Errorf("sentence_id = %q, want NULL", *sid)
	}
	if f.noteVersionCount(t, a.NoteID) != 1 {
		t.Errorf("scratchpad note has %d version rows, want 1 (content version)", f.noteVersionCount(t, a.NoteID))
	}
	v, err := f.db.GetLatestNoteVersion(f.ctx, a.NoteID)
	if err != nil {
		t.Fatalf("latest: %v", err)
	}
	if v.Version != 1 || v.SentenceID != "" || v.OriginSentenceID != "" || v.Body == nil || *v.Body != "first" {
		t.Errorf("version 1 = %+v, want v1 with no sentence and the body", v)
	}
	if a.Position != "" || b.Position != "" {
		t.Errorf("pad notes have no position (the doc orders them): %q / %q", a.Position, b.Position)
	}
}

// #37 (race leg, fixed): CreateScratchpadNote used to do the MAX(position)
// read-then-insert with neither the createNoteMu mutex nor a tx (vs
// CreateNote) — concurrent creates could mint duplicate positions. It now
// takes the same mutex + tx, so every note in a pad has a distinct position.
func TestCreateScratchpadNote_ConcurrentPositionRace(t *testing.T) {
	f := newITFixture(t)
	pad, err := f.db.CreateScratchpad(f.ctx, f.username, "race pad")
	if err != nil {
		t.Fatalf("CreateScratchpad: %v", err)
	}

	const n = 8
	var wg sync.WaitGroup
	errs := make([]error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			body := "racer"
			note := &models.Note{UserID: f.username, Color: "green", Body: &body,
				Priority: "none", TaskType: "", Impact: "n/a"}
			errs[i] = f.db.CreateScratchpadNote(f.ctx, note, pad.ScratchpadID)
		}(i)
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("create %d: %v", i, err)
		}
	}
	var live int
	if err := f.pool.QueryRow(f.ctx, `
		SELECT count(*) FROM note_scratchpad WHERE scratchpad_id = $1 AND removed_at IS NULL
	`, pad.ScratchpadID).Scan(&live); err != nil {
		t.Fatalf("count: %v", err)
	}
	if live != n {
		t.Errorf("want %d live placements after %d concurrent creates, got %d", n, n, live)
	}
}

// #39 (phase 2 form): each update appends CONTENT version max+1; origin
// fields carry forward from version 1; the sentence-id history is the
// placements' business now and is carried through UNCHANGED by content
// versions (no edit ever "moves" a note).
func TestUpdateNote_AppendsContentVersion(t *testing.T) {
	f := newITFixture(t)
	migID, sids := f.makeDoneMigration(t, "c39", "Sentence A.", "Sentence B.")
	note := f.createNote(t, sids[0], "v1")

	edit := *note
	edit.Body = strPtr("v2")
	edit.Color = "blue"
	v2 := &models.NoteVersion{}
	if err := f.db.UpdateNote(f.ctx, note.NoteID, &edit, v2); err != nil {
		t.Fatalf("update 1: %v", err)
	}
	if v2.Version != 2 {
		t.Errorf("version = %d, want 2", v2.Version)
	}

	again := edit
	again.Priority = "must"
	v3 := &models.NoteVersion{}
	if err := f.db.UpdateNote(f.ctx, note.NoteID, &again, v3); err != nil {
		t.Fatalf("update 2: %v", err)
	}
	if v3.Version != 3 {
		t.Errorf("version = %d, want 3", v3.Version)
	}
	if v3.OriginSentenceID != sids[0] || v3.OriginCommitHash != "c39" {
		t.Errorf("origin drifted: (%s, %s)", v3.OriginSentenceID, v3.OriginCommitHash)
	}
	if v3.OriginMigrationID == nil || *v3.OriginMigrationID != migID {
		t.Errorf("origin migration = %v, want %d", v3.OriginMigrationID, migID)
	}
	if v3.SentenceID != sids[0] {
		t.Errorf("content version carries the primary placement %s, got %s", sids[0], v3.SentenceID)
	}

	latest, err := f.db.GetLatestNoteVersion(f.ctx, note.NoteID)
	if err != nil {
		t.Fatalf("latest: %v", err)
	}
	if len(latest.SentenceIDHistory) != 0 {
		t.Errorf("content versions must not grow the carry history: %v", latest.SentenceIDHistory)
	}
	if latest.Body == nil || *latest.Body != "v2" || latest.Color != "blue" || latest.Priority != "must" {
		t.Errorf("latest fields = (%v, %s, %s)", latest.Body, latest.Color, latest.Priority)
	}
	// The placement is untouched by edits.
	if sid := f.noteSentenceID(t, note.NoteID); sid == nil || *sid != sids[0] {
		t.Errorf("edit moved the note: %v", sid)
	}
}

// #40: a missing note anywhere in the batch rolls back EVERYTHING.
func TestMigrateNotes_AllOrNothing(t *testing.T) {
	f := newITFixture(t)
	_, sids := f.makeDoneMigration(t, "c40a", "Old sentence.")
	_, newSids := f.makeDoneMigration(t, "c40b", "New sentence.")
	note := f.createNote(t, sids[0], "migrates")

	items := []NoteMigrationItem{
		{NoteID: note.NoteID, OldSentenceID: sids[0], NewSentenceID: newSids[0], Confidence: 1.0},
		{NoteID: -12345, OldSentenceID: sids[0], NewSentenceID: newSids[0], Confidence: 1.0},
	}
	n, err := f.db.MigrateNotes(f.ctx, items)
	if err == nil {
		t.Fatal("missing note in batch must error")
	}
	if n != 0 {
		t.Errorf("reported %d migrated on failure, want 0", n)
	}
	if sid := f.noteSentenceID(t, note.NoteID); sid == nil || *sid != sids[0] {
		t.Errorf("first note moved despite rollback: %v", sid)
	}
	if got := f.noteVersionCount(t, note.NoteID); got != 1 {
		t.Errorf("version rows = %d, want 1 (no partial insert)", got)
	}

	// Empty batch is a zero no-op.
	if n, err := f.db.MigrateNotes(f.ctx, nil); n != 0 || err != nil {
		t.Errorf("empty batch = (%d, %v), want (0, nil)", n, err)
	}
}

// #41: a null-sentence (scratchpad) note is never repointed by MigrateNotes —
// the defense-in-depth guard refuses and rolls back.
func TestMigrateNotes_SkipsNullSentenceNotes(t *testing.T) {
	f := newITFixture(t)
	_, newSids := f.makeDoneMigration(t, "c41", "Target sentence.")
	pad, err := f.db.CreateScratchpad(f.ctx, f.username, "pad 41")
	if err != nil {
		t.Fatalf("pad: %v", err)
	}
	padNote := f.createPadNote(t, pad.ScratchpadID, "free note")

	n, err := f.db.MigrateNotes(f.ctx, []NoteMigrationItem{
		{NoteID: padNote.NoteID, NewSentenceID: newSids[0], Confidence: 1.0},
	})
	if err == nil {
		t.Fatal("migrating a null-sentence note must fail, not repoint it")
	}
	if n != 0 {
		t.Errorf("count = %d, want 0", n)
	}
	if sid := f.noteSentenceID(t, padNote.NoteID); sid != nil {
		t.Errorf("scratchpad note was repointed to %q — must stay NULL", *sid)
	}
	if got := f.noteVersionCount(t, padNote.NoteID); got != 1 {
		t.Errorf("version rows = %d, want 1 (content version 1 only)", got)
	}
}

// #42 (phase 2 form): a migration carries the PLACEMENT — new sentence,
// confidence and history on the note_sentence row — and writes NO content
// version; the latest version is still the owner's last edit.
func TestMigrateNotes_CarriesPlacementNotVersions(t *testing.T) {
	f := newITFixture(t)
	_, sids := f.makeDoneMigration(t, "c42a", "Old sentence.")
	_, newSids := f.makeDoneMigration(t, "c42b", "New sentence.")
	note := f.createNote(t, sids[0], "v1 body")

	edit := *note
	edit.Color = "blue"
	edit.Body = strPtr("v2 body")
	edit.Priority = "must"
	if err := f.db.UpdateNote(f.ctx, note.NoteID, &edit, &models.NoteVersion{}); err != nil {
		t.Fatalf("update: %v", err)
	}

	n, err := f.db.MigrateNotes(f.ctx, []NoteMigrationItem{
		{NoteID: note.NoteID, OldSentenceID: sids[0], NewSentenceID: newSids[0], Confidence: 0.87},
	})
	if err != nil {
		t.Fatalf("migrate: %v", err)
	}
	if n != 1 {
		t.Errorf("count = %d, want 1", n)
	}

	var placedOn string
	var conf *float64
	var hist []byte
	if err := f.pool.QueryRow(f.ctx, `
		SELECT sentence_id, migration_confidence, sentence_id_history FROM note_sentence WHERE note_id = $1`,
		note.NoteID).Scan(&placedOn, &conf, &hist); err != nil {
		t.Fatalf("placement: %v", err)
	}
	if placedOn != newSids[0] || conf == nil || *conf != 0.87 || string(hist) != `["`+newSids[0]+`"]` {
		t.Errorf("placement = (%s, %v, %s), want (%s, 0.87, [%s])", placedOn, conf, hist, newSids[0], newSids[0])
	}
	if got := f.noteVersionCount(t, note.NoteID); got != 2 {
		t.Errorf("version rows = %d, want 2 (migrations write none)", got)
	}
	latest, err := f.db.GetLatestNoteVersion(f.ctx, note.NoteID)
	if err != nil {
		t.Fatalf("latest: %v", err)
	}
	if latest.Version != 2 || latest.Color != "blue" || latest.Body == nil || *latest.Body != "v2 body" {
		t.Errorf("latest should still be the owner's edit: v%d %s %v", latest.Version, latest.Color, latest.Body)
	}
	// Legacy column mirrors the (only) placement.
	if sid := f.noteSentenceID(t, note.NoteID); sid == nil || *sid != newSids[0] {
		t.Errorf("legacy sentence_id = %v, want %s", sid, newSids[0])
	}
}

// #43: SoftDeleteNote / CompleteNote error on the second call.
func TestSoftDeleteCompleteNote_IdempotenceErrors(t *testing.T) {
	f := newITFixture(t)
	_, sids := f.makeDoneMigration(t, "c43", "A sentence.")

	del := f.createNote(t, sids[0], "to delete")
	if err := f.db.SoftDeleteNote(f.ctx, del.NoteID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if err := f.db.SoftDeleteNote(f.ctx, del.NoteID); err == nil {
		t.Error("second delete must error")
	}
	// Completing a deleted note also errors (deleted_at IS NULL guard).
	if err := f.db.CompleteNote(f.ctx, del.NoteID); err == nil {
		t.Error("completing a deleted note must error")
	}

	comp := f.createNote(t, sids[0], "to complete")
	if err := f.db.CompleteNote(f.ctx, comp.NoteID); err != nil {
		t.Fatalf("complete: %v", err)
	}
	if err := f.db.CompleteNote(f.ctx, comp.NoteID); err == nil {
		t.Error("second complete must error")
	}

	if err := f.db.SoftDeleteNote(f.ctx, -1); err == nil {
		t.Error("deleting a missing note must error")
	}
}

// #44: ScorePoints writes a point_event row.
func TestScorePoints_WritesEvent(t *testing.T) {
	f := newITFixture(t)
	_, sids := f.makeDoneMigration(t, "c44", "A sentence.")
	note := f.createNote(t, sids[0], "task")

	if err := f.db.ScorePoints(f.ctx, note.NoteID, 7, false); err != nil {
		t.Fatalf("ScorePoints: %v", err)
	}
	var points int
	var deleted *string
	if err := f.pool.QueryRow(f.ctx, `
		SELECT points, deleted_at::text FROM point_event WHERE note_id = $1
	`, note.NoteID).Scan(&points, &deleted); err != nil {
		t.Fatalf("read event: %v", err)
	}
	if points != 7 || deleted != nil {
		t.Errorf("event = (%d, %v), want (7, live)", points, deleted)
	}
}

// #45 (phase 2 form): the latest version is picked and the history JSON
// round-trips — an empty chain stays an empty slice, never a nil crash.
func TestGetLatestNoteVersion_HistoryUnmarshal(t *testing.T) {
	f := newITFixture(t)
	_, sids := f.makeDoneMigration(t, "c45", "Sentence A.", "Sentence B.")
	note := f.createNote(t, sids[0], "v1")

	edit := *note
	edit.Body = strPtr("v2")
	if err := f.db.UpdateNote(f.ctx, note.NoteID, &edit, &models.NoteVersion{}); err != nil {
		t.Fatalf("update: %v", err)
	}

	latest, err := f.db.GetLatestNoteVersion(f.ctx, note.NoteID)
	if err != nil {
		t.Fatalf("GetLatestNoteVersion: %v", err)
	}
	if latest.Version != 2 {
		t.Errorf("version = %d, want 2 (the latest)", latest.Version)
	}
	if latest.SentenceIDHistory == nil || len(latest.SentenceIDHistory) != 0 {
		t.Errorf("history = %v, want an empty (non-nil) chain", latest.SentenceIDHistory)
	}
	if _, err := f.db.GetLatestNoteVersion(f.ctx, -1); err == nil {
		t.Error("missing note should error (no ErrNoRows special case)")
	}
}

// #46 (behavior leg): the batch query returns exactly what per-sentence
// queries return, over the fields both currently select.
func TestGetActiveNotesForSentences_BatchEqualsSingles(t *testing.T) {
	f := newITFixture(t)
	other := f.newUser(t)
	_, sids := f.makeDoneMigration(t, "c46", "First sentence.", "Second sentence.", "Bare sentence.")

	f.createNote(t, sids[0], "note 1")
	f.createNote(t, sids[0], "note 2")
	f.createNoteAs(t, other, sids[1], "someone else's") // active notes are NOT user-filtered here
	gone := f.createNote(t, sids[1], "deleted")
	if err := f.db.SoftDeleteNote(f.ctx, gone.NoteID); err != nil {
		t.Fatalf("delete: %v", err)
	}

	batch, err := f.db.GetActiveNotesForSentences(f.ctx, sids)
	if err != nil {
		t.Fatalf("batch: %v", err)
	}
	if len(batch[sids[0]]) != 2 || len(batch[sids[1]]) != 1 || len(batch[sids[2]]) != 0 {
		t.Errorf("batch shape = {%d %d %d}, want {2 1 0}",
			len(batch[sids[0]]), len(batch[sids[1]]), len(batch[sids[2]]))
	}
	if batch[sids[1]][0].UserID != other {
		t.Errorf("active-note collection must span users, got %q", batch[sids[1]][0].UserID)
	}

	for _, sid := range sids {
		singles, err := f.db.GetActiveNotesForSentence(f.ctx, sid)
		if err != nil {
			t.Fatalf("single %s: %v", sid, err)
		}
		if len(singles) != len(batch[sid]) {
			t.Errorf("sentence %s: batch %d notes, single %d", sid, len(batch[sid]), len(singles))
			continue
		}
		bySingle := map[int]models.Note{}
		for _, n := range singles {
			bySingle[n.NoteID] = n
		}
		for _, bn := range batch[sid] {
			sn, ok := bySingle[bn.NoteID]
			if !ok {
				t.Errorf("note %d in batch but not single", bn.NoteID)
				continue
			}
			if bn.UserID != sn.UserID || bn.Color != sn.Color || bn.Position != sn.Position ||
				(bn.Body == nil) != (sn.Body == nil) || (bn.Body != nil && *bn.Body != *sn.Body) {
				t.Errorf("note %d differs between batch and single: %+v vs %+v", bn.NoteID, bn, sn)
			}
		}
	}

	// Empty input short-circuits.
	empty, err := f.db.GetActiveNotesForSentences(f.ctx, nil)
	if err != nil || len(empty) != 0 {
		t.Errorf("empty input = (%v, %v)", empty, err)
	}
}

// #46 (column leg, fixed): GetActiveNotesForSentence(s) used to OMIT
// manuscript_id and scratchpad_id from their column lists while the other
// three copies selected them. All five readers now share the one noteColumns
// const (notes.go), so a stamped sentence note carries its ManuscriptID
// everywhere.
func TestGetActiveNotesForSentences_ManuscriptColumnsSelected(t *testing.T) {
	f := newITFixture(t)
	_, sids := f.makeDoneMigration(t, "c46b", "A stamped sentence.")
	note := f.createNote(t, sids[0], "stamped note")
	if note.ManuscriptID == nil {
		t.Fatal("fixture note should be manuscript-stamped by CreateNote")
	}

	batch, err := f.db.GetActiveNotesForSentences(f.ctx, sids)
	if err != nil {
		t.Fatalf("batch: %v", err)
	}
	if len(batch[sids[0]]) != 1 {
		t.Fatalf("batch shape: %d", len(batch[sids[0]]))
	}
	got := batch[sids[0]][0]
	if got.ManuscriptID == nil || *got.ManuscriptID != f.manuscriptID {
		t.Errorf("batch ManuscriptID = %v, want %d", got.ManuscriptID, f.manuscriptID)
	}

	singles, err := f.db.GetActiveNotesForSentence(f.ctx, sids[0])
	if err != nil {
		t.Fatalf("single: %v", err)
	}
	if len(singles) != 1 || singles[0].ManuscriptID == nil || *singles[0].ManuscriptID != f.manuscriptID {
		t.Errorf("single ManuscriptID = %+v, want %d", singles, f.manuscriptID)
	}
}

// The pad float sends a task-type patch and the type's recolor as two PUTs a
// millisecond apart. Each must change only its own fields — a whole-row
// read-modify-write lost one of them (test-settings, 2026-11-24).
func TestPatchNote_ConcurrentFieldPatchesBothLand(t *testing.T) {
	f := newITFixture(t)
	_, sids := f.makeDoneMigration(t, "patch-race", "A sentence for a racing note.")
	note := f.createNote(t, sids[0], "race me")

	for round := 0; round < 5; round++ {
		tt, color := "write", "blue"
		if round%2 == 1 {
			tt, color = "hone", "green"
		}
		var wg sync.WaitGroup
		errs := make([]error, 2)
		wg.Add(2)
		go func() {
			defer wg.Done()
			_, errs[0] = f.db.PatchNote(f.ctx, note.NoteID, NotePatch{TaskType: &tt}, &models.NoteVersion{})
		}()
		go func() {
			defer wg.Done()
			_, errs[1] = f.db.PatchNote(f.ctx, note.NoteID, NotePatch{Color: &color}, &models.NoteVersion{})
		}()
		wg.Wait()
		for i, err := range errs {
			if err != nil {
				t.Fatalf("round %d patch %d: %v", round, i, err)
			}
		}
		var gotType, gotColor string
		if err := f.pool.QueryRow(f.ctx, `SELECT COALESCE(task_type, ''), color FROM note WHERE note_id = $1`, note.NoteID).Scan(&gotType, &gotColor); err != nil {
			t.Fatal(err)
		}
		if gotType != tt || gotColor != color {
			t.Fatalf("round %d: want %s/%s, got %s/%s — a patch clobbered the other", round, tt, color, gotType, gotColor)
		}
	}
	// Body: BodySet with nil clears; a patch without BodySet leaves it alone.
	empty := ""
	if _, err := f.db.PatchNote(f.ctx, note.NoteID, NotePatch{BodySet: true, Body: nil}, &models.NoteVersion{}); err != nil {
		t.Fatal(err)
	}
	if got, _ := f.db.GetNoteByID(f.ctx, note.NoteID); got == nil || got.Body != nil {
		t.Fatalf("BodySet+nil should clear the body: %+v", got)
	}
	if _, err := f.db.PatchNote(f.ctx, note.NoteID, NotePatch{Color: &empty}, &models.NoteVersion{}); err == nil {
		t.Fatalf("an empty color must be rejected by the column check")
	}
	var versions int
	f.pool.QueryRow(f.ctx, `SELECT count(*) FROM note_version WHERE note_id = $1`, note.NoteID).Scan(&versions)
	if versions != 1+10+1 {
		t.Fatalf("every patch appends one content version: want 12, got %d", versions)
	}
	if got, err := f.db.PatchNote(f.ctx, 999999999, NotePatch{TaskType: &empty}, &models.NoteVersion{}); err != nil || got != nil {
		t.Fatalf("patching a missing note: want nil,nil got %v,%v", got, err)
	}
}
