package database

// AREA 2 §2.4 "Notes & versions" — rows #30–#46. (The former PENDING-FIX
// skips #36, #37 race leg, #46 column leg are enabled — their fixes landed.)

import (
	"strings"
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

// #32: origin info aggregates from version 1 even after later versions exist.
func TestGetNoteOriginInfo_MinAggregates(t *testing.T) {
	f := newITFixture(t)
	migID, sids := f.makeDoneMigration(t, "c32", "Origin sentence.", "Moved-to sentence.")
	note := f.createNote(t, sids[0], "note body")

	// Append a version pointing elsewhere.
	moved := *note
	moved.SentenceID = sids[1]
	if err := f.db.UpdateNote(f.ctx, note.NoteID, &moved, &models.NoteVersion{}); err != nil {
		t.Fatalf("update: %v", err)
	}

	tx, err := f.pool.Begin(f.ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer tx.Rollback(f.ctx)
	originSID, originCommit, createdBy, originMigID, err := getNoteOriginInfo(f.ctx, tx, note.NoteID)
	if err != nil {
		t.Fatalf("getNoteOriginInfo: %v", err)
	}
	if originSID != sids[0] {
		t.Errorf("origin sentence = %s, want %s (version 1's)", originSID, sids[0])
	}
	if originCommit != "c32" {
		t.Errorf("origin commit = %s, want c32", originCommit)
	}
	if createdBy != f.username {
		t.Errorf("created_by = %s, want %s", createdBy, f.username)
	}
	if originMigID == nil || *originMigID != migID {
		t.Errorf("origin migration = %v, want %d", originMigID, migID)
	}
}

// #33: history appends onto the stored chain, and CORRUPT stored JSON must
// hard-error — never be silently replaced by a fresh chain (audit invariant).
func TestGetSentenceHistory_AppendsAndRejectsCorrupt(t *testing.T) {
	f := newITFixture(t)
	_, sids := f.makeDoneMigration(t, "c33", "A sentence.")
	note := f.createNote(t, sids[0], "note")

	tx, err := f.pool.Begin(f.ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	historyJSON, err := getSentenceHistory(f.ctx, tx, note.NoteID, 1, "new-sid-1")
	tx.Rollback(f.ctx)
	if err != nil {
		t.Fatalf("getSentenceHistory: %v", err)
	}
	if string(historyJSON) != `["new-sid-1"]` {
		t.Errorf("history = %s, want [\"new-sid-1\"]", historyJSON)
	}

	// Corrupt the stored history (valid jsonb, wrong shape).
	if _, err := f.pool.Exec(f.ctx, `
		UPDATE note_version SET sentence_id_history = '{"not":"a chain"}'::jsonb
		WHERE note_id = $1 AND version = 1
	`, note.NoteID); err != nil {
		t.Fatalf("corrupt: %v", err)
	}
	tx2, err := f.pool.Begin(f.ctx)
	if err != nil {
		t.Fatalf("begin 2: %v", err)
	}
	defer tx2.Rollback(f.ctx)
	_, err = getSentenceHistory(f.ctx, tx2, note.NoteID, 1, "new-sid-2")
	if err == nil {
		t.Fatal("corrupt sentence_id_history must hard-error, not regenerate")
	}
	if !strings.Contains(err.Error(), "corrupt sentence_id_history") {
		t.Errorf("error should name the corruption, got: %v", err)
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
	if _, err := f.pool.Exec(f.ctx,
		`UPDATE note SET position = 'a00015' WHERE note_id = $1`, first.NoteID); err != nil {
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

// #37 (behavior leg): a scratchpad note gets NO note_version row, a per-pad
// position, NULL sentence_id, and inherits manuscript_id only when given.
func TestCreateScratchpadNote_NoVersionRow(t *testing.T) {
	f := newITFixture(t)
	pad, err := f.db.CreateScratchpad(f.ctx, f.username, "pad 37")
	if err != nil {
		t.Fatalf("CreateScratchpad: %v", err)
	}
	otherPad, err := f.db.CreateScratchpad(f.ctx, f.username, "pad 37b")
	if err != nil {
		t.Fatalf("CreateScratchpad 2: %v", err)
	}

	a := f.createPadNote(t, pad.ScratchpadID, "pad note a")
	b := f.createPadNote(t, pad.ScratchpadID, "pad note b")
	c := f.createPadNote(t, otherPad.ScratchpadID, "other pad note")

	if f.noteVersionCount(t, a.NoteID) != 0 {
		t.Errorf("scratchpad note has %d version rows, want 0", f.noteVersionCount(t, a.NoteID))
	}
	if sid := f.noteSentenceID(t, a.NoteID); sid != nil {
		t.Errorf("scratchpad note sentence_id = %q, want NULL", *sid)
	}
	if a.ScratchpadID == nil || *a.ScratchpadID != pad.ScratchpadID {
		t.Errorf("scratchpad_id = %v, want %d", a.ScratchpadID, pad.ScratchpadID)
	}
	// Position is per-pad: b appends after a; a fresh pad starts over.
	if !(b.Position > a.Position) {
		t.Errorf("b position %q must sort after a %q", b.Position, a.Position)
	}
	if c.Position != a.Position {
		t.Errorf("fresh pad should restart positions: got %q, want %q", c.Position, a.Position)
	}
	if a.ManuscriptID != nil {
		t.Errorf("un-linked pad note has manuscript_id %v, want nil", a.ManuscriptID)
	}

	// Inheritance: note.ManuscriptID set by the caller (linked pad) persists.
	body := "inherits"
	linked := &models.Note{
		UserID: f.username, Color: "green", Body: &body,
		Priority: "none", TaskType: "", Impact: "n/a", ManuscriptID: &f.manuscriptID,
	}
	if err := f.db.CreateScratchpadNote(f.ctx, linked, pad.ScratchpadID); err != nil {
		t.Fatalf("linked create: %v", err)
	}
	var stored *int
	if err := f.pool.QueryRow(f.ctx,
		`SELECT manuscript_id FROM note WHERE note_id = $1`, linked.NoteID).Scan(&stored); err != nil {
		t.Fatalf("read: %v", err)
	}
	if stored == nil || *stored != f.manuscriptID {
		t.Errorf("inherited manuscript_id = %v, want %d", stored, f.manuscriptID)
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
	var distinct, total int
	if err := f.pool.QueryRow(f.ctx, `
		SELECT count(DISTINCT position), count(*) FROM note WHERE scratchpad_id = $1
	`, pad.ScratchpadID).Scan(&distinct, &total); err != nil {
		t.Fatalf("count: %v", err)
	}
	if distinct != total {
		t.Errorf("positions collided: %d distinct of %d notes", distinct, total)
	}
}

// #38: the versionless-update guard excludes sentence notes; NULLIF task_type
// and the body CASE behave as designed.
func TestUpdateScratchpadNote_GuardExcludesSentenceNotes(t *testing.T) {
	f := newITFixture(t)
	_, sids := f.makeDoneMigration(t, "c38", "A sentence.")
	sentenceNote := f.createNote(t, sids[0], "sentence note")

	// A sentence note must be unreachable here — zero rows touched.
	if err := f.db.UpdateScratchpadNote(f.ctx, sentenceNote.NoteID,
		strPtr("red"), strPtr("hijacked"), nil, nil, nil, nil); err != nil {
		t.Fatalf("update sentence note: %v", err)
	}
	var color, body string
	if err := f.pool.QueryRow(f.ctx,
		`SELECT color, body FROM note WHERE note_id = $1`, sentenceNote.NoteID).Scan(&color, &body); err != nil {
		t.Fatalf("read: %v", err)
	}
	if color != "yellow" || body != "sentence note" {
		t.Errorf("guard failed: sentence note mutated to (%s, %s)", color, body)
	}

	pad, err := f.db.CreateScratchpad(f.ctx, f.username, "pad 38")
	if err != nil {
		t.Fatalf("pad: %v", err)
	}
	tt := f.newTaskType(t, true)
	padNote := f.createPadNote(t, pad.ScratchpadID, "pad body")

	readNote := func() (color string, body *string, taskType *string, priority string, blocked bool) {
		if err := f.pool.QueryRow(f.ctx,
			`SELECT color, body, task_type, priority, blocked FROM note WHERE note_id = $1`,
			padNote.NoteID).Scan(&color, &body, &taskType, &priority, &blocked); err != nil {
			t.Fatalf("read pad note: %v", err)
		}
		return
	}

	// nil body → body untouched; nil taskType → kept.
	if err := f.db.UpdateScratchpadNote(f.ctx, padNote.NoteID,
		strPtr("blue"), nil, strPtr("must"), nil, nil, boolPtr(true)); err != nil {
		t.Fatalf("update 1: %v", err)
	}
	color2, body2, tt2, prio2, blocked2 := readNote()
	if color2 != "blue" || body2 == nil || *body2 != "pad body" || tt2 != nil || prio2 != "must" || !blocked2 {
		t.Errorf("update 1: got (%s, %v, %v, %s, %v)", color2, body2, tt2, prio2, blocked2)
	}

	// Provided body pointer wins (even to set empty); task type set by name.
	if err := f.db.UpdateScratchpadNote(f.ctx, padNote.NoteID,
		nil, strPtr(""), nil, &tt, nil, nil); err != nil {
		t.Fatalf("update 2: %v", err)
	}
	_, body3, tt3, _, _ := readNote()
	if body3 == nil || *body3 != "" {
		t.Errorf("provided empty body should be written, got %v", body3)
	}
	if tt3 == nil || *tt3 != tt {
		t.Errorf("task_type = %v, want %s", tt3, tt)
	}

	// taskType pointer to "" → NULLIF clears to NULL.
	if err := f.db.UpdateScratchpadNote(f.ctx, padNote.NoteID,
		nil, nil, nil, strPtr(""), nil, nil); err != nil {
		t.Fatalf("update 3: %v", err)
	}
	_, _, tt4, _, _ := readNote()
	if tt4 != nil {
		t.Errorf("task_type = %v, want NULL after empty-string clear", *tt4)
	}
}

// #39: each update appends version max+1, the sentence-id history grows, and
// origin fields carry forward from version 1.
func TestUpdateNote_AppendsVersionWithHistory(t *testing.T) {
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

	moved := edit
	moved.SentenceID = sids[1]
	v3 := &models.NoteVersion{}
	if err := f.db.UpdateNote(f.ctx, note.NoteID, &moved, v3); err != nil {
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

	latest, err := f.db.GetLatestNoteVersion(f.ctx, note.NoteID)
	if err != nil {
		t.Fatalf("latest: %v", err)
	}
	// History: v1 [], v2 [sidA], v3 [sidA, sidB].
	if len(latest.SentenceIDHistory) != 2 ||
		latest.SentenceIDHistory[0] != sids[0] || latest.SentenceIDHistory[1] != sids[1] {
		t.Errorf("history = %v, want [%s %s]", latest.SentenceIDHistory, sids[0], sids[1])
	}
	if latest.Body == nil || *latest.Body != "v2" || latest.Color != "blue" {
		t.Errorf("latest fields = (%v, %s)", latest.Body, latest.Color)
	}
}

// #40: a missing note anywhere in the batch rolls back EVERYTHING.
func TestMigrateNotes_AllOrNothing(t *testing.T) {
	f := newITFixture(t)
	_, sids := f.makeDoneMigration(t, "c40a", "Old sentence.")
	_, newSids := f.makeDoneMigration(t, "c40b", "New sentence.")
	note := f.createNote(t, sids[0], "migrates")

	items := []NoteMigrationItem{
		{NoteID: note.NoteID, NewSentenceID: newSids[0], Confidence: 1.0},
		{NoteID: -12345, NewSentenceID: newSids[0], Confidence: 1.0},
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
	if got := f.noteVersionCount(t, padNote.NoteID); got != 0 {
		t.Errorf("version rows = %d, want 0", got)
	}
}

// #42: the appended migration version copies fields from the LATEST
// note_version, not from the (possibly desynced) head row, and records the
// pairing confidence.
func TestMigrateNotes_VersionFieldsFromLatestVersion(t *testing.T) {
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
	// Desync the head row on purpose.
	if _, err := f.pool.Exec(f.ctx,
		`UPDATE note SET color = 'red', priority = 'can' WHERE note_id = $1`, note.NoteID); err != nil {
		t.Fatalf("desync: %v", err)
	}

	n, err := f.db.MigrateNotes(f.ctx, []NoteMigrationItem{
		{NoteID: note.NoteID, NewSentenceID: newSids[0], Confidence: 0.87},
	})
	if err != nil {
		t.Fatalf("migrate: %v", err)
	}
	if n != 1 {
		t.Errorf("count = %d, want 1", n)
	}

	latest, err := f.db.GetLatestNoteVersion(f.ctx, note.NoteID)
	if err != nil {
		t.Fatalf("latest: %v", err)
	}
	if latest.Version != 3 || latest.SentenceID != newSids[0] {
		t.Errorf("latest = v%d @ %s, want v3 @ %s", latest.Version, latest.SentenceID, newSids[0])
	}
	if latest.Color != "blue" || latest.Priority != "must" || latest.Body == nil || *latest.Body != "v2 body" {
		t.Errorf("fields came from head, not note_version: (%s, %s, %v)", latest.Color, latest.Priority, latest.Body)
	}
	if latest.MigrationConfidence == nil || *latest.MigrationConfidence != 0.87 {
		t.Errorf("confidence = %v, want 0.87", latest.MigrationConfidence)
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

	if err := f.db.ScorePoints(f.ctx, note.NoteID, 7); err != nil {
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

// #45: the latest version is picked and the history JSON round-trips.
func TestGetLatestNoteVersion_HistoryUnmarshal(t *testing.T) {
	f := newITFixture(t)
	_, sids := f.makeDoneMigration(t, "c45", "Sentence A.", "Sentence B.")
	note := f.createNote(t, sids[0], "v1")

	moved := *note
	moved.SentenceID = sids[1]
	if err := f.db.UpdateNote(f.ctx, note.NoteID, &moved, &models.NoteVersion{}); err != nil {
		t.Fatalf("update: %v", err)
	}

	latest, err := f.db.GetLatestNoteVersion(f.ctx, note.NoteID)
	if err != nil {
		t.Fatalf("GetLatestNoteVersion: %v", err)
	}
	if latest.Version != 2 {
		t.Errorf("version = %d, want 2 (the latest)", latest.Version)
	}
	// getSentenceHistory appends the NEW sentence id onto v1's empty chain.
	if len(latest.SentenceIDHistory) != 1 || latest.SentenceIDHistory[0] != sids[1] {
		t.Errorf("history = %v, want [%s]", latest.SentenceIDHistory, sids[1])
	}
	// Version 1's empty history also round-trips (as empty, not nil-crash).
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
