package database

import "testing"

// The one-time migration of a placeholder's old {details} arg into a sticky
// note on that placeholder (PLACEHOLDER_PLAN.md v2): one note per detail,
// owned by the manuscript's author, placed on the token's sentence; a second
// run creates nothing.
func TestBackfillPlaceholderDetailNotes(t *testing.T) {
	f := newITFixture(t)
	_, sids := f.makeDoneMigration(t, "ph-details",
		"Prose before the gap.",
		"&placeholder{sentences}{l}{}{A sits down to wait for his flight.}",
		"She waited. &placeholder{sentences}{s}{}{They meet. Wordless.} Then she left.",
		"&placeholder#keg{paragraphs}{m}{The keg party}",
		"&placeholder{paragraphs}{m}{}{}",
	)
	if _, err := f.pool.Exec(f.ctx, `INSERT INTO role (username, manuscript_id, role) VALUES ($1, $2, 'author') ON CONFLICT DO NOTHING`, f.username, f.manuscriptID); err != nil {
		t.Fatal(err)
	}
	// A bootstrap-style account that ALSO holds the author role and sorts
	// first alphabetically, but has never written a note here: the human
	// author (who has) must own the migrated notes.
	bot := "aaa-bot-" + f.username
	if _, err := f.pool.Exec(f.ctx, `INSERT INTO "user" (username, password_hash, role) VALUES ($1, 'x', 'author') ON CONFLICT DO NOTHING`, bot); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(f.ctx, `INSERT INTO role (username, manuscript_id, role) VALUES ($1, $2, 'author') ON CONFLICT DO NOTHING`, bot, f.manuscriptID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		f.pool.Exec(f.ctx, `DELETE FROM role WHERE username = $1`, bot)
		f.pool.Exec(f.ctx, `DELETE FROM "user" WHERE username = $1`, bot)
	})
	f.createNote(t, sids[0], "the human author's existing note")

	n, err := f.db.BackfillPlaceholderDetailNotes(f.ctx)
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if n < 2 {
		t.Fatalf("want at least the 2 notes of this fixture, created %d", n)
	}
	bodyOn := func(sid string) string {
		var body string
		err := f.pool.QueryRow(f.ctx, `
			SELECT n.body FROM note n JOIN note_sentence ns USING (note_id)
			WHERE ns.sentence_id = $1 AND n.deleted_at IS NULL AND n.user_id = $2
		`, sid, f.username).Scan(&body)
		if err != nil {
			return "<none: " + err.Error() + ">"
		}
		return body
	}
	if got := bodyOn(sids[1]); got != "A sits down to wait for his flight." {
		t.Fatalf("block placeholder: note body = %q", got)
	}
	if got := bodyOn(sids[2]); got != "They meet. Wordless." {
		t.Fatalf("inline placeholder: the note sits on the HOST sentence: %q", got)
	}
	for _, sid := range []string{sids[3], sids[4]} {
		if got := bodyOn(sid); got[:6] != "<none:" {
			t.Fatalf("sentence %s should get no note, got %q", sid, got)
		}
	}
	var botNotes int
	f.pool.QueryRow(f.ctx, `SELECT count(*) FROM note WHERE user_id = $1`, bot).Scan(&botNotes)
	if botNotes != 0 {
		t.Fatalf("the never-wrote bootstrap author must not own the migrated notes (%d)", botNotes)
	}
	var color, priority string
	var mid *int
	f.pool.QueryRow(f.ctx, `SELECT n.color, n.priority, n.manuscript_id FROM note n JOIN note_sentence ns USING (note_id) WHERE ns.sentence_id = $1`, sids[1]).Scan(&color, &priority, &mid)
	if color != "yellow" || priority != "none" || mid == nil || *mid != f.manuscriptID {
		t.Fatalf("note shape: %s/%s/%v", color, priority, mid)
	}

	again, err := f.db.BackfillPlaceholderDetailNotes(f.ctx)
	if err != nil {
		t.Fatalf("backfill 2: %v", err)
	}
	var mine int
	f.pool.QueryRow(f.ctx, `SELECT count(*) FROM note n JOIN note_sentence ns USING (note_id) WHERE ns.sentence_id = ANY($1) AND n.deleted_at IS NULL`, sids).Scan(&mine)
	if mine != 3 {
		t.Fatalf("idempotent: want 3 notes on this fixture after a second run (the human's own + 2 migrated; created %d more overall), got %d", again, mine)
	}
}
