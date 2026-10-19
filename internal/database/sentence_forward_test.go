package database

import "testing"

// Write-forwarding follows previous_sentence_id one migration per hop — a
// tab two commits behind still lands its write; a deleted sentence has no
// counterpart.
func TestForwardSentenceID_MultiHop(t *testing.T) {
	f := newITFixture(t)
	m1, s1 := f.makeDoneMigration(t, "fwd-c1", "A one.", "B one.")
	m2, s2 := f.makeDoneMigration(t, "fwd-c2", "A two.", "B two.")
	m3, s3 := f.makeDoneMigration(t, "fwd-c3", "A three.")
	link := func(id, prev string) {
		if err := f.db.SetPreviousSentenceID(f.ctx, id, &prev); err != nil {
			t.Fatal(err)
		}
	}
	link(s2[0], s1[0])
	link(s2[1], s1[1])
	link(s3[0], s2[0]) // B was deleted in commit 3

	for _, c := range []struct {
		from string
		to   int
		want string
	}{
		{s1[0], m2, s2[0]},
		{s1[0], m3, s3[0]}, // two hops
		{s2[0], m3, s3[0]},
		{s1[1], m3, ""}, // deleted → no counterpart
		{s3[0], m3, s3[0]},
		{s1[0], m1, s1[0]},
	} {
		got, err := f.db.ForwardSentenceID(f.ctx, c.from, c.to)
		if err != nil || got != c.want {
			t.Errorf("ForwardSentenceID(%s → m%d) = (%q, %v), want %q", c.from, c.to, got, err, c.want)
		}
	}
	active, err := f.db.HasActiveMigration(f.ctx, f.manuscriptID)
	if err != nil || active {
		t.Errorf("HasActiveMigration with only done rows = (%v, %v), want false", active, err)
	}
	if _, err := f.db.CreatePendingMigration(f.ctx, f.manuscriptID, "fwd-c4", "segman-test"); err != nil {
		t.Fatal(err)
	}
	if active, _ := f.db.HasActiveMigration(f.ctx, f.manuscriptID); !active {
		t.Error("a pending migration should count as active")
	}
}
