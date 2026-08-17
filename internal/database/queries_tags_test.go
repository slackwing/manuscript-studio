package database

// AREA 2 §2.4 "Tags, reorder, users/access" — rows #47–#56. (The former
// PENDING-FIX skip on #52's cross-user leg is enabled — ReorderNote is now
// user-scoped and derives the sentence from the note row.)

import (
	"testing"
)

// #47: tags are namespaced per user — the same name is a distinct row per
// owner, and re-resolving returns the same row. (Note: GetOrCreateTag has no
// ON CONFLICT — a concurrent create of the same (user, name) hits the
// uq_tag_name_user unique index and errors rather than retrying. Documented
// here; not simulated.)
func TestGetOrCreateTag_PerUserNamespace(t *testing.T) {
	f := newITFixture(t)
	other := f.newUser(t)

	mine, err := f.db.GetOrCreateTag(f.ctx, "idea", f.username)
	if err != nil {
		t.Fatalf("create mine: %v", err)
	}
	theirs, err := f.db.GetOrCreateTag(f.ctx, "idea", other)
	if err != nil {
		t.Fatalf("create theirs: %v", err)
	}
	if mine.TagID == theirs.TagID {
		t.Errorf("same tag row shared across users: %d", mine.TagID)
	}
	if mine.UserID != f.username || theirs.UserID != other {
		t.Errorf("owners = (%s, %s)", mine.UserID, theirs.UserID)
	}

	again, err := f.db.GetOrCreateTag(f.ctx, "idea", f.username)
	if err != nil {
		t.Fatalf("re-get: %v", err)
	}
	if again.TagID != mine.TagID {
		t.Errorf("re-get minted a new row: %d → %d", mine.TagID, again.TagID)
	}
}

// #48: double-add is a no-op (idempotent), and creates the tag if missing.
func TestAddTagToNote_Idempotent(t *testing.T) {
	f := newITFixture(t)
	_, sids := f.makeDoneMigration(t, "c48", "A sentence.")
	note := f.createNote(t, sids[0], "tagged")

	if err := f.db.AddTagToNote(f.ctx, note.NoteID, "twice", f.username); err != nil {
		t.Fatalf("add 1: %v", err)
	}
	if err := f.db.AddTagToNote(f.ctx, note.NoteID, "twice", f.username); err != nil {
		t.Fatalf("add 2: %v", err)
	}
	tags, err := f.db.GetTagsForNote(f.ctx, note.NoteID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if len(tags) != 1 || tags[0].TagName != "twice" {
		t.Errorf("tags = %+v, want exactly one 'twice'", tags)
	}
}

// #49: removing a tag that isn't on the note errors.
func TestRemoveTagFromNote_MissingErrors(t *testing.T) {
	f := newITFixture(t)
	_, sids := f.makeDoneMigration(t, "c49", "A sentence.")
	note := f.createNote(t, sids[0], "tagged")

	if err := f.db.AddTagToNote(f.ctx, note.NoteID, "present", f.username); err != nil {
		t.Fatalf("add: %v", err)
	}
	tags, _ := f.db.GetTagsForNote(f.ctx, note.NoteID)
	if len(tags) != 1 {
		t.Fatalf("setup: %+v", tags)
	}
	if err := f.db.RemoveTagFromNote(f.ctx, note.NoteID, tags[0].TagID); err != nil {
		t.Fatalf("remove: %v", err)
	}
	err := f.db.RemoveTagFromNote(f.ctx, note.NoteID, tags[0].TagID)
	if err == nil {
		t.Fatal("second remove must error")
	}
	if err.Error() != "tag not found on note" {
		t.Errorf("error = %q", err)
	}
}

// #50: counts exclude deleted notes but INCLUDE completed ones (pinning the
// current, surprising behavior), ranked most-common first.
func TestListTagCounts_DeletedExcluded_CompletedIncluded(t *testing.T) {
	f := newITFixture(t)
	_, sids := f.makeDoneMigration(t, "c50", "A sentence.")

	active1 := f.createNote(t, sids[0], "a1")
	active2 := f.createNote(t, sids[0], "a2")
	completed := f.createNote(t, sids[0], "done")
	deleted := f.createNote(t, sids[0], "gone")

	for _, n := range []int{active1.NoteID, active2.NoteID} {
		if err := f.db.AddTagToNote(f.ctx, n, "common", f.username); err != nil {
			t.Fatalf("tag: %v", err)
		}
	}
	if err := f.db.AddTagToNote(f.ctx, completed.NoteID, "kept", f.username); err != nil {
		t.Fatalf("tag completed: %v", err)
	}
	if err := f.db.AddTagToNote(f.ctx, deleted.NoteID, "dropped", f.username); err != nil {
		t.Fatalf("tag deleted: %v", err)
	}
	if err := f.db.CompleteNote(f.ctx, completed.NoteID); err != nil {
		t.Fatalf("complete: %v", err)
	}
	if err := f.db.SoftDeleteNote(f.ctx, deleted.NoteID); err != nil {
		t.Fatalf("delete: %v", err)
	}

	counts, err := f.db.ListTagCounts(f.ctx, f.username)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	got := map[string]int{}
	for _, c := range counts {
		got[c.TagName] = c.Count
	}
	if got["common"] != 2 {
		t.Errorf("common = %d, want 2", got["common"])
	}
	if got["kept"] != 1 {
		t.Errorf("completed note's tag must still count (current behavior), got %d", got["kept"])
	}
	if _, ok := got["dropped"]; ok {
		t.Error("deleted note's tag must not count")
	}
	if len(counts) > 0 && counts[0].TagName != "common" {
		t.Errorf("ranked order broken: first = %+v", counts[0])
	}
}

// #51: tags come back in name order.
func TestGetTagsForNote_NameOrder(t *testing.T) {
	f := newITFixture(t)
	_, sids := f.makeDoneMigration(t, "c51", "A sentence.")
	note := f.createNote(t, sids[0], "tagged")

	for _, name := range []string{"zebra", "apple", "mango"} {
		if err := f.db.AddTagToNote(f.ctx, note.NoteID, name, f.username); err != nil {
			t.Fatalf("add %s: %v", name, err)
		}
	}
	tags, err := f.db.GetTagsForNote(f.ctx, note.NoteID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if len(tags) != 3 || tags[0].TagName != "apple" || tags[1].TagName != "mango" || tags[2].TagName != "zebra" {
		t.Errorf("tags = %+v, want [apple mango zebra]", tags)
	}
}

// #52 (behavior leg): reorder computes a fractional position for the target
// slot within the sentence's active notes.
func TestReorderNote_FractionalTargetSlot(t *testing.T) {
	f := newITFixture(t)
	_, sids := f.makeDoneMigration(t, "c52", "A sentence.")

	a := f.createNote(t, sids[0], "a")
	b := f.createNote(t, sids[0], "b")
	c := f.createNote(t, sids[0], "c")

	// Move c to the front.
	if err := f.db.ReorderNote(f.ctx, c.NoteID, 0); err != nil {
		t.Fatalf("reorder: %v", err)
	}
	notes, err := f.db.GetNotesBySentence(f.ctx, sids[0], f.username)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	gotOrder := []int{}
	for _, n := range notes {
		gotOrder = append(gotOrder, n.NoteID)
	}
	want := []int{c.NoteID, a.NoteID, b.NoteID}
	for i := range want {
		if gotOrder[i] != want[i] {
			t.Fatalf("order = %v, want %v", gotOrder, want)
		}
	}

	// Move c between a and b (index 1 of [c a b] target list semantics: the
	// slot positions come from the CURRENT list) — must land between them.
	if err := f.db.ReorderNote(f.ctx, c.NoteID, 2); err != nil {
		t.Fatalf("reorder 2: %v", err)
	}
	notes, err = f.db.GetNotesBySentence(f.ctx, sids[0], f.username)
	if err != nil {
		t.Fatalf("get 2: %v", err)
	}
	if notes[0].NoteID != a.NoteID || notes[1].NoteID != c.NoteID || notes[2].NoteID != b.NoteID {
		t.Errorf("order after mid-move = [%d %d %d], want [a c b] = [%d %d %d]",
			notes[0].NoteID, notes[1].NoteID, notes[2].NoteID, a.NoteID, c.NoteID, b.NoteID)
	}
}

// #52 (scope leg, fixed): ReorderNote's position list used to span ALL
// users' notes on the sentence while every visible list is user-scoped — in
// a multi-user manuscript the target index was computed against the wrong
// array. It now scopes to the note owner's active notes (and derives the
// sentence from the note row, not the request body).
func TestReorderNote_UserScopedPositions(t *testing.T) {
	f := newITFixture(t)
	other := f.newUser(t)
	_, sids := f.makeDoneMigration(t, "c52b", "A shared sentence.")

	// The other user's note holds the lexicographically smallest position.
	theirs := f.createNoteAs(t, other, sids[0], "theirs")
	mineA := f.createNote(t, sids[0], "mine a")
	mineB := f.createNote(t, sids[0], "mine b")
	_ = theirs

	// Index 1 over MY list [mineA, mineB] = between them → the new position
	// must sort AFTER mineA's. (Unscoped, index 1 of [theirs, mineA, mineB]
	// lands BEFORE mineA.)
	if err := f.db.ReorderNote(f.ctx, mineB.NoteID, 1); err != nil {
		t.Fatalf("reorder: %v", err)
	}
	var posA, posB string
	if err := f.pool.QueryRow(f.ctx, `SELECT position FROM note WHERE note_id = $1`, mineA.NoteID).Scan(&posA); err != nil {
		t.Fatalf("read a: %v", err)
	}
	if err := f.pool.QueryRow(f.ctx, `SELECT position FROM note WHERE note_id = $1`, mineB.NoteID).Scan(&posB); err != nil {
		t.Fatalf("read b: %v", err)
	}
	if !(posB > posA) {
		t.Errorf("index 1 in MY list must sort after my first note: got %q vs %q (computed against the unscoped list)", posB, posA)
	}
}

// #53: (nil, nil) on a missing user.
func TestGetUserByUsername_NilOnMissing(t *testing.T) {
	f := newITFixture(t)

	u, err := f.db.GetUserByUsername(f.ctx, "no-such-user-ever")
	if err != nil {
		t.Fatalf("err = %v, want nil", err)
	}
	if u != nil {
		t.Errorf("u = %+v, want nil", u)
	}

	u, err = f.db.GetUserByUsername(f.ctx, f.username)
	if err != nil {
		t.Fatalf("fixture user: %v", err)
	}
	if u == nil || u.Username != f.username || u.Role != "author" {
		t.Errorf("u = %+v", u)
	}
}

// #54: access list is name-ordered; HasManuscriptAccess is an EXISTS check.
func TestGetHasManuscriptAccess(t *testing.T) {
	f := newITFixture(t)

	for _, name := range []string{"zz-test-ms", "aa-test-ms"} {
		if _, err := f.pool.Exec(f.ctx, `
			INSERT INTO manuscript_access (username, manuscript_name) VALUES ($1, $2)
		`, f.username, name); err != nil {
			t.Fatalf("grant %s: %v", name, err)
		}
	}

	access, err := f.db.GetManuscriptAccessForUser(f.ctx, f.username)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(access) != 2 || access[0].ManuscriptName != "aa-test-ms" || access[1].ManuscriptName != "zz-test-ms" {
		t.Errorf("access = %+v, want name order [aa-test-ms zz-test-ms]", access)
	}

	has, err := f.db.HasManuscriptAccess(f.ctx, f.username, "aa-test-ms")
	if err != nil || !has {
		t.Errorf("granted access = (%v, %v), want (true, nil)", has, err)
	}
	has, err = f.db.HasManuscriptAccess(f.ctx, f.username, "never-granted")
	if err != nil || has {
		t.Errorf("ungranted access = (%v, %v), want (false, nil)", has, err)
	}
}

// #55: NULL column → ""; missing user → "" (no error); set-then-get round-trips.
func TestGetSetLastManuscriptName_NullHandling(t *testing.T) {
	f := newITFixture(t)

	last, err := f.db.GetLastManuscriptName(f.ctx, f.username)
	if err != nil {
		t.Fatalf("get fresh: %v", err)
	}
	if last != "" {
		t.Errorf("fresh user last = %q, want \"\"", last)
	}

	last, err = f.db.GetLastManuscriptName(f.ctx, "no-such-user-ever")
	if err != nil {
		t.Fatalf("get missing: %v", err)
	}
	if last != "" {
		t.Errorf("missing user last = %q, want \"\"", last)
	}

	if err := f.db.SetLastManuscriptName(f.ctx, f.username, "the-book"); err != nil {
		t.Fatalf("set: %v", err)
	}
	last, err = f.db.GetLastManuscriptName(f.ctx, f.username)
	if err != nil {
		t.Fatalf("get after set: %v", err)
	}
	if last != "the-book" {
		t.Errorf("last = %q, want the-book", last)
	}
}

// #56: the 0 sentinel that drives 404s.
func TestGetMigrationIDForSentence_ZeroOnMissing(t *testing.T) {
	f := newITFixture(t)
	migID, sids := f.makeDoneMigration(t, "c56", "A sentence.")

	got, err := f.db.GetMigrationIDForSentence(f.ctx, sids[0])
	if err != nil {
		t.Fatalf("existing: %v", err)
	}
	if got != migID {
		t.Errorf("migration id = %d, want %d", got, migID)
	}

	got, err = f.db.GetMigrationIDForSentence(f.ctx, "no-such-sentence")
	if err != nil {
		t.Fatalf("missing: %v", err)
	}
	if got != 0 {
		t.Errorf("missing sentence = %d, want 0", got)
	}
}
