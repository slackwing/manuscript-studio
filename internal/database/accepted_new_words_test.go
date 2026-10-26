package database

import "testing"

// NEW ACCEPTED: words added by the edits accepted RIGHT NOW — on the
// current version, not yet committed. Older versions, pushed edits,
// pending and rejected ones don't count.
func TestAcceptedNewWords_CurrentUncommittedOnly(t *testing.T) {
	f := newITFixture(t)
	_, s1 := f.makeDoneMigration(t, "anw-c1", "The cat sat.", "It was late.", "Leave me be.", "Go now.")
	_, s2 := f.makeDoneMigration(t, "anw-c2", "The cat sat.", "It was late.", "Leave me be.", "Go now.")
	accepted, rejected := "accepted", "rejected"
	put := func(sid, text string, status *string) {
		t.Helper()
		if _, err := f.db.UpsertSuggestion(f.ctx, sid, f.username, text); err != nil {
			t.Fatal(err)
		}
		if status != nil {
			if _, err := f.db.SetSuggestionReview(f.ctx, sid, f.username, status, f.username); err != nil {
				t.Fatal(err)
			}
		}
	}
	put(s1[0], "The cat sat on the mat today.", &accepted) // older version: no
	put(s2[0], "The cat sat on the mat.", &accepted)       // current: +3
	put(s2[1], "Late, it was, truly.", &accepted)          // current, a reorder +1
	put(s2[2], "Leave me alone, please.", nil)             // pending: no
	put(s2[3], "Go now, quickly, everyone.", &rejected)    // rejected: no
	got, err := f.db.AcceptedNewWords(f.ctx, f.manuscriptID)
	if err != nil {
		t.Fatal(err)
	}
	if got != 4 {
		t.Errorf("AcceptedNewWords = %d, want 4 (3 + 1)", got)
	}
	// Once pushed (committed), an edit leaves the count.
	if _, err := f.pool.Exec(f.ctx, `UPDATE suggested_change SET pushed_in_commit = 'abc123' WHERE sentence_id = $1`, s2[0]); err != nil {
		t.Fatal(err)
	}
	if got, _ := f.db.AcceptedNewWords(f.ctx, f.manuscriptID); got != 1 {
		t.Errorf("after pushing one: %d, want 1", got)
	}
}
