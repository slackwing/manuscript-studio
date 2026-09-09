package database

// AREA 2 §2.4 "Sentences & suggestions" — rows #15–#18, #21, #23–#29.
// (#19/#20/#22 — exact-match prune, window-join prune, survivors — are
// covered by internal/migrations TestMigration_NoOpSuggestionsPruned…,
// TestMigration_AppliedMultiSentenceSuggestionPruned and
// TestMigration_UnappliedSuggestionSurvivesWindowPrune.)

import (
	"strings"
	"testing"

	"github.com/slackwing/manuscript-studio/internal/models"
	"github.com/slackwing/manuscript-studio/internal/sentence"
)

// #15: empty input short-circuits (no query, empty map); a batch returns only
// the ids that exist.
func TestGetSentenceTextsByIDs_EmptyAndBatch(t *testing.T) {
	f := newITFixture(t)

	out, err := f.db.GetSentenceTextsByIDs(f.ctx, nil)
	if err != nil {
		t.Fatalf("empty slice: %v", err)
	}
	if len(out) != 0 {
		t.Errorf("empty slice should yield empty map, got %v", out)
	}

	_, prevIDs := f.makeDoneMigration(t, "c1", "Predecessor sentence.")
	migID, err := f.db.CreatePendingMigration(f.ctx, f.manuscriptID, "c2", "segman-test")
	if err != nil {
		t.Fatalf("pending: %v", err)
	}
	linked := models.Sentence{
		SentenceID: "tsid-batch-" + prevIDs[0], MigrationID: migID, CommitHash: "c2",
		Text: "Linked sentence.", Ordinal: 0, PreviousSentenceID: &prevIDs[0],
	}
	if err := f.db.CreateSentences(f.ctx, []models.Sentence{linked}); err != nil {
		t.Fatalf("CreateSentences: %v", err)
	}

	out, err = f.db.GetSentenceTextsByIDs(f.ctx, []string{linked.SentenceID, prevIDs[0], "no-such-id"})
	if err != nil {
		t.Fatalf("batch: %v", err)
	}
	if len(out) != 2 {
		t.Fatalf("got %d entries, want 2 (missing id must be absent)", len(out))
	}
	if _, ok := out["no-such-id"]; ok {
		t.Error("missing id should be absent from the map")
	}
	got := out[linked.SentenceID]
	if got.Text != "Linked sentence." || got.PreviousID == nil || *got.PreviousID != prevIDs[0] {
		t.Errorf("linked entry = %+v", got)
	}
	if p := out[prevIDs[0]]; p.Text != "Predecessor sentence." || p.PreviousID != nil {
		t.Errorf("predecessor entry = %+v", p)
	}
}

// #16: the (sentence_id, user_id) conflict updates the text in place — same
// suggestion_id, new text.
func TestUpsertSuggestion_InsertThenUpdate(t *testing.T) {
	f := newITFixture(t)
	_, sids := f.makeDoneMigration(t, "c1", "A sentence to improve.")

	first, err := f.db.UpsertSuggestion(f.ctx, sids[0], f.username, "First suggestion.")
	if err != nil {
		t.Fatalf("insert: %v", err)
	}
	second, err := f.db.UpsertSuggestion(f.ctx, sids[0], f.username, "Second suggestion.")
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if second.SuggestionID != first.SuggestionID {
		t.Errorf("conflict minted a new row: %d → %d", first.SuggestionID, second.SuggestionID)
	}
	if second.Text != "Second suggestion." {
		t.Errorf("text = %q", second.Text)
	}
	var count int
	if err := f.pool.QueryRow(f.ctx,
		`SELECT count(*) FROM suggested_change WHERE sentence_id = $1 AND user_id = $2`,
		sids[0], f.username).Scan(&count); err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 1 {
		t.Errorf("row count = %d, want 1", count)
	}
}

// #17: reports whether a row existed.
func TestDeleteSuggestion_ReportsRowExisted(t *testing.T) {
	f := newITFixture(t)
	_, sids := f.makeDoneMigration(t, "c1", "A sentence.")

	if _, err := f.db.UpsertSuggestion(f.ctx, sids[0], f.username, "Sugg."); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	existed, err := f.db.DeleteSuggestion(f.ctx, sids[0], f.username)
	if err != nil {
		t.Fatalf("delete: %v", err)
	}
	if !existed {
		t.Error("first delete should report true")
	}
	existed, err = f.db.DeleteSuggestion(f.ctx, sids[0], f.username)
	if err != nil {
		t.Fatalf("second delete: %v", err)
	}
	if existed {
		t.Error("second delete should report false")
	}
}

// #18: other users' suggestions are excluded.
func TestGetSuggestionsForMigration_UserScoped(t *testing.T) {
	f := newITFixture(t)
	other := f.newUser(t)
	migID, sids := f.makeDoneMigration(t, "c1", "One.", "Two.")

	if _, err := f.db.UpsertSuggestion(f.ctx, sids[0], f.username, "Mine."); err != nil {
		t.Fatalf("mine: %v", err)
	}
	if _, err := f.db.UpsertSuggestion(f.ctx, sids[1], other, "Theirs."); err != nil {
		t.Fatalf("theirs: %v", err)
	}

	rows, err := f.db.GetSuggestionsForMigration(f.ctx, migID, f.username)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if len(rows) != 1 || rows[0].Text != "Mine." || rows[0].UserID != f.username {
		t.Errorf("rows = %+v, want only mine", rows)
	}
}

// #21 (the ✗ leg of the #19–#22 prune battery): a suggestion whose NORMALIZED
// text is empty (punctuation/whitespace only) carries no comparable content
// and must never be window-pruned.
func TestSettle_EmptyNormalizedSuggestionSurvives(t *testing.T) {
	f := newITFixture(t)
	migID, sids := f.makeDoneMigration(t, "c1", "Real prose sentence here.", "Second sentence.")

	if norm := sentence.NormalizeText("?!... ---"); norm != "" {
		t.Fatalf("test premise broken: NormalizeText = %q, want empty", norm)
	}
	if _, err := f.db.UpsertSuggestion(f.ctx, sids[0], f.username, "?!... ---"); err != nil {
		t.Fatalf("upsert: %v", err)
	}

	retired, _, err := f.db.SettleSuggestionsForMigration(f.ctx, migID, sids, nil)
	if err != nil {
		t.Fatalf("settle: %v", err)
	}
	if retired != 0 {
		t.Errorf("retired %d suggestions, want 0", retired)
	}
	rows, err := f.db.GetSuggestionsForMigration(f.ctx, migID, f.username)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if len(rows) != 1 {
		t.Errorf("empty-normalized suggestion was pruned (rows = %d)", len(rows))
	}
}

// #23: with nil orderedIDs the settle falls back to the migration's STORED
// sentence_id_array — proven via the window rule, which needs document order.
func TestSettle_NilOrderedIDsFallsBack(t *testing.T) {
	f := newITFixture(t)
	migID, sids := f.makeDoneMigration(t, "c1", "First half here.", "Second half here.")

	// Suggestion == its own sentence joined with the next one → only the
	// neighbor-window rule (which requires ordering) catches it. Accepted +
	// sole row = fully reviewed, so the window match consummates the group.
	if _, err := f.db.UpsertSuggestion(f.ctx, sids[0], f.username,
		"First half here.\nSecond half here."); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	acc := models.ReviewAccepted
	if _, err := f.db.SetSuggestionReview(f.ctx, sids[0], f.username, &acc, f.username); err != nil {
		t.Fatalf("accept: %v", err)
	}

	retired, _, err := f.db.SettleSuggestionsForMigration(f.ctx, migID, nil, nil)
	if err != nil {
		t.Fatalf("settle: %v", err)
	}
	if retired != 1 {
		t.Errorf("retired %d, want 1 (stored sentence_id_array should drive the window)", retired)
	}
}

// #24: the settle is scoped to the given migration — an identical no-op on an
// older migration's sentence is audit data and stays.
func TestSettle_ScopedToMigration(t *testing.T) {
	f := newITFixture(t)
	_, oldSids := f.makeDoneMigration(t, "c-old", "Shared sentence text.")
	newMigID, newSids := f.makeDoneMigration(t, "c-new", "Shared sentence text.")

	// Both are exact applied acceptances (sole rows → fully reviewed).
	if _, err := f.db.UpsertSuggestion(f.ctx, oldSids[0], f.username, "Shared sentence text."); err != nil {
		t.Fatalf("old upsert: %v", err)
	}
	if _, err := f.db.UpsertSuggestion(f.ctx, newSids[0], f.username, "Shared sentence text."); err != nil {
		t.Fatalf("new upsert: %v", err)
	}
	acc := models.ReviewAccepted
	if _, err := f.db.SetSuggestionReview(f.ctx, newSids[0], f.username, &acc, f.username); err != nil {
		t.Fatalf("accept new: %v", err)
	}

	retired, _, err := f.db.SettleSuggestionsForMigration(f.ctx, newMigID, newSids, nil)
	if err != nil {
		t.Fatalf("settle: %v", err)
	}
	if retired != 1 {
		t.Errorf("retired %d, want exactly 1 (current migration only)", retired)
	}
	var oldCount int
	if err := f.pool.QueryRow(f.ctx,
		`SELECT count(*) FROM suggested_change WHERE sentence_id = $1`, oldSids[0]).Scan(&oldCount); err != nil {
		t.Fatalf("count old: %v", err)
	}
	if oldCount != 1 {
		t.Errorf("older migration's suggestion was pruned")
	}
}

// Group rules (SUGGESTION_REVIEW_RULES.md): an unreviewed sibling keeps the
// WHOLE group alive — even an applied, accepted row is not retired.
func TestSettle_UnreviewedSiblingKeepsGroupWhole(t *testing.T) {
	f := newITFixture(t)
	other := f.newUser(t)
	migID, sids := f.makeDoneMigration(t, "c1", "Committed text.")

	if _, err := f.db.UpsertSuggestion(f.ctx, sids[0], f.username, "Committed text."); err != nil {
		t.Fatalf("mine: %v", err)
	}
	acc := models.ReviewAccepted
	if _, err := f.db.SetSuggestionReview(f.ctx, sids[0], f.username, &acc, f.username); err != nil {
		t.Fatalf("accept: %v", err)
	}
	if _, err := f.db.UpsertSuggestion(f.ctx, sids[0], other, "Something pending."); err != nil {
		t.Fatalf("theirs: %v", err)
	}

	retired, unaccepted, err := f.db.SettleSuggestionsForMigration(f.ctx, migID, sids, nil)
	if err != nil {
		t.Fatalf("settle: %v", err)
	}
	if retired != 0 || unaccepted != 0 {
		t.Errorf("settle = (%d retired, %d unaccepted), want (0, 0)", retired, unaccepted)
	}
	var n int
	if err := f.pool.QueryRow(f.ctx,
		`SELECT count(*) FROM suggested_change WHERE sentence_id = $1`, sids[0]).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 2 {
		t.Errorf("group shrank to %d rows, want 2 (ALL migrate while any is unreviewed)", n)
	}
}

// Broken acceptance: a STALE accepted row whose text is NOT in the document
// resets to unreviewed, and the reset is logged as an 'unaccepted' event.
func TestSettle_BrokenAcceptanceResetsAndLogs(t *testing.T) {
	f := newITFixture(t)
	migID, sids := f.makeDoneMigration(t, "c1", "The externally rewritten sentence.")

	if _, err := f.db.UpsertSuggestion(f.ctx, sids[0], f.username, "What the reviewer accepted."); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	acc := models.ReviewAccepted
	if _, err := f.db.SetSuggestionReview(f.ctx, sids[0], f.username, &acc, f.username); err != nil {
		t.Fatalf("accept: %v", err)
	}
	// Simulate the carry marking it stale (its sentence changed underneath).
	if _, err := f.pool.Exec(f.ctx,
		`UPDATE suggested_change SET stale = TRUE WHERE sentence_id = $1`, sids[0]); err != nil {
		t.Fatalf("mark stale: %v", err)
	}

	retired, unaccepted, err := f.db.SettleSuggestionsForMigration(f.ctx, migID, sids, nil)
	if err != nil {
		t.Fatalf("settle: %v", err)
	}
	if retired != 0 || unaccepted != 1 {
		t.Errorf("settle = (%d retired, %d unaccepted), want (0, 1)", retired, unaccepted)
	}
	rows, err := f.db.GetSuggestionsForMigration(f.ctx, migID, f.username)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if len(rows) != 1 || rows[0].ReviewStatus != nil {
		t.Errorf("rows = %+v, want one UNREVIEWED row", rows)
	}
	var evts int
	if err := f.pool.QueryRow(f.ctx, `
		SELECT count(*) FROM suggestion_review_event
		WHERE sentence_id = $1 AND status = 'unaccepted' AND reviewer_id = 'migration'`,
		sids[0]).Scan(&evts); err != nil {
		t.Fatalf("count events: %v", err)
	}
	if evts != 1 {
		t.Errorf("unaccepted events = %d, want 1", evts)
	}
}

// A fully-reviewed, all-rejected group RETIRES at the next migration —
// the verdicts live in history; carrying dead rejections forever kept
// them haunting the ‹ › tour (2026-08-30).
func TestSettle_AllRejectedGroupRetires(t *testing.T) {
	f := newITFixture(t)
	migID, sids := f.makeDoneMigration(t, "c1", "Committed text.")

	if _, err := f.db.UpsertSuggestion(f.ctx, sids[0], f.username, "Rejected idea."); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	rej := models.ReviewRejected
	if _, err := f.db.SetSuggestionReview(f.ctx, sids[0], f.username, &rej, f.username); err != nil {
		t.Fatalf("reject: %v", err)
	}

	retired, unaccepted, err := f.db.SettleSuggestionsForMigration(f.ctx, migID, sids, nil)
	if err != nil {
		t.Fatalf("settle: %v", err)
	}
	if retired != 1 || unaccepted != 0 {
		t.Errorf("settle = (%d, %d), want (1, 0)", retired, unaccepted)
	}
	var n int
	if err := f.pool.QueryRow(f.ctx,
		`SELECT count(*) FROM suggested_change WHERE sentence_id = $1`, sids[0]).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 0 {
		t.Errorf("rejected group survived the migration (%d rows)", n)
	}
}

// Rule 6: accepting a STALE row freshens it — a live accepted edit of the
// sentence as it now reads (pushable; no more accept/unaccept zombie loop).
func TestReview_AcceptFreshensStaleRow(t *testing.T) {
	f := newITFixture(t)
	_, sids := f.makeDoneMigration(t, "c1", "Committed text.")

	if _, err := f.db.UpsertSuggestion(f.ctx, sids[0], f.username, "Carried old edit."); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if _, err := f.pool.Exec(f.ctx,
		`UPDATE suggested_change SET stale = TRUE WHERE sentence_id = $1`, sids[0]); err != nil {
		t.Fatalf("mark stale: %v", err)
	}
	acc := models.ReviewAccepted
	if _, err := f.db.SetSuggestionReview(f.ctx, sids[0], f.username, &acc, f.username); err != nil {
		t.Fatalf("accept: %v", err)
	}
	rows, err := f.db.GetSuggestionsForMigration(f.ctx, 0, f.username)
	_ = rows
	_ = err
	var stale bool
	var status *string
	if err := f.pool.QueryRow(f.ctx,
		`SELECT stale, review_status FROM suggested_change WHERE sentence_id = $1`, sids[0]).Scan(&stale, &status); err != nil {
		t.Fatalf("read row: %v", err)
	}
	if stale || status == nil || *status != models.ReviewAccepted {
		t.Errorf("row = stale:%v status:%v, want fresh accepted", stale, status)
	}
	// Rejecting must NOT freshen.
	rej := models.ReviewRejected
	if _, err := f.pool.Exec(f.ctx,
		`UPDATE suggested_change SET stale = TRUE WHERE sentence_id = $1`, sids[0]); err != nil {
		t.Fatalf("re-stale: %v", err)
	}
	if _, err := f.db.SetSuggestionReview(f.ctx, sids[0], f.username, &rej, f.username); err != nil {
		t.Fatalf("reject: %v", err)
	}
	if err := f.pool.QueryRow(f.ctx,
		`SELECT stale FROM suggested_change WHERE sentence_id = $1`, sids[0]).Scan(&stale); err != nil {
		t.Fatalf("read row: %v", err)
	}
	if !stale {
		t.Errorf("reject freshened the row — only accept should")
	}
}

// #25: destination row wins on conflict; empty input is a no-query zero;
// the returned count is rows actually inserted.
func TestCopySuggestionsForward_ConflictLoses(t *testing.T) {
	f := newITFixture(t)
	other := f.newUser(t)
	_, sids := f.makeDoneMigration(t, "c1", "From sentence.", "To sentence.", "Bulk to.")
	from, to, bulkTo := sids[0], sids[1], sids[2]

	// Two users' suggestions on from; one user already has a row on to.
	if _, err := f.db.UpsertSuggestion(f.ctx, from, f.username, "carried"); err != nil {
		t.Fatalf("upsert 1: %v", err)
	}
	if _, err := f.db.UpsertSuggestion(f.ctx, from, other, "other carried"); err != nil {
		t.Fatalf("upsert 2: %v", err)
	}
	if _, err := f.db.UpsertSuggestion(f.ctx, to, f.username, "destination wins"); err != nil {
		t.Fatalf("upsert 3: %v", err)
	}

	n, err := f.db.CopySuggestionsForward(f.ctx, from, to)
	if err != nil {
		t.Fatalf("copy: %v", err)
	}
	if n != 1 {
		t.Errorf("inserted %d, want 1 (my row collided, other's copied)", n)
	}
	var mine string
	if err := f.pool.QueryRow(f.ctx,
		`SELECT text FROM suggested_change WHERE sentence_id = $1 AND user_id = $2`,
		to, f.username).Scan(&mine); err != nil {
		t.Fatalf("read mine: %v", err)
	}
	if mine != "destination wins" {
		t.Errorf("destination row overwritten: %q", mine)
	}

	// Bulk: empty pairs → 0, no error.
	n, err = f.db.CarrySuggestionsForwardBulk(f.ctx, nil, nil, nil)
	if err != nil || n != 0 {
		t.Errorf("empty bulk = (%d, %v), want (0, nil)", n, err)
	}
	// Bulk carry to a fresh sentence inserts both users' rows; a FUZZY
	// pairing arrives stale (v3: carried-onto-changed-text).
	n, err = f.db.CarrySuggestionsForwardBulk(f.ctx, []string{from}, []string{bulkTo}, []bool{true})
	if err != nil {
		t.Fatalf("bulk: %v", err)
	}
	if n != 2 {
		t.Errorf("bulk inserted %d, want 2", n)
	}
	var stale bool
	if err := f.pool.QueryRow(f.ctx,
		`SELECT stale FROM suggested_change WHERE sentence_id = $1 AND user_id = $2`,
		bulkTo, f.username).Scan(&stale); err != nil {
		t.Fatalf("read stale: %v", err)
	}
	if !stale {
		t.Error("fuzzy carry must arrive stale")
	}
}

// #26: UpdateSentenceText validates BEFORE writing; SetPreviousSentenceID
// sets and clears.
func TestSetPreviousSentenceID_UpdateSentenceText_Validates(t *testing.T) {
	f := newITFixture(t)
	_, sids := f.makeDoneMigration(t, "c1", "Original text.", "Neighbor.")

	// Invalid (embedded tab) rejected pre-write.
	if err := f.db.UpdateSentenceText(f.ctx, sids[0], "bad\ttext"); err == nil {
		t.Fatal("invalid text accepted")
	}
	var text string
	if err := f.pool.QueryRow(f.ctx,
		`SELECT text FROM sentence WHERE sentence_id = $1`, sids[0]).Scan(&text); err != nil {
		t.Fatalf("read: %v", err)
	}
	if text != "Original text." {
		t.Errorf("rejected update still wrote: %q", text)
	}

	if err := f.db.UpdateSentenceText(f.ctx, sids[0], "\n\tRewritten text."); err != nil {
		t.Fatalf("valid update: %v", err)
	}
	if err := f.pool.QueryRow(f.ctx,
		`SELECT text FROM sentence WHERE sentence_id = $1`, sids[0]).Scan(&text); err != nil {
		t.Fatalf("read 2: %v", err)
	}
	if text != "\n\tRewritten text." {
		t.Errorf("text = %q", text)
	}

	if err := f.db.SetPreviousSentenceID(f.ctx, sids[1], &sids[0]); err != nil {
		t.Fatalf("set prev: %v", err)
	}
	var prev *string
	if err := f.pool.QueryRow(f.ctx,
		`SELECT previous_sentence_id FROM sentence WHERE sentence_id = $1`, sids[1]).Scan(&prev); err != nil {
		t.Fatalf("read prev: %v", err)
	}
	if prev == nil || *prev != sids[0] {
		t.Errorf("prev = %v, want %s", prev, sids[0])
	}
	if err := f.db.SetPreviousSentenceID(f.ctx, sids[1], nil); err != nil {
		t.Fatalf("clear prev: %v", err)
	}
	if err := f.pool.QueryRow(f.ctx,
		`SELECT previous_sentence_id FROM sentence WHERE sentence_id = $1`, sids[1]).Scan(&prev); err != nil {
		t.Fatalf("read prev 2: %v", err)
	}
	if prev != nil {
		t.Errorf("prev not cleared: %v", *prev)
	}
}

// #27: one invalid row anywhere in the batch → zero rows inserted.
func TestCreateSentences_ValidatesBeforeAnyWrite(t *testing.T) {
	f := newITFixture(t)
	migID, err := f.db.CreatePendingMigration(f.ctx, f.manuscriptID, "c1", "segman-test")
	if err != nil {
		t.Fatalf("pending: %v", err)
	}
	batch := []models.Sentence{
		{SentenceID: "tsid-vb-1", MigrationID: migID, CommitHash: "c1", Text: "Good sentence.", Ordinal: 0},
		{SentenceID: "tsid-vb-2", MigrationID: migID, CommitHash: "c1", Text: "bad\nembedded\nnewlines", Ordinal: 1},
	}
	if err := f.db.CreateSentences(f.ctx, batch); err == nil {
		t.Fatal("batch with invalid row accepted")
	}
	var count int
	if err := f.pool.QueryRow(f.ctx,
		`SELECT count(*) FROM sentence WHERE migration_id = $1`, migID).Scan(&count); err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 0 {
		t.Errorf("%d rows written despite invalid batch, want 0", count)
	}
}

// #28: re-storing clears and rewrites the migration's slug set; a duplicate
// slug within one batch keeps the first occurrence.
func TestStoreCommandSlugs_IdempotentPerMigration(t *testing.T) {
	f := newITFixture(t)
	migID, sids := f.makeDoneMigration(t, "c1", "&anchor#alpha{One.}", "&anchor#beta{Two.}")

	if err := f.db.StoreCommandSlugs(f.ctx, migID, []sentence.StaticSlug{
		{Slug: "alpha", SentenceID: sids[0], Kind: sentence.CmdAnchor},
		{Slug: "beta", SentenceID: sids[1], Kind: sentence.CmdAnchor},
	}); err != nil {
		t.Fatalf("store 1: %v", err)
	}

	// Re-store with a different set — old rows must be gone.
	if err := f.db.StoreCommandSlugs(f.ctx, migID, []sentence.StaticSlug{
		{Slug: "alpha", SentenceID: sids[1], Kind: sentence.CmdAnchor},
		// Batch duplicate: first wins (ON CONFLICT DO NOTHING).
		{Slug: "alpha", SentenceID: sids[0], Kind: sentence.CmdAnchor},
	}); err != nil {
		t.Fatalf("store 2: %v", err)
	}

	slugs, err := f.db.GetSlugsForMigration(f.ctx, migID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if len(slugs) != 1 {
		t.Fatalf("got %d slugs, want 1 (re-store must clear, dup must dedupe): %+v", len(slugs), slugs)
	}
	if slugs[0].Slug != "alpha" || slugs[0].SentenceID != sids[1] {
		t.Errorf("slug = %+v, want alpha → %s (first occurrence wins)", slugs[0], sids[1])
	}
}

// #29: GetSlugsForMigration orders by slug; ResolveSlug returns "" for a
// dangling reference.
func TestGetSlugs_ResolveSlug_MissingIsEmpty(t *testing.T) {
	f := newITFixture(t)
	migID, sids := f.makeDoneMigration(t, "c1", "&anchor#zeta{Z.}", "&anchor#alpha{A.}")

	if err := f.db.StoreCommandSlugs(f.ctx, migID, []sentence.StaticSlug{
		{Slug: "zeta", SentenceID: sids[0], Kind: sentence.CmdAnchor},
		{Slug: "alpha", SentenceID: sids[1], Kind: sentence.CmdAnchor},
	}); err != nil {
		t.Fatalf("store: %v", err)
	}

	slugs, err := f.db.GetSlugsForMigration(f.ctx, migID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if len(slugs) != 2 || slugs[0].Slug != "alpha" || slugs[1].Slug != "zeta" {
		t.Errorf("slugs = %+v, want alphabetical [alpha zeta]", slugs)
	}
	if slugs[0].Kind != string(sentence.CmdAnchor) {
		t.Errorf("kind = %q", slugs[0].Kind)
	}

	sid, err := f.db.ResolveSlug(f.ctx, migID, "alpha")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if sid != sids[1] {
		t.Errorf("resolve alpha = %q, want %s", sid, sids[1])
	}
	sid, err = f.db.ResolveSlug(f.ctx, migID, "dangling")
	if err != nil {
		t.Fatalf("resolve dangling: %v", err)
	}
	if sid != "" {
		t.Errorf("dangling slug = %q, want \"\"", sid)
	}
}

// Guard for the premise of #21: NormalizeText really does erase
// punctuation-only strings (documents what "empty-normalized" means).
func TestNormalizeTextPremise(t *testing.T) {
	if got := sentence.NormalizeText("  Stable   sentence   two  "); got != "stable sentence two" {
		t.Errorf("NormalizeText = %q", got)
	}
	if got := sentence.NormalizeText("?!... ---"); got != "" {
		t.Errorf("punctuation-only should normalize empty, got %q", got)
	}
}

// ---- 2026-09-09 zombie-suggestion incident battery -----------------------
// A 43-edit push left 8 rows haunting the manuscript: 5 accepted DELETIONS
// (empty text never fuzzy-matches "applied"), 2 edits that resegmented into
// merged sentences, and 1 nine-sentence rewrite past the join window. Push
// provenance retires all of them by construction; the widened window covers
// externally-applied rewrites.

// An accepted deletion is only recognizable as applied via provenance.
func TestSettle_PushProvenanceRetiresAcceptedDeletion(t *testing.T) {
	f := newITFixture(t)
	migID, sids := f.makeDoneMigration(t, "c1", "Neighbor that survives.", "Another survivor.")

	if _, err := f.db.UpsertSuggestion(f.ctx, sids[0], f.username, ""); err != nil {
		t.Fatalf("upsert deletion: %v", err)
	}
	acc := models.ReviewAccepted
	if _, err := f.db.SetSuggestionReview(f.ctx, sids[0], f.username, &acc, f.username); err != nil {
		t.Fatalf("accept: %v", err)
	}
	if n, err := f.db.StampSuggestionsPushed(f.ctx, []string{sids[0]}, f.username, "push-sha-del"); err != nil || n != 1 {
		t.Fatalf("stamp: n=%d err=%v", n, err)
	}

	// Without provenance the deletion is unmatchable and survives — the
	// exact haunting from the incident.
	retired, _, err := f.db.SettleSuggestionsForMigration(f.ctx, migID, sids, nil)
	if err != nil {
		t.Fatalf("settle (no provenance): %v", err)
	}
	if retired != 0 {
		t.Fatalf("retired %d without provenance, want 0 (premise)", retired)
	}
	// With the pushed commit verified in history: applied by construction.
	retired, _, err = f.db.SettleSuggestionsForMigration(f.ctx, migID, sids,
		map[string]bool{"push-sha-del": true})
	if err != nil {
		t.Fatalf("settle (provenance): %v", err)
	}
	if retired != 1 {
		t.Errorf("retired %d with provenance, want 1", retired)
	}
}

// A rewrite whose text bears no window relation to its sentence still
// retires under provenance.
func TestSettle_PushProvenanceRetiresUnmatchableRewrite(t *testing.T) {
	f := newITFixture(t)
	migID, sids := f.makeDoneMigration(t, "c1", "Sentence one.", "Sentence two.")

	if _, err := f.db.UpsertSuggestion(f.ctx, sids[0], f.username,
		"Totally new passage that shares no words with anything committed."); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	acc := models.ReviewAccepted
	if _, err := f.db.SetSuggestionReview(f.ctx, sids[0], f.username, &acc, f.username); err != nil {
		t.Fatalf("accept: %v", err)
	}
	if _, err := f.db.StampSuggestionsPushed(f.ctx, []string{sids[0]}, f.username, "push-sha-rw"); err != nil {
		t.Fatalf("stamp: %v", err)
	}

	retired, _, err := f.db.SettleSuggestionsForMigration(f.ctx, migID, sids,
		map[string]bool{"push-sha-rw": true})
	if err != nil {
		t.Fatalf("settle: %v", err)
	}
	if retired != 1 {
		t.Errorf("retired %d, want 1", retired)
	}
}

// No provenance (external commit / squash merge): a rewrite that
// resegmented into NINE sentences must still window-match — the old w=3
// cap missed it and the un-consummated acceptance would have re-applied
// and duplicated the passage on the next push.
func TestSettle_WindowCoversNineSentenceRewrite(t *testing.T) {
	f := newITFixture(t)
	texts := []string{
		"Rewrite part one.", "Rewrite part two.", "Rewrite part three.",
		"Rewrite part four.", "Rewrite part five.", "Rewrite part six.",
		"Rewrite part seven.", "Rewrite part eight.", "Rewrite part nine.",
	}
	migID, sids := f.makeDoneMigration(t, "c1", texts...)

	if _, err := f.db.UpsertSuggestion(f.ctx, sids[0], f.username,
		strings.Join(texts, "\n")); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	acc := models.ReviewAccepted
	if _, err := f.db.SetSuggestionReview(f.ctx, sids[0], f.username, &acc, f.username); err != nil {
		t.Fatalf("accept: %v", err)
	}

	retired, _, err := f.db.SettleSuggestionsForMigration(f.ctx, migID, sids, nil)
	if err != nil {
		t.Fatalf("settle: %v", err)
	}
	if retired != 1 {
		t.Errorf("retired %d, want 1 (9-sentence join must be inside the window)", retired)
	}
}

// Provenance survives the carry to the next migration's sentences.
func TestCarry_PreservesPushProvenance(t *testing.T) {
	f := newITFixture(t)
	_, sids1 := f.makeDoneMigration(t, "c1", "Original sentence.")
	if _, err := f.db.UpsertSuggestion(f.ctx, sids1[0], f.username, "Edited sentence."); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if _, err := f.db.StampSuggestionsPushed(f.ctx, []string{sids1[0]}, f.username, "push-sha-carry"); err != nil {
		t.Fatalf("stamp: %v", err)
	}

	mig2, sids2 := f.makeDoneMigration(t, "c2", "Original sentence.")
	if _, err := f.db.CarrySuggestionsForwardBulk(f.ctx,
		[]string{sids1[0]}, []string{sids2[0]}, []bool{false}); err != nil {
		t.Fatalf("carry: %v", err)
	}

	rows, err := f.db.GetSuggestionsForMigration(f.ctx, mig2, f.username)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if len(rows) != 1 || rows[0].PushedInCommit == nil || *rows[0].PushedInCommit != "push-sha-carry" {
		t.Errorf("carried row = %+v, want pushed_in_commit preserved", rows)
	}
	// The pending-commit sweep the migration runner uses must surface it.
	shas, err := f.db.GetPendingPushedCommits(f.ctx, mig2)
	if err != nil {
		t.Fatalf("pending commits: %v", err)
	}
	if len(shas) != 1 || shas[0] != "push-sha-carry" {
		t.Errorf("pending commits = %v", shas)
	}
}

// Editing a pushed suggestion is a NEW proposal — the stamp must clear, or
// the stale text would consummate as if the new text had been pushed.
func TestUpsert_ClearsPushProvenance(t *testing.T) {
	f := newITFixture(t)
	_, sids := f.makeDoneMigration(t, "c1", "A sentence.")
	if _, err := f.db.UpsertSuggestion(f.ctx, sids[0], f.username, "First text."); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if _, err := f.db.StampSuggestionsPushed(f.ctx, []string{sids[0]}, f.username, "push-sha-x"); err != nil {
		t.Fatalf("stamp: %v", err)
	}
	edited, err := f.db.UpsertSuggestion(f.ctx, sids[0], f.username, "Second text.")
	if err != nil {
		t.Fatalf("re-upsert: %v", err)
	}
	if edited.PushedInCommit != nil {
		t.Errorf("pushed_in_commit = %q after edit, want cleared", *edited.PushedInCommit)
	}
}
