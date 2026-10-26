package database

import "testing"

// NEW ACCEPTED: words added by accepted edits, each edit once — a copy a
// migration carried forward isn't counted again.
func TestAcceptedNewWords_CountsEachEditOnce(t *testing.T) {
	f := newITFixture(t)
	_, s1 := f.makeDoneMigration(t, "anw-c1", "The cat sat.", "It was late.", "Leave me be.")
	_, s2 := f.makeDoneMigration(t, "anw-c2", "The cat sat.", "It was late.", "Leave me be.")
	for i := range s2 {
		prev := s1[i]
		if err := f.db.SetPreviousSentenceID(f.ctx, s2[i], &prev); err != nil {
			t.Fatal(err)
		}
	}
	accepted := "accepted"
	rejected := "rejected"
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
	// Edit 1: accepted on m1 and carried (identical) to m2 → counted once: +3.
	put(s1[0], "The cat sat on the mat.", &accepted)
	put(s2[0], "The cat sat on the mat.", &accepted)
	// Edit 2: accepted on m2 only, a reorder → +0... plus one new word: +1.
	put(s2[1], "Late, it was, truly.", &accepted)
	// Not counted: pending, and rejected.
	put(s2[2], "Leave me alone, please.", nil)
	put(s1[2], "Totally different words entirely.", &rejected)
	got, err := f.db.AcceptedNewWords(f.ctx, f.manuscriptID)
	if err != nil {
		t.Fatal(err)
	}
	if got != 4 {
		t.Errorf("AcceptedNewWords = %d, want 4 (3 + 1)", got)
	}
}
