package database

// AREA 2 §2.4 "Home/daily/task-types/actions/rules" — rows #57–#72.
// (#73/#74, the pure rule-engine functions, live in dailyrules_test.go.)

import (
	"testing"
	"time"
)

// #57: context resolution for the landing grid — scratchpad title, manuscript
// display-name fallback (repo basename, .git stripped), sketch-home pad
// subselect, json_agg tags, and the limit.
func TestListNotesForHome_ContextResolution(t *testing.T) {
	f := newITFixture(t)

	// Manuscript with a display name.
	named := f.newManuscript(t, "test://home57/named-repo.git")
	if _, err := f.pool.Exec(f.ctx,
		`UPDATE manuscript SET display_name = 'Named Book' WHERE manuscript_id = $1`,
		named.ManuscriptID); err != nil {
		t.Fatalf("display name: %v", err)
	}
	// Manuscript with no display name → repo basename minus .git.
	bare := f.newManuscript(t, "test://home57/bare-repo.git")

	pad, err := f.db.CreateScratchpad(f.ctx, f.username, "The Pad Title")
	if err != nil {
		t.Fatalf("pad: %v", err)
	}

	padNote := f.createPadNote(t, pad.ScratchpadID, "pad note")
	if err := f.db.AddTagToNote(f.ctx, padNote.NoteID, "zeta", f.username); err != nil {
		t.Fatalf("tag 1: %v", err)
	}
	if err := f.db.AddTagToNote(f.ctx, padNote.NoteID, "alpha", f.username); err != nil {
		t.Fatalf("tag 2: %v", err)
	}

	// Free notes linked to each manuscript (via SQL — the create paths that
	// stamp manuscript_id need sentences, irrelevant here).
	mkFree := func(body string, manuscriptID int) int {
		var id int
		if err := f.pool.QueryRow(f.ctx, `
			INSERT INTO note (user_id, color, body, priority, position, manuscript_id)
			VALUES ($1, 'yellow', $2, 'none', 'a0000', $3)
			RETURNING note_id
		`, f.username, body, manuscriptID).Scan(&id); err != nil {
			t.Fatalf("insert free note: %v", err)
		}
		return id
	}
	namedNote := mkFree("named ms note", named.ManuscriptID)
	bareNote := mkFree("bare ms note", bare.ManuscriptID)

	// A sketch note (no pad of its own): its card deep-links to the sketch's
	// HOME pad — the earliest variation that has a scratchpad.
	homePad, err := f.db.CreateScratchpad(f.ctx, f.username, "Sketch Home Pad")
	if err != nil {
		t.Fatalf("home pad: %v", err)
	}
	sketchID := "tsk57aaaa"
	if _, err := f.pool.Exec(f.ctx,
		`INSERT INTO sketch (sketch_id, user_id) VALUES ($1, $2)`, sketchID, f.username); err != nil {
		t.Fatalf("sketch: %v", err)
	}
	// Variation A has no pad; variation B has one → B's pad is the home.
	if _, err := f.pool.Exec(f.ctx,
		`INSERT INTO variation (sketch_id, ordinal, text) VALUES ($1, 1, 'no pad')`, sketchID); err != nil {
		t.Fatalf("variation A: %v", err)
	}
	if _, err := f.pool.Exec(f.ctx,
		`INSERT INTO variation (sketch_id, ordinal, text, scratchpad_id) VALUES ($1, 2, 'padded', $2)`,
		sketchID, homePad.ScratchpadID); err != nil {
		t.Fatalf("variation B: %v", err)
	}
	var sketchNoteID int
	if err := f.pool.QueryRow(f.ctx, `
		INSERT INTO note (user_id, color, body, priority, position, sketch_id)
		VALUES ($1, 'yellow', 'sketch note', 'none', 'a0000', $2)
		RETURNING note_id
	`, f.username, sketchID).Scan(&sketchNoteID); err != nil {
		t.Fatalf("sketch note: %v", err)
	}

	// Filtered noise.
	gone := f.createPadNote(t, pad.ScratchpadID, "deleted")
	if err := f.db.SoftDeleteNote(f.ctx, gone.NoteID); err != nil {
		t.Fatalf("delete: %v", err)
	}

	notes, err := f.db.ListNotesForHome(f.ctx, f.username, 50)
	if err != nil {
		t.Fatalf("ListNotesForHome: %v", err)
	}
	byID := map[int]HomeNote{}
	for _, h := range notes {
		byID[h.NoteID] = h
	}
	if len(notes) != 4 {
		t.Fatalf("got %d notes, want 4 (deleted filtered): %+v", len(notes), notes)
	}

	if h := byID[padNote.NoteID]; h.ScratchpadTitle != "The Pad Title" {
		t.Errorf("pad note title = %q", h.ScratchpadTitle)
	} else if len(h.Tags) != 2 || h.Tags[0].TagName != "alpha" || h.Tags[1].TagName != "zeta" {
		t.Errorf("pad note tags = %+v, want name-ordered [alpha zeta]", h.Tags)
	}
	if h := byID[namedNote]; h.Context != "Named Book" {
		t.Errorf("named context = %q, want display name", h.Context)
	}
	if h := byID[bareNote]; h.Context != "bare-repo" {
		t.Errorf("bare context = %q, want repo basename minus .git", h.Context)
	}
	h := byID[sketchNoteID]
	if h.SketchID == nil || *h.SketchID != sketchID {
		t.Errorf("sketch id = %v", h.SketchID)
	}
	if h.ScratchpadID == nil || *h.ScratchpadID != homePad.ScratchpadID {
		t.Errorf("sketch note pad = %v, want home pad %d", h.ScratchpadID, homePad.ScratchpadID)
	}

	// Limit + updated_at DESC ordering.
	top, err := f.db.ListNotesForHome(f.ctx, f.username, 1)
	if err != nil {
		t.Fatalf("limit: %v", err)
	}
	if len(top) != 1 {
		t.Fatalf("limit ignored: %d rows", len(top))
	}
	if top[0].NoteID != sketchNoteID {
		t.Errorf("most recently touched = %d, want the last-created %d", top[0].NoteID, sketchNoteID)
	}
}

// #58: same seed → same order; created-today excluded; completed-today
// retained (with done_today set); non-tasks excluded.
func TestListDailyTaskNotes_Determinism(t *testing.T) {
	f := newITFixture(t)
	taskType := f.newTaskType(t, true)
	nonTask := f.newTaskType(t, false)
	dayStart := time.Now().Add(-1 * time.Hour)

	mkNote := func(body, tt string) int {
		var id int
		if err := f.pool.QueryRow(f.ctx, `
			INSERT INTO note (user_id, color, body, priority, position, manuscript_id, task_type)
			VALUES ($1, 'yellow', $2, 'none', 'a0000', $3, NULLIF($4, ''))
			RETURNING note_id
		`, f.username, body, f.manuscriptID, tt).Scan(&id); err != nil {
			t.Fatalf("insert note: %v", err)
		}
		return id
	}
	backdate := func(id int) {
		if _, err := f.pool.Exec(f.ctx,
			`UPDATE note SET created_at = $2 WHERE note_id = $1`,
			id, dayStart.Add(-24*time.Hour)); err != nil {
			t.Fatalf("backdate %d: %v", id, err)
		}
	}

	eligible1 := mkNote("task 1", taskType)
	eligible2 := mkNote("task 2", taskType)
	eligible3 := mkNote("task 3", taskType)
	createdToday := mkNote("brand new", taskType)
	nonTaskNote := mkNote("categorized only", nonTask)
	untyped := mkNote("untyped", "")
	completedToday := mkNote("done today", taskType)
	completedYesterday := mkNote("done yesterday", taskType)
	pointsToday := mkNote("worked today", taskType)

	for _, id := range []int{eligible1, eligible2, eligible3, nonTaskNote, untyped,
		completedToday, completedYesterday, pointsToday} {
		backdate(id)
	}
	if _, err := f.pool.Exec(f.ctx,
		`UPDATE note SET completed_at = NOW() WHERE note_id = $1`, completedToday); err != nil {
		t.Fatalf("complete today: %v", err)
	}
	if _, err := f.pool.Exec(f.ctx,
		`UPDATE note SET completed_at = $2 WHERE note_id = $1`,
		completedYesterday, dayStart.Add(-12*time.Hour)); err != nil {
		t.Fatalf("complete yesterday: %v", err)
	}
	if err := f.db.ScorePoints(f.ctx, pointsToday, 3); err != nil {
		t.Fatalf("points: %v", err)
	}

	first, err := f.db.ListDailyTaskNotes(f.ctx, f.username, f.manuscriptID, "seed-2026-08-17", dayStart)
	if err != nil {
		t.Fatalf("list 1: %v", err)
	}
	second, err := f.db.ListDailyTaskNotes(f.ctx, f.username, f.manuscriptID, "seed-2026-08-17", dayStart)
	if err != nil {
		t.Fatalf("list 2: %v", err)
	}
	if len(first) != len(second) {
		t.Fatalf("non-deterministic length: %d vs %d", len(first), len(second))
	}
	for i := range first {
		if first[i].NoteID != second[i].NoteID {
			t.Fatalf("same seed produced different order at %d: %d vs %d", i, first[i].NoteID, second[i].NoteID)
		}
	}

	got := map[int]HomeNote{}
	for _, h := range first {
		got[h.NoteID] = h
	}
	for _, id := range []int{eligible1, eligible2, eligible3} {
		if _, ok := got[id]; !ok {
			t.Errorf("eligible task %d missing", id)
		}
	}
	if _, ok := got[createdToday]; ok {
		t.Error("created-today note must be excluded")
	}
	if _, ok := got[nonTaskNote]; ok {
		t.Error("non-task type must be excluded")
	}
	if _, ok := got[untyped]; ok {
		t.Error("untyped note must be excluded")
	}
	if _, ok := got[completedYesterday]; ok {
		t.Error("completed-before-today note must be excluded")
	}
	if h, ok := got[completedToday]; !ok {
		t.Error("completed-today note must be RETAINED for the checkmark")
	} else if !h.DoneToday {
		t.Error("completed-today note must have done_today")
	}
	if h, ok := got[pointsToday]; !ok {
		t.Error("points-today note missing")
	} else if !h.DoneToday {
		t.Error("points-today note must have done_today")
	}
	if h := got[eligible1]; h.DoneToday {
		t.Error("untouched task must not have done_today")
	}
}

// #59: completed (and deleted) notes are invisible to GetNoteByID.
func TestGetNoteByID_ExcludesCompleted(t *testing.T) {
	f := newITFixture(t)
	_, sids := f.makeDoneMigration(t, "c59", "A sentence.")

	active := f.createNote(t, sids[0], "active")
	got, err := f.db.GetNoteByID(f.ctx, active.NoteID)
	if err != nil {
		t.Fatalf("get active: %v", err)
	}
	if got == nil || got.NoteID != active.NoteID {
		t.Errorf("active note = %+v", got)
	}

	if err := f.db.CompleteNote(f.ctx, active.NoteID); err != nil {
		t.Fatalf("complete: %v", err)
	}
	got, err = f.db.GetNoteByID(f.ctx, active.NoteID)
	if err != nil {
		t.Fatalf("get completed: %v", err)
	}
	if got != nil {
		t.Errorf("completed note visible: %+v", got)
	}

	deleted := f.createNote(t, sids[0], "deleted")
	if err := f.db.SoftDeleteNote(f.ctx, deleted.NoteID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	got, err = f.db.GetNoteByID(f.ctx, deleted.NoteID)
	if err != nil {
		t.Fatalf("get deleted: %v", err)
	}
	if got != nil {
		t.Errorf("deleted note visible: %+v", got)
	}
}

// #60: linking and unlinking (nil clears) the manuscript context.
func TestSetNoteManuscript_LinkUnlink(t *testing.T) {
	f := newITFixture(t)
	pad, err := f.db.CreateScratchpad(f.ctx, f.username, "pad 60")
	if err != nil {
		t.Fatalf("pad: %v", err)
	}
	note := f.createPadNote(t, pad.ScratchpadID, "free note")

	if err := f.db.SetNoteManuscript(f.ctx, note.NoteID, &f.manuscriptID); err != nil {
		t.Fatalf("link: %v", err)
	}
	var stored *int
	if err := f.pool.QueryRow(f.ctx,
		`SELECT manuscript_id FROM note WHERE note_id = $1`, note.NoteID).Scan(&stored); err != nil {
		t.Fatalf("read: %v", err)
	}
	if stored == nil || *stored != f.manuscriptID {
		t.Errorf("linked = %v, want %d", stored, f.manuscriptID)
	}

	if err := f.db.SetNoteManuscript(f.ctx, note.NoteID, nil); err != nil {
		t.Fatalf("unlink: %v", err)
	}
	if err := f.pool.QueryRow(f.ctx,
		`SELECT manuscript_id FROM note WHERE note_id = $1`, note.NoteID).Scan(&stored); err != nil {
		t.Fatalf("read 2: %v", err)
	}
	if stored != nil {
		t.Errorf("nil should clear the link, got %d", *stored)
	}
}

// #61: soft-deleted types ARE returned (clients still need their metadata),
// ordered by (position, name).
func TestListTaskTypes_IncludesSoftDeleted(t *testing.T) {
	f := newITFixture(t)
	live := f.newTaskType(t, true)
	dead := f.newTaskType(t, false)
	if _, err := f.db.DeleteTaskType(f.ctx, dead); err != nil {
		t.Fatalf("delete: %v", err)
	}

	all, err := f.db.ListTaskTypes(f.ctx)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	var gotLive, gotDead *TaskType
	for i := range all {
		switch all[i].Name {
		case live:
			gotLive = &all[i]
		case dead:
			gotDead = &all[i]
		}
	}
	if gotLive == nil || gotLive.Deleted || !gotLive.IsTask {
		t.Errorf("live type = %+v", gotLive)
	}
	if gotDead == nil {
		t.Fatal("soft-deleted type missing from the list")
	}
	if !gotDead.Deleted || gotDead.IsTask {
		t.Errorf("dead type = %+v, want deleted non-task", gotDead)
	}

	// (position, name) order: pin two of MY rows to one position and check the
	// name tiebreak; the global table may hold e2e rows at other positions.
	a := f.reserveTaskTypeName() // reserve BOTH names first so a < b sorts is known
	b := f.reserveTaskTypeName()
	if a > b {
		a, b = b, a
	}
	if err := f.db.AddTaskTypes(f.ctx, []string{b, a}, true); err != nil {
		t.Fatalf("add pair: %v", err)
	}
	if _, err := f.pool.Exec(f.ctx,
		`UPDATE task_type SET position = 999999 WHERE name IN ($1, $2)`, a, b); err != nil {
		t.Fatalf("pin positions: %v", err)
	}
	all, err = f.db.ListTaskTypes(f.ctx)
	if err != nil {
		t.Fatalf("list 2: %v", err)
	}
	idxA, idxB := -1, -1
	for i := range all {
		switch all[i].Name {
		case a:
			idxA = i
		case b:
			idxB = i
		}
	}
	if idxA == -1 || idxB == -1 || idxA > idxB {
		t.Errorf("equal-position types not name-ordered: %s@%d %s@%d", a, idxA, b, idxB)
	}
}

// #62: live duplicates are skipped; re-adding a soft-deleted name REVIVES the
// same row in the NEW category; fresh names append to the manual order.
func TestAddTaskTypes_ReviveSoftDeleted(t *testing.T) {
	f := newITFixture(t)

	name := f.newTaskType(t, true)
	// Live dup with the opposite category: skipped (category unchanged).
	if err := f.db.AddTaskTypes(f.ctx, []string{name}, false); err != nil {
		t.Fatalf("live dup: %v", err)
	}
	isTask, err := f.db.TaskTypeIsTask(f.ctx, name)
	if err != nil {
		t.Fatalf("is task: %v", err)
	}
	if !isTask {
		t.Error("live duplicate re-add must not change the category")
	}

	// Soft-delete, then re-add in the OTHER category: revived, new category.
	if _, err := f.db.DeleteTaskType(f.ctx, name); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if err := f.db.AddTaskTypes(f.ctx, []string{name}, false); err != nil {
		t.Fatalf("revive: %v", err)
	}
	var deleted, isTaskNow bool
	if err := f.pool.QueryRow(f.ctx,
		`SELECT deleted, is_task FROM task_type WHERE name = $1`, name).Scan(&deleted, &isTaskNow); err != nil {
		t.Fatalf("read: %v", err)
	}
	if deleted {
		t.Error("revived type still deleted")
	}
	if isTaskNow {
		t.Error("revived type kept the OLD category, want the new one")
	}

	// Fresh adds append: later add → higher position.
	first := f.newTaskType(t, true)
	second := f.newTaskType(t, true)
	var p1, p2 int
	if err := f.pool.QueryRow(f.ctx, `SELECT position FROM task_type WHERE name = $1`, first).Scan(&p1); err != nil {
		t.Fatalf("read p1: %v", err)
	}
	if err := f.pool.QueryRow(f.ctx, `SELECT position FROM task_type WHERE name = $1`, second).Scan(&p2); err != nil {
		t.Fatalf("read p2: %v", err)
	}
	if !(p2 > p1) {
		t.Errorf("append order broken: %d then %d", p1, p2)
	}
}

// #63: soft delete reports true once, false thereafter and for absent names.
func TestDeleteTaskType_SoftAndReports(t *testing.T) {
	f := newITFixture(t)
	name := f.newTaskType(t, true)

	ok, err := f.db.DeleteTaskType(f.ctx, name)
	if err != nil || !ok {
		t.Fatalf("delete = (%v, %v), want (true, nil)", ok, err)
	}
	// Row still exists (soft).
	var deleted bool
	if err := f.pool.QueryRow(f.ctx,
		`SELECT deleted FROM task_type WHERE name = $1`, name).Scan(&deleted); err != nil {
		t.Fatalf("row gone — delete must be soft: %v", err)
	}
	if !deleted {
		t.Error("deleted flag not set")
	}

	ok, err = f.db.DeleteTaskType(f.ctx, name)
	if err != nil || ok {
		t.Errorf("second delete = (%v, %v), want (false, nil)", ok, err)
	}
	ok, err = f.db.DeleteTaskType(f.ctx, "tt-never-existed")
	if err != nil || ok {
		t.Errorf("absent delete = (%v, %v), want (false, nil)", ok, err)
	}
}

// #64: positions follow the given list; omitted names keep their old position.
func TestSetTaskTypeOrder_OmittedKeepPosition(t *testing.T) {
	f := newITFixture(t)
	a := f.newTaskType(t, true)
	b := f.newTaskType(t, true)
	c := f.newTaskType(t, true)

	var cPosBefore int
	if err := f.pool.QueryRow(f.ctx, `SELECT position FROM task_type WHERE name = $1`, c).Scan(&cPosBefore); err != nil {
		t.Fatalf("read c: %v", err)
	}

	if err := f.db.SetTaskTypeOrder(f.ctx, []string{b, a}); err != nil {
		t.Fatalf("set order: %v", err)
	}
	pos := func(name string) int {
		var p int
		if err := f.pool.QueryRow(f.ctx, `SELECT position FROM task_type WHERE name = $1`, name).Scan(&p); err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		return p
	}
	if pos(b) != 1 || pos(a) != 2 {
		t.Errorf("order = (b=%d, a=%d), want (1, 2)", pos(b), pos(a))
	}
	if pos(c) != cPosBefore {
		t.Errorf("omitted type moved: %d → %d", cPosBefore, pos(c))
	}
}

// #65: "" is never a task; soft-deleted types still answer; unknown → false.
func TestTaskTypeIsTask_EmptyAndDeleted(t *testing.T) {
	f := newITFixture(t)

	got, err := f.db.TaskTypeIsTask(f.ctx, "")
	if err != nil || got {
		t.Errorf("empty = (%v, %v), want (false, nil)", got, err)
	}

	task := f.newTaskType(t, true)
	nonTask := f.newTaskType(t, false)
	if got, _ := f.db.TaskTypeIsTask(f.ctx, task); !got {
		t.Error("task type should answer true")
	}
	if got, _ := f.db.TaskTypeIsTask(f.ctx, nonTask); got {
		t.Error("non-task type should answer false")
	}

	if _, err := f.db.DeleteTaskType(f.ctx, task); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if got, _ := f.db.TaskTypeIsTask(f.ctx, task); !got {
		t.Error("soft-deleted task type must STILL answer true (notes may carry it)")
	}

	if got, err := f.db.TaskTypeIsTask(f.ctx, "tt-never-existed"); err != nil || got {
		t.Errorf("unknown = (%v, %v), want (false, nil)", got, err)
	}
}

// #66: reports false on a missing type, true + write on a real one.
func TestSetTaskTypeColor_Reports(t *testing.T) {
	f := newITFixture(t)
	name := f.newTaskType(t, true)

	ok, err := f.db.SetTaskTypeColor(f.ctx, name, "blue")
	if err != nil || !ok {
		t.Fatalf("set = (%v, %v), want (true, nil)", ok, err)
	}
	var color string
	if err := f.pool.QueryRow(f.ctx, `SELECT color FROM task_type WHERE name = $1`, name).Scan(&color); err != nil {
		t.Fatalf("read: %v", err)
	}
	if color != "blue" {
		t.Errorf("color = %q", color)
	}

	ok, err = f.db.SetTaskTypeColor(f.ctx, "tt-never-existed", "red")
	if err != nil || ok {
		t.Errorf("missing = (%v, %v), want (false, nil)", ok, err)
	}
}

// #67: the three-source UNION with newest-first order, the 300-char body
// clamp, deleted point events excluded, and the limit.
func TestListNoteActions_UnionOrderingAndClamp(t *testing.T) {
	f := newITFixture(t)
	_, sids := f.makeDoneMigration(t, "c67", "A sentence.")

	longBody := make([]byte, 400)
	for i := range longBody {
		longBody[i] = 'x'
	}
	pointsNote := f.createNote(t, sids[0], string(longBody))
	if err := f.db.ScorePoints(f.ctx, pointsNote.NoteID, 5); err != nil {
		t.Fatalf("points: %v", err)
	}
	// A deleted point event: invisible.
	if err := f.db.ScorePoints(f.ctx, pointsNote.NoteID, 9); err != nil {
		t.Fatalf("points 2: %v", err)
	}
	if _, err := f.pool.Exec(f.ctx, `
		UPDATE point_event SET deleted_at = NOW() WHERE note_id = $1 AND points = 9
	`, pointsNote.NoteID); err != nil {
		t.Fatalf("delete event: %v", err)
	}

	deletedNote := f.createNote(t, sids[0], "deleted note")
	if err := f.db.SoftDeleteNote(f.ctx, deletedNote.NoteID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	completedNote := f.createNote(t, sids[0], "completed note")
	if err := f.db.CompleteNote(f.ctx, completedNote.NoteID); err != nil {
		t.Fatalf("complete: %v", err)
	}

	// Space the three actions out so the DESC order is deterministic:
	// points (oldest) < deleted < completed (newest).
	if _, err := f.pool.Exec(f.ctx,
		`UPDATE point_event SET scored_at = NOW() - interval '2 hours' WHERE note_id = $1 AND deleted_at IS NULL`,
		pointsNote.NoteID); err != nil {
		t.Fatalf("age points: %v", err)
	}
	if _, err := f.pool.Exec(f.ctx,
		`UPDATE note SET deleted_at = NOW() - interval '1 hour' WHERE note_id = $1`,
		deletedNote.NoteID); err != nil {
		t.Fatalf("age deleted: %v", err)
	}

	actions, err := f.db.ListNoteActions(f.ctx, f.username, 50)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(actions) != 3 {
		t.Fatalf("got %d actions, want 3 (deleted event filtered): %+v", len(actions), actions)
	}
	if actions[0].Kind != "completed" || actions[1].Kind != "deleted" || actions[2].Kind != "points" {
		t.Errorf("order = [%s %s %s], want [completed deleted points]",
			actions[0].Kind, actions[1].Kind, actions[2].Kind)
	}
	p := actions[2]
	if p.Points == nil || *p.Points != 5 || p.EventID == nil {
		t.Errorf("points row = %+v", p)
	}
	if len(p.Body) != 300 {
		t.Errorf("body clamped to %d chars, want 300", len(p.Body))
	}

	// Limit keeps the newest.
	top, err := f.db.ListNoteActions(f.ctx, f.username, 1)
	if err != nil {
		t.Fatalf("limit: %v", err)
	}
	if len(top) != 1 || top[0].Kind != "completed" {
		t.Errorf("limited = %+v", top)
	}
}

// #68: point-event edits enforce ownership via the event's note.
func TestDeleteUpdatePointEvent_OwnershipViaNote(t *testing.T) {
	f := newITFixture(t)
	other := f.newUser(t)
	_, sids := f.makeDoneMigration(t, "c68", "A sentence.")
	note := f.createNote(t, sids[0], "task")
	if err := f.db.ScorePoints(f.ctx, note.NoteID, 5); err != nil {
		t.Fatalf("points: %v", err)
	}
	var eventID int
	if err := f.pool.QueryRow(f.ctx,
		`SELECT point_event_id FROM point_event WHERE note_id = $1`, note.NoteID).Scan(&eventID); err != nil {
		t.Fatalf("event id: %v", err)
	}

	// Wrong user: both report false, nothing changes.
	ok, err := f.db.UpdatePointEvent(f.ctx, eventID, other, 42)
	if err != nil || ok {
		t.Errorf("other's update = (%v, %v), want (false, nil)", ok, err)
	}
	ok, err = f.db.DeletePointEvent(f.ctx, eventID, other)
	if err != nil || ok {
		t.Errorf("other's delete = (%v, %v), want (false, nil)", ok, err)
	}

	ok, err = f.db.UpdatePointEvent(f.ctx, eventID, f.username, 42)
	if err != nil || !ok {
		t.Fatalf("my update = (%v, %v), want (true, nil)", ok, err)
	}
	var points int
	if err := f.pool.QueryRow(f.ctx,
		`SELECT points FROM point_event WHERE point_event_id = $1`, eventID).Scan(&points); err != nil {
		t.Fatalf("read: %v", err)
	}
	if points != 42 {
		t.Errorf("points = %d, want 42", points)
	}

	ok, err = f.db.DeletePointEvent(f.ctx, eventID, f.username)
	if err != nil || !ok {
		t.Fatalf("my delete = (%v, %v), want (true, nil)", ok, err)
	}
	var count int
	if err := f.pool.QueryRow(f.ctx,
		`SELECT count(*) FROM point_event WHERE point_event_id = $1`, eventID).Scan(&count); err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 0 {
		t.Error("delete must be HARD (unaward undo)")
	}
	// Missing event: false.
	ok, err = f.db.DeletePointEvent(f.ctx, eventID, f.username)
	if err != nil || ok {
		t.Errorf("re-delete = (%v, %v), want (false, nil)", ok, err)
	}
}

// #69: restore/uncomplete succeed only on a note that is deleted/completed
// AND owned by the caller.
func TestRestoreUncompleteNote_OwnershipAndState(t *testing.T) {
	f := newITFixture(t)
	other := f.newUser(t)
	_, sids := f.makeDoneMigration(t, "c69", "A sentence.")

	note := f.createNote(t, sids[0], "cycled")

	// Not deleted yet → restore false. Not completed → uncomplete false.
	if ok, err := f.db.RestoreNote(f.ctx, note.NoteID, f.username); err != nil || ok {
		t.Errorf("restore live = (%v, %v), want (false, nil)", ok, err)
	}
	if ok, err := f.db.UncompleteNote(f.ctx, note.NoteID, f.username); err != nil || ok {
		t.Errorf("uncomplete live = (%v, %v), want (false, nil)", ok, err)
	}

	if err := f.db.SoftDeleteNote(f.ctx, note.NoteID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if ok, err := f.db.RestoreNote(f.ctx, note.NoteID, other); err != nil || ok {
		t.Errorf("other's restore = (%v, %v), want (false, nil)", ok, err)
	}
	if ok, err := f.db.RestoreNote(f.ctx, note.NoteID, f.username); err != nil || !ok {
		t.Fatalf("my restore = (%v, %v), want (true, nil)", ok, err)
	}
	if got, _ := f.db.GetNoteByID(f.ctx, note.NoteID); got == nil {
		t.Error("restored note should be visible again")
	}

	if err := f.db.CompleteNote(f.ctx, note.NoteID); err != nil {
		t.Fatalf("complete: %v", err)
	}
	if ok, err := f.db.UncompleteNote(f.ctx, note.NoteID, other); err != nil || ok {
		t.Errorf("other's uncomplete = (%v, %v), want (false, nil)", ok, err)
	}
	if ok, err := f.db.UncompleteNote(f.ctx, note.NoteID, f.username); err != nil || !ok {
		t.Fatalf("my uncomplete = (%v, %v), want (true, nil)", ok, err)
	}
	if got, _ := f.db.GetNoteByID(f.ctx, note.NoteID); got == nil {
		t.Error("uncompleted note should be visible again")
	}
}

// #70: events are grouped by LOCAL day in the given timezone (a UTC instant
// after midnight UTC can belong to the previous local day), deleted events
// are excluded, and the full history comes back oldest-first.
func TestListDailyPoints_TZGrouping(t *testing.T) {
	f := newITFixture(t)
	_, sids := f.makeDoneMigration(t, "c70", "A sentence.")
	note := f.createNote(t, sids[0], "task")

	addEvent := func(points int, at string) int {
		var id int
		if err := f.pool.QueryRow(f.ctx, `
			INSERT INTO point_event (note_id, points, scored_at) VALUES ($1, $2, $3::timestamptz)
			RETURNING point_event_id
		`, note.NoteID, points, at).Scan(&id); err != nil {
			t.Fatalf("event: %v", err)
		}
		return id
	}
	// 2026-01-02 03:00 UTC = Jan 1 22:00 in New York → local day Jan 1.
	addEvent(2, "2026-01-02T03:00:00Z")
	// Same UTC date, but Jan 2 in local time.
	addEvent(5, "2026-01-02T17:00:00Z")
	addEvent(1, "2026-01-02T18:00:00Z")
	// Deleted: excluded.
	dead := addEvent(100, "2026-01-02T18:30:00Z")
	if _, err := f.pool.Exec(f.ctx,
		`UPDATE point_event SET deleted_at = NOW() WHERE point_event_id = $1`, dead); err != nil {
		t.Fatalf("kill event: %v", err)
	}

	days, err := f.db.ListDailyPoints(f.ctx, f.username, "America/New_York")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(days) != 2 {
		t.Fatalf("got %d days, want 2: %+v", len(days), days)
	}
	if days[0].Date != "2026-01-01" || days[0].Points != 2 {
		t.Errorf("day 0 = %+v, want 2026-01-01 = 2 (midnight-adjacent shifts back a day)", days[0])
	}
	if days[1].Date != "2026-01-02" || days[1].Points != 6 {
		t.Errorf("day 1 = %+v, want 2026-01-02 = 6 (summed, deleted excluded)", days[1])
	}
}

// #71: moving an action to another day preserves its LOCAL time-of-day for
// all three kinds, across a DST offset change, and enforces ownership.
func TestSetNoteActionDate_PreservesTimeOfDay(t *testing.T) {
	f := newITFixture(t)
	other := f.newUser(t)
	const tz = "America/New_York"
	_, sids := f.makeDoneMigration(t, "c71", "A sentence.")

	// points: winter instant (EST, UTC-5) moved to a summer date (EDT, UTC-4).
	note := f.createNote(t, sids[0], "task")
	var eventID int
	if err := f.pool.QueryRow(f.ctx, `
		INSERT INTO point_event (note_id, points, scored_at)
		VALUES ($1, 5, '2026-01-15T17:45:00Z') RETURNING point_event_id
	`, note.NoteID).Scan(&eventID); err != nil {
		t.Fatalf("event: %v", err)
	}
	// 17:45Z in January = 12:45 EST.
	ok, err := f.db.SetNoteActionDate(f.ctx, f.username, "points", eventID, "2026-07-04", tz)
	if err != nil || !ok {
		t.Fatalf("move points = (%v, %v), want (true, nil)", ok, err)
	}
	var localTime, utcInstant string
	if err := f.pool.QueryRow(f.ctx, `
		SELECT to_char(scored_at AT TIME ZONE $2, 'YYYY-MM-DD HH24:MI:SS'),
		       to_char(scored_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
		FROM point_event WHERE point_event_id = $1
	`, eventID, tz).Scan(&localTime, &utcInstant); err != nil {
		t.Fatalf("read: %v", err)
	}
	if localTime != "2026-07-04 12:45:00" {
		t.Errorf("local = %q, want 2026-07-04 12:45:00 (time-of-day preserved across DST)", localTime)
	}
	if utcInstant != "2026-07-04 16:45:00" {
		t.Errorf("utc = %q, want 16:45 (EDT offset, not EST)", utcInstant)
	}

	// deleted / completed kinds (id = note_id).
	deletedNote := f.createNote(t, sids[0], "deleted")
	if err := f.db.SoftDeleteNote(f.ctx, deletedNote.NoteID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := f.pool.Exec(f.ctx,
		`UPDATE note SET deleted_at = '2026-06-10T16:30:00Z' WHERE note_id = $1`, deletedNote.NoteID); err != nil {
		t.Fatalf("pin deleted_at: %v", err)
	}
	ok, err = f.db.SetNoteActionDate(f.ctx, f.username, "deleted", deletedNote.NoteID, "2026-06-01", tz)
	if err != nil || !ok {
		t.Fatalf("move deleted = (%v, %v)", ok, err)
	}
	var deletedLocal string
	if err := f.pool.QueryRow(f.ctx, `
		SELECT to_char(deleted_at AT TIME ZONE $2, 'YYYY-MM-DD HH24:MI:SS') FROM note WHERE note_id = $1
	`, deletedNote.NoteID, tz).Scan(&deletedLocal); err != nil {
		t.Fatalf("read deleted: %v", err)
	}
	if deletedLocal != "2026-06-01 12:30:00" {
		t.Errorf("deleted local = %q, want 2026-06-01 12:30:00", deletedLocal)
	}

	completedNote := f.createNote(t, sids[0], "completed")
	if err := f.db.CompleteNote(f.ctx, completedNote.NoteID); err != nil {
		t.Fatalf("complete: %v", err)
	}
	ok, err = f.db.SetNoteActionDate(f.ctx, f.username, "completed", completedNote.NoteID, "2026-06-02", tz)
	if err != nil || !ok {
		t.Fatalf("move completed = (%v, %v)", ok, err)
	}
	var completedDay string
	if err := f.pool.QueryRow(f.ctx, `
		SELECT to_char(completed_at AT TIME ZONE $2, 'YYYY-MM-DD') FROM note WHERE note_id = $1
	`, completedNote.NoteID, tz).Scan(&completedDay); err != nil {
		t.Fatalf("read completed: %v", err)
	}
	if completedDay != "2026-06-02" {
		t.Errorf("completed day = %q", completedDay)
	}

	// Ownership + invalid kind.
	if ok, err := f.db.SetNoteActionDate(f.ctx, other, "deleted", deletedNote.NoteID, "2026-06-03", tz); err != nil || ok {
		t.Errorf("other's move = (%v, %v), want (false, nil)", ok, err)
	}
	if _, err := f.db.SetNoteActionDate(f.ctx, f.username, "bogus", deletedNote.NoteID, "2026-06-03", tz); err == nil {
		t.Error("invalid kind must error")
	}
}

// #72: rules list with aggregated (sorted) tags, '{}' → empty for tagless
// rules, positions append in creation order, delete reports ownership. Also
// PINS the reviewed quirk: CreateDailyRule creates tags on the POOL from
// inside its tx (a rollback would orphan them).
func TestListCreateDeleteDailyRules_TagsAggregated(t *testing.T) {
	f := newITFixture(t)
	other := f.newUser(t)
	taskType := f.newTaskType(t, true)

	// Tagged rule with every selector set.
	if err := f.db.CreateDailyRule(f.ctx, f.username, DailyRule{
		TaskType: &taskType, Priority: strPtr("must"), Impact: strPtr("chapter"),
		Color: strPtr("red"), Blocked: boolPtr(false), MaxPerDay: 2,
		Tags: []string{"zeta-rule", "alpha-rule"},
	}); err != nil {
		t.Fatalf("create 1: %v", err)
	}
	// Bare wildcard rule, no tags, unlimited.
	if err := f.db.CreateDailyRule(f.ctx, f.username, DailyRule{MaxPerDay: -1}); err != nil {
		t.Fatalf("create 2: %v", err)
	}

	rules, err := f.db.ListDailyRules(f.ctx, f.username)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(rules) != 2 {
		t.Fatalf("got %d rules, want 2", len(rules))
	}
	first, second := rules[0], rules[1]
	if first.TaskType == nil || *first.TaskType != taskType || first.MaxPerDay != 2 {
		t.Errorf("first rule = %+v (position order should be creation order)", first)
	}
	if len(first.Tags) != 2 || first.Tags[0] != "alpha-rule" || first.Tags[1] != "zeta-rule" {
		t.Errorf("tags = %v, want sorted [alpha-rule zeta-rule]", first.Tags)
	}
	if first.Blocked == nil || *first.Blocked {
		t.Errorf("blocked = %v, want false (tri-state, not nil)", first.Blocked)
	}
	if second.TaskType != nil || second.Priority != nil || len(second.Tags) != 0 || second.MaxPerDay != -1 {
		t.Errorf("wildcard rule = %+v, want all-nil selectors, empty tags, -1", second)
	}

	// Pinned quirk: the rule's tag rows were minted via GetOrCreateTag on the
	// pool (outside the rule tx).
	if tag, err := f.db.GetOrCreateTag(f.ctx, "alpha-rule", f.username); err != nil || tag == nil {
		t.Errorf("rule tag should exist in the user's tag namespace: (%+v, %v)", tag, err)
	}

	// Delete: ownership enforced, reports existence.
	if ok, err := f.db.DeleteDailyRule(f.ctx, other, first.RuleID); err != nil || ok {
		t.Errorf("other's delete = (%v, %v), want (false, nil)", ok, err)
	}
	if ok, err := f.db.DeleteDailyRule(f.ctx, f.username, first.RuleID); err != nil || !ok {
		t.Fatalf("my delete = (%v, %v), want (true, nil)", ok, err)
	}
	if ok, err := f.db.DeleteDailyRule(f.ctx, f.username, first.RuleID); err != nil || ok {
		t.Errorf("re-delete = (%v, %v), want (false, nil)", ok, err)
	}
	rules, err = f.db.ListDailyRules(f.ctx, f.username)
	if err != nil {
		t.Fatalf("list 2: %v", err)
	}
	if len(rules) != 1 || rules[0].RuleID != second.RuleID {
		t.Errorf("after delete: %+v", rules)
	}
}
