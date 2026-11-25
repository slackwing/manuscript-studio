package database

import (
	"testing"
)

// Boards (059, BOARDS_PLAN.md): CRUD, the notes a board shows (own, live,
// uncompleted; manuscripts filter; rules OR'd with per-rule caps), and rule
// scoping between a board and the daily rules.
func TestBoards(t *testing.T) {
	f := newITFixture(t)
	_, sids := f.makeDoneMigration(t, "boards", "A sentence on the book.", "Another one.")
	onBook := f.createNote(t, sids[0], "on the book")
	pad, err := f.db.CreateScratchpad(f.ctx, f.username, "Board pad")
	if err != nil {
		t.Fatal(err)
	}
	inPad := f.createPadNote(t, pad.ScratchpadID, "in a pad, tagged")
	if err := f.db.AddTagToNote(f.ctx, inPad.NoteID, "boardtag", f.username); err != nil {
		t.Fatal(err)
	}
	inPad2 := f.createPadNote(t, pad.ScratchpadID, "in a pad, tagged too")
	if err := f.db.AddTagToNote(f.ctx, inPad2.NoteID, "boardtag", f.username); err != nil {
		t.Fatal(err)
	}
	done := f.createPadNote(t, pad.ScratchpadID, "completed")
	f.pool.Exec(f.ctx, `UPDATE note SET completed_at = now() WHERE note_id = $1`, done.NoteID)
	ids := func(ns []HomeNote) map[int]bool {
		m := map[int]bool{}
		for _, n := range ns {
			m[n.NoteID] = true
		}
		return m
	}

	// ---- CRUD ----
	b, err := f.db.CreateBoard(f.ctx, f.username, "Hone list", nil)
	if err != nil {
		t.Fatal(err)
	}
	if b.Name != "Hone list" || len(b.ManuscriptIDs) != 0 {
		t.Fatalf("created: %+v", b)
	}
	got, _ := f.db.GetBoard(f.ctx, f.username, b.BoardID)
	if got == nil || got.BoardID != b.BoardID {
		t.Fatalf("get: %+v", got)
	}
	if other, _ := f.db.GetBoard(f.ctx, "someone-else", b.BoardID); other != nil {
		t.Fatalf("another user must not see the board")
	}
	name := "Hone list!"
	if upd, err := f.db.UpdateBoard(f.ctx, f.username, b.BoardID, &name, nil); err != nil || upd.Name != name || len(upd.ManuscriptIDs) != 0 {
		t.Fatalf("rename: %+v %v", upd, err)
	}

	// ---- notes: no rules → every own live uncompleted note, newest first ----
	notes, err := f.db.BoardNotes(f.ctx, f.username, b)
	if err != nil {
		t.Fatal(err)
	}
	have := ids(notes)
	if !have[onBook.NoteID] || !have[inPad.NoteID] || !have[inPad2.NoteID] || have[done.NoteID] {
		t.Fatalf("no rules: want the three live notes and not the completed one; got %v", have)
	}

	// ---- manuscripts filter: only the note placed on the book ----
	if _, err := f.db.UpdateBoard(f.ctx, f.username, b.BoardID, nil, []int{f.manuscriptID}); err != nil {
		t.Fatal(err)
	}
	b, _ = f.db.GetBoard(f.ctx, f.username, b.BoardID)
	notes, _ = f.db.BoardNotes(f.ctx, f.username, b)
	if have = ids(notes); len(notes) != 1 || !have[onBook.NoteID] {
		t.Fatalf("manuscript filter: want only the book note, got %v", have)
	}
	// Back to all; a tag rule picks the pad notes; a cap of 1 admits one.
	if _, err := f.db.UpdateBoard(f.ctx, f.username, b.BoardID, nil, []int{}); err != nil {
		t.Fatal(err)
	}
	b, _ = f.db.GetBoard(f.ctx, f.username, b.BoardID)
	bid := b.BoardID
	if err := f.db.CreateDailyRule(f.ctx, f.username, DailyRule{BoardID: &bid, Tags: []string{"boardtag"}, MaxPerDay: -1}); err != nil {
		t.Fatal(err)
	}
	notes, _ = f.db.BoardNotes(f.ctx, f.username, b)
	if have = ids(notes); len(notes) != 2 || !have[inPad.NoteID] || !have[inPad2.NoteID] {
		t.Fatalf("tag rule: want the two tagged pad notes, got %v", have)
	}
	rules, _ := f.db.ListBoardRules(f.ctx, f.username, bid)
	if len(rules) != 1 || rules[0].BoardID == nil || *rules[0].BoardID != bid {
		t.Fatalf("board rules: %+v", rules)
	}
	// The board's rule is NOT a daily rule, and vice versa.
	daily, _ := f.db.ListDailyRules(f.ctx, f.username)
	for _, r := range daily {
		if r.RuleID == rules[0].RuleID {
			t.Fatalf("a board rule leaked into the daily rules")
		}
	}
	if err := f.db.CreateDailyRule(f.ctx, f.username, DailyRule{Tags: []string{"boardtag"}, MaxPerDay: 1}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.pool.Exec(f.ctx, `DELETE FROM daily_rule WHERE user_id = $1`, f.username) })
	if again, _ := f.db.ListBoardRules(f.ctx, f.username, bid); len(again) != 1 {
		t.Fatalf("a daily rule leaked into the board: %d", len(again))
	}
	// Cap: replace the rule with ≤1 → one tagged note shows.
	if ok, _ := f.db.DeleteBoardRule(f.ctx, f.username, bid, rules[0].RuleID); !ok {
		t.Fatalf("delete board rule")
	}
	if ok, _ := f.db.DeleteBoardRule(f.ctx, f.username, bid, rules[0].RuleID); ok {
		t.Fatalf("deleting twice must be a no-op")
	}
	if err := f.db.CreateDailyRule(f.ctx, f.username, DailyRule{BoardID: &bid, Tags: []string{"boardtag"}, MaxPerDay: 1}); err != nil {
		t.Fatal(err)
	}
	notes, _ = f.db.BoardNotes(f.ctx, f.username, b)
	if len(notes) != 1 || !ids(notes)[inPad2.NoteID] {
		t.Fatalf("cap 1: want the newest tagged note only, got %d", len(notes))
	}
	// A daily rule id cannot be deleted through the board route.
	daily, _ = f.db.ListDailyRules(f.ctx, f.username)
	if len(daily) != 1 {
		t.Fatalf("one daily rule expected, got %d", len(daily))
	}
	if ok, _ := f.db.DeleteBoardRule(f.ctx, f.username, bid, daily[0].RuleID); ok {
		t.Fatalf("a daily rule must not be deletable through a board")
	}

	// ---- delete: gone from the list; its rules cascade ----
	if ok, _ := f.db.DeleteBoard(f.ctx, f.username, bid); !ok {
		t.Fatalf("delete board")
	}
	if list, _ := f.db.ListBoards(f.ctx, f.username); func() bool {
		for _, x := range list {
			if x.BoardID == bid {
				return true
			}
		}
		return false
	}() {
		t.Fatalf("deleted board still listed")
	}
}

func TestApplyBoardRules(t *testing.T) {
	s := "write"
	notes := []HomeNote{{NoteID: 1, TaskType: "write"}, {NoteID: 2, TaskType: "hone"}, {NoteID: 3, TaskType: "write"}}
	if got := ApplyBoardRules(nil, notes); len(got) != 3 {
		t.Fatalf("no rules → all: %d", len(got))
	}
	got := ApplyBoardRules([]DailyRule{{TaskType: &s, MaxPerDay: -1}}, notes)
	if len(got) != 2 || got[0].NoteID != 1 || got[1].NoteID != 3 {
		t.Fatalf("type rule: %v", got)
	}
	if got := ApplyBoardRules([]DailyRule{{TaskType: &s, MaxPerDay: 1}}, notes); len(got) != 1 || got[0].NoteID != 1 {
		t.Fatalf("cap 1: %v", got)
	}
	h := "hone"
	if got := ApplyBoardRules([]DailyRule{{TaskType: &s, MaxPerDay: 1}, {TaskType: &h, MaxPerDay: -1}}, notes); len(got) != 2 {
		t.Fatalf("two rules OR: %v", got)
	}
}
