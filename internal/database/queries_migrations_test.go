package database

// AREA 2 §2.4 "Manuscripts & migrations" — rows #1–#7, #9–#14.
// (#8 CreatePendingMigration_DupTo409 is covered by
// internal/migrations TestMigration_DuplicateCommitConflicts.)

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/slackwing/manuscript-studio/internal/models"
)

// #1: same (repo_path, file_path) upserts to the SAME manuscript_id, and the
// returned display_name reflects the stored value (COALESCE'd to "" when NULL).
func TestCreateManuscript_UpsertIdempotent(t *testing.T) {
	f := newITFixture(t)

	again, err := f.db.CreateManuscript(f.ctx, f.repoPath, "manuscript.md")
	if err != nil {
		t.Fatalf("second CreateManuscript: %v", err)
	}
	if again.ManuscriptID != f.manuscriptID {
		t.Errorf("upsert minted a new id: %d, want %d", again.ManuscriptID, f.manuscriptID)
	}
	if again.DisplayName != "" {
		t.Errorf("fresh manuscript display_name = %q, want \"\"", again.DisplayName)
	}

	if _, err := f.pool.Exec(f.ctx,
		`UPDATE manuscript SET display_name = 'The Display Name' WHERE manuscript_id = $1`,
		f.manuscriptID); err != nil {
		t.Fatalf("set display_name: %v", err)
	}
	third, err := f.db.CreateManuscript(f.ctx, f.repoPath, "manuscript.md")
	if err != nil {
		t.Fatalf("third CreateManuscript: %v", err)
	}
	if third.ManuscriptID != f.manuscriptID {
		t.Errorf("upsert after display_name set minted a new id: %d", third.ManuscriptID)
	}
	if third.DisplayName != "The Display Name" {
		t.Errorf("upsert should keep display_name, got %q", third.DisplayName)
	}
}

// #2: both getters return (nil, nil) — not an error — on a missing row.
func TestGetManuscript_NilOnMissing(t *testing.T) {
	f := newITFixture(t)

	m, err := f.db.GetManuscript(f.ctx, "test://no-such-repo/none", "nope.md")
	if err != nil {
		t.Fatalf("GetManuscript err = %v, want nil", err)
	}
	if m != nil {
		t.Errorf("GetManuscript = %+v, want nil", m)
	}

	byID, err := f.db.GetManuscriptByID(f.ctx, -1)
	if err != nil {
		t.Fatalf("GetManuscriptByID err = %v, want nil", err)
	}
	if byID != nil {
		t.Errorf("GetManuscriptByID = %+v, want nil", byID)
	}

	// Sanity: the fixture row IS found by both.
	if m, _ := f.db.GetManuscript(f.ctx, f.repoPath, "manuscript.md"); m == nil {
		t.Error("GetManuscript missed the fixture row")
	}
	if m, _ := f.db.GetManuscriptByID(f.ctx, f.manuscriptID); m == nil {
		t.Error("GetManuscriptByID missed the fixture row")
	}
}

// #3: nil fields keep old values; (nil, nil) changes nothing; missing id → (nil, nil).
func TestUpdateManuscriptMeta_PartialNilKeeps(t *testing.T) {
	f := newITFixture(t)

	birthday := time.Date(2024, 3, 1, 0, 0, 0, 0, time.UTC)
	goal := 90000

	m, err := f.db.UpdateManuscriptMeta(f.ctx, f.manuscriptID, &birthday, &goal)
	if err != nil {
		t.Fatalf("set both: %v", err)
	}
	if m.Birthday == nil || !m.Birthday.Equal(birthday) || m.WordGoal != goal {
		t.Fatalf("set both: got birthday %v goal %d", m.Birthday, m.WordGoal)
	}

	newGoal := 120000
	m, err = f.db.UpdateManuscriptMeta(f.ctx, f.manuscriptID, nil, &newGoal)
	if err != nil {
		t.Fatalf("set goal only: %v", err)
	}
	if m.Birthday == nil || !m.Birthday.Equal(birthday) {
		t.Errorf("nil birthday should keep old value, got %v", m.Birthday)
	}
	if m.WordGoal != newGoal {
		t.Errorf("word_goal = %d, want %d", m.WordGoal, newGoal)
	}

	m, err = f.db.UpdateManuscriptMeta(f.ctx, f.manuscriptID, nil, nil)
	if err != nil {
		t.Fatalf("nil,nil: %v", err)
	}
	if m.Birthday == nil || !m.Birthday.Equal(birthday) || m.WordGoal != newGoal {
		t.Errorf("nil,nil changed the row: birthday %v goal %d", m.Birthday, m.WordGoal)
	}

	missing, err := f.db.UpdateManuscriptMeta(f.ctx, -1, nil, &goal)
	if err != nil {
		t.Fatalf("missing id err = %v, want nil", err)
	}
	if missing != nil {
		t.Errorf("missing id = %+v, want nil", missing)
	}
}

// #4: a pending row (nullable result columns) scans to zero values, and a
// sentence_id_array that isn't a string array hard-errors instead of
// half-populating the struct.
func TestScanMigration_NullableColumns(t *testing.T) {
	f := newITFixture(t)

	migID, err := f.db.CreatePendingMigration(f.ctx, f.manuscriptID, "HEAD", "segman-test")
	if err != nil {
		t.Fatalf("CreatePendingMigration: %v", err)
	}
	// sentence_count NULL, branch_name NULL, sentence_id_array NULL.
	query := `SELECT ` + migrationSelectColumns + ` FROM migration WHERE migration_id = $1`
	var m models.Migration
	if err := scanMigration(f.pool.QueryRow(f.ctx, query, migID), &m); err != nil {
		t.Fatalf("scanMigration on pending row: %v", err)
	}
	if m.BranchName != "" || m.SentenceCount != 0 || m.AdditionsCount != 0 ||
		m.DeletionsCount != 0 || m.ChangesCount != 0 || m.SentenceIDArray != nil {
		t.Errorf("nullable columns should scan to zero values, got %+v", m)
	}
	if m.Status != models.MigrationStatusPending || m.CommitHash != "HEAD" {
		t.Errorf("status/commit = %q/%q, want pending/HEAD", m.Status, m.CommitHash)
	}

	// Corrupt (valid jsonb, but not a string array) must error.
	if _, err := f.pool.Exec(f.ctx,
		`UPDATE migration SET sentence_id_array = '{"not":"an array"}'::jsonb WHERE migration_id = $1`,
		migID); err != nil {
		t.Fatalf("corrupt array: %v", err)
	}
	var m2 models.Migration
	err = scanMigration(f.pool.QueryRow(f.ctx, query, migID), &m2)
	if err == nil {
		t.Fatal("scanMigration accepted a corrupt sentence_id_array")
	}
	if !strings.Contains(err.Error(), "sentence_id_array") {
		t.Errorf("error should name the corrupt column, got: %v", err)
	}
}

// #5: pending and error rows are invisible to GetLatestMigration.
func TestGetLatestMigration_SkipsNonDone(t *testing.T) {
	f := newITFixture(t)

	if _, err := f.db.CreatePendingMigration(f.ctx, f.manuscriptID, "pend1", "segman-test"); err != nil {
		t.Fatalf("pending: %v", err)
	}
	errID, err := f.db.CreatePendingMigration(f.ctx, f.manuscriptID, "err1", "segman-test")
	if err != nil {
		t.Fatalf("pending for error: %v", err)
	}
	if err := f.db.MarkMigrationError(f.ctx, errID, "boom"); err != nil {
		t.Fatalf("MarkMigrationError: %v", err)
	}

	m, err := f.db.GetLatestMigration(f.ctx, f.manuscriptID)
	if err != nil {
		t.Fatalf("GetLatestMigration: %v", err)
	}
	if m != nil {
		t.Fatalf("no done migration exists, got %+v", m)
	}

	doneID, _ := f.makeDoneMigration(t, "done1", "A done sentence.")
	m, err = f.db.GetLatestMigration(f.ctx, f.manuscriptID)
	if err != nil {
		t.Fatalf("GetLatestMigration after done: %v", err)
	}
	if m == nil || m.MigrationID != doneID {
		t.Errorf("latest = %+v, want migration %d", m, doneID)
	}
}

// #6: only done rows, newest processed_at first.
func TestGetMigrations_DoneOnly_NewestFirst(t *testing.T) {
	f := newITFixture(t)

	older, _ := f.makeDoneMigration(t, "c-old", "Old sentence.")
	newer, _ := f.makeDoneMigration(t, "c-new", "New sentence.")
	if _, err := f.db.CreatePendingMigration(f.ctx, f.manuscriptID, "c-pend", "segman-test"); err != nil {
		t.Fatalf("pending: %v", err)
	}
	// MarkMigrationDone stamps NOW() for both; force distinct processed_at.
	if _, err := f.pool.Exec(f.ctx,
		`UPDATE migration SET processed_at = processed_at - interval '1 hour' WHERE migration_id = $1`,
		older); err != nil {
		t.Fatalf("backdate: %v", err)
	}

	list, err := f.db.GetMigrations(f.ctx, f.manuscriptID)
	if err != nil {
		t.Fatalf("GetMigrations: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("got %d migrations, want 2 (pending must be filtered)", len(list))
	}
	if list[0].MigrationID != newer || list[1].MigrationID != older {
		t.Errorf("order = [%d %d], want [%d %d]", list[0].MigrationID, list[1].MigrationID, newer, older)
	}
}

// #7: pending/running only, started_at DESC with NULLs last. The query is
// global (no manuscript filter), so assertions are scoped to this fixture's
// rows plus the status invariant on everything returned.
func TestGetActiveMigrations_PendingRunning(t *testing.T) {
	f := newITFixture(t)

	f.makeDoneMigration(t, "c-done", "Done sentence.")
	startedID, err := f.db.CreatePendingMigration(f.ctx, f.manuscriptID, "c-started", "segman-test")
	if err != nil {
		t.Fatalf("pending 1: %v", err)
	}
	nullID, err := f.db.CreatePendingMigration(f.ctx, f.manuscriptID, "c-nullstart", "segman-test")
	if err != nil {
		t.Fatalf("pending 2: %v", err)
	}
	if err := f.db.MarkMigrationRunning(f.ctx, startedID); err != nil {
		t.Fatalf("MarkMigrationRunning: %v", err)
	}
	if _, err := f.pool.Exec(f.ctx,
		`UPDATE migration SET started_at = NULL WHERE migration_id = $1`, nullID); err != nil {
		t.Fatalf("null started_at: %v", err)
	}

	list, err := f.db.GetActiveMigrations(f.ctx)
	if err != nil {
		t.Fatalf("GetActiveMigrations: %v", err)
	}
	idxStarted, idxNull := -1, -1
	for i, m := range list {
		if m.Status != models.MigrationStatusPending && m.Status != models.MigrationStatusRunning {
			t.Errorf("row %d has status %q — only pending/running belong here", m.MigrationID, m.Status)
		}
		switch m.MigrationID {
		case startedID:
			idxStarted = i
		case nullID:
			idxNull = i
		}
	}
	if idxStarted == -1 || idxNull == -1 {
		t.Fatalf("fixture rows missing from active list (started=%d null=%d)", idxStarted, idxNull)
	}
	if idxStarted > idxNull {
		t.Errorf("NULL started_at should sort last: started at %d, null at %d", idxStarted, idxNull)
	}
}

// #9: MarkMigrationRunning only flips pending/running rows; done and error
// rows are untouched.
func TestMarkMigrationRunning_OnlyFromPendingRunning(t *testing.T) {
	f := newITFixture(t)

	status := func(id int) string {
		var s string
		if err := f.pool.QueryRow(f.ctx, `SELECT status FROM migration WHERE migration_id = $1`, id).Scan(&s); err != nil {
			t.Fatalf("read status: %v", err)
		}
		return s
	}

	pendID, err := f.db.CreatePendingMigration(f.ctx, f.manuscriptID, "c-p", "segman-test")
	if err != nil {
		t.Fatalf("pending: %v", err)
	}
	if err := f.db.MarkMigrationRunning(f.ctx, pendID); err != nil {
		t.Fatalf("running: %v", err)
	}
	if got := status(pendID); got != models.MigrationStatusRunning {
		t.Errorf("pending → %q, want running", got)
	}
	// Idempotent on running.
	if err := f.db.MarkMigrationRunning(f.ctx, pendID); err != nil {
		t.Fatalf("running twice: %v", err)
	}

	doneID, _ := f.makeDoneMigration(t, "c-d", "Sentence.")
	if err := f.db.MarkMigrationRunning(f.ctx, doneID); err != nil {
		t.Fatalf("running on done: %v", err)
	}
	if got := status(doneID); got != models.MigrationStatusDone {
		t.Errorf("done row flipped to %q — must be a no-op", got)
	}

	errID, err := f.db.CreatePendingMigration(f.ctx, f.manuscriptID, "c-e", "segman-test")
	if err != nil {
		t.Fatalf("pending for error: %v", err)
	}
	if err := f.db.MarkMigrationError(f.ctx, errID, "boom"); err != nil {
		t.Fatalf("error: %v", err)
	}
	if err := f.db.MarkMigrationRunning(f.ctx, errID); err != nil {
		t.Fatalf("running on error: %v", err)
	}
	if got := status(errID); got != models.MigrationStatusError {
		t.Errorf("error row flipped to %q — must be a no-op", got)
	}
}

// #10: a pending row inserted with a symbolic ref ("HEAD") gets its
// commit_hash overwritten with the real SHA, and any stale error cleared.
func TestMarkMigrationDone_OverwritesCommitHash(t *testing.T) {
	f := newITFixture(t)

	migID, err := f.db.CreatePendingMigration(f.ctx, f.manuscriptID, "HEAD", "segman-test")
	if err != nil {
		t.Fatalf("pending: %v", err)
	}
	if _, err := f.pool.Exec(f.ctx,
		`UPDATE migration SET error = 'stale error' WHERE migration_id = $1`, migID); err != nil {
		t.Fatalf("stale error: %v", err)
	}

	realSHA := "abc1234def5678abc1234def5678abc1234def56"
	if err := f.db.MarkMigrationDone(f.ctx, &models.Migration{
		MigrationID:     migID,
		CommitHash:      realSHA,
		BranchName:      "main",
		SentenceCount:   0,
		SentenceIDArray: []string{},
	}); err != nil {
		t.Fatalf("MarkMigrationDone: %v", err)
	}

	var status, commit string
	var errCol *string
	if err := f.pool.QueryRow(f.ctx,
		`SELECT status, commit_hash, error FROM migration WHERE migration_id = $1`, migID,
	).Scan(&status, &commit, &errCol); err != nil {
		t.Fatalf("read row: %v", err)
	}
	if status != models.MigrationStatusDone {
		t.Errorf("status = %q, want done", status)
	}
	if commit != realSHA {
		t.Errorf("commit_hash = %q, want the real SHA (HEAD must be overwritten)", commit)
	}
	if errCol != nil {
		t.Errorf("error should be cleared, got %q", *errCol)
	}
}

// #11: the 4000-char truncation via the PROD function (the pre-existing
// TestErrorTruncation only duplicates the arithmetic).
func TestMarkMigrationError_Truncates4000(t *testing.T) {
	f := newITFixture(t)

	migID, err := f.db.CreatePendingMigration(f.ctx, f.manuscriptID, "c-err", "segman-test")
	if err != nil {
		t.Fatalf("pending: %v", err)
	}
	long := strings.Repeat("x", 5000)
	if err := f.db.MarkMigrationError(f.ctx, migID, long); err != nil {
		t.Fatalf("MarkMigrationError: %v", err)
	}

	var status, stored string
	if err := f.pool.QueryRow(f.ctx,
		`SELECT status, error FROM migration WHERE migration_id = $1`, migID).Scan(&status, &stored); err != nil {
		t.Fatalf("read row: %v", err)
	}
	if status != models.MigrationStatusError {
		t.Errorf("status = %q, want error", status)
	}
	want := strings.Repeat("x", 4000) + "...[truncated]"
	if stored != want {
		t.Errorf("stored error len %d suffix %q, want len %d suffix ...[truncated]",
			len(stored), stored[max(0, len(stored)-15):], len(want))
	}

	// Short messages stored verbatim.
	shortID, err := f.db.CreatePendingMigration(f.ctx, f.manuscriptID, "c-err2", "segman-test")
	if err != nil {
		t.Fatalf("pending 2: %v", err)
	}
	if err := f.db.MarkMigrationError(f.ctx, shortID, "small failure"); err != nil {
		t.Fatalf("MarkMigrationError short: %v", err)
	}
	if err := f.pool.QueryRow(f.ctx,
		`SELECT error FROM migration WHERE migration_id = $1`, shortID).Scan(&stored); err != nil {
		t.Fatalf("read short: %v", err)
	}
	if stored != "small failure" {
		t.Errorf("short error mangled: %q", stored)
	}
}

// #12: startup recovery flips leftover pending/running rows to error and
// counts them; done rows are untouched.
func TestRecoverInterruptedMigrations_FlipsAndCounts(t *testing.T) {
	f := newITFixture(t)

	pendID, err := f.db.CreatePendingMigration(f.ctx, f.manuscriptID, "c-p", "segman-test")
	if err != nil {
		t.Fatalf("pending: %v", err)
	}
	runID, err := f.db.CreatePendingMigration(f.ctx, f.manuscriptID, "c-r", "segman-test")
	if err != nil {
		t.Fatalf("pending 2: %v", err)
	}
	if err := f.db.MarkMigrationRunning(f.ctx, runID); err != nil {
		t.Fatalf("running: %v", err)
	}
	doneID, _ := f.makeDoneMigration(t, "c-d", "Sentence.")

	// The UPDATE is global (WHERE status IN pending/running, no manuscript
	// filter) so the count is >= ours, not ==.
	n, err := f.db.RecoverInterruptedMigrations(f.ctx)
	if err != nil {
		t.Fatalf("RecoverInterruptedMigrations: %v", err)
	}
	if n < 2 {
		t.Errorf("recovered %d rows, want >= 2", n)
	}

	for _, id := range []int{pendID, runID} {
		var status string
		var errMsg *string
		if err := f.pool.QueryRow(f.ctx,
			`SELECT status, error FROM migration WHERE migration_id = $1`, id).Scan(&status, &errMsg); err != nil {
			t.Fatalf("read %d: %v", id, err)
		}
		if status != models.MigrationStatusError {
			t.Errorf("migration %d status = %q, want error", id, status)
		}
		if errMsg == nil || !strings.Contains(*errMsg, "interrupted by server restart") {
			t.Errorf("migration %d error = %v, want interrupted marker", id, errMsg)
		}
	}
	var doneStatus string
	if err := f.pool.QueryRow(f.ctx,
		`SELECT status FROM migration WHERE migration_id = $1`, doneID).Scan(&doneStatus); err != nil {
		t.Fatalf("read done: %v", err)
	}
	if doneStatus != models.MigrationStatusDone {
		t.Errorf("done row flipped to %q", doneStatus)
	}
}

// #13: the done-gate that 404s in-flight migrations everywhere.
func TestGetMigrationByID_NilForPending(t *testing.T) {
	f := newITFixture(t)

	pendID, err := f.db.CreatePendingMigration(f.ctx, f.manuscriptID, "c-p", "segman-test")
	if err != nil {
		t.Fatalf("pending: %v", err)
	}
	m, err := f.db.GetMigrationByID(f.ctx, pendID)
	if err != nil {
		t.Fatalf("GetMigrationByID pending: %v", err)
	}
	if m != nil {
		t.Errorf("pending migration should be invisible, got %+v", m)
	}

	m, err = f.db.GetMigrationByID(f.ctx, -1)
	if err != nil {
		t.Fatalf("GetMigrationByID missing: %v", err)
	}
	if m != nil {
		t.Errorf("missing migration should be nil, got %+v", m)
	}

	doneID, sids := f.makeDoneMigration(t, "c-d", "One.", "Two.")
	m, err = f.db.GetMigrationByID(f.ctx, doneID)
	if err != nil {
		t.Fatalf("GetMigrationByID done: %v", err)
	}
	if m == nil {
		t.Fatal("done migration should be visible")
	}
	if len(m.SentenceIDArray) != 2 || m.SentenceIDArray[0] != sids[0] {
		t.Errorf("sentence_id_array = %v, want %v", m.SentenceIDArray, sids)
	}
}

// #14: ordinal order, and previous_sentence_id round-trips through the scan.
func TestGetSentencesByMigration_OrdinalOrder(t *testing.T) {
	f := newITFixture(t)

	_, prevIDs := f.makeDoneMigration(t, "c-prev", "The predecessor sentence.")
	migID, err := f.db.CreatePendingMigration(f.ctx, f.manuscriptID, "c-cur", "segman-test")
	if err != nil {
		t.Fatalf("pending: %v", err)
	}
	// Insert out of ordinal order, with a prev-link on the middle one.
	mk := func(i int, text string, prev *string) models.Sentence {
		return models.Sentence{
			SentenceID:         fmt.Sprintf("tsid-ord-%d-%d", migID, i),
			MigrationID:        migID,
			CommitHash:         "c-cur",
			Text:               text,
			Ordinal:            i,
			PreviousSentenceID: prev,
		}
	}
	batch := []models.Sentence{
		mk(2, "Third sentence.", nil),
		mk(0, "First sentence.", nil),
		mk(1, "Second sentence.", &prevIDs[0]),
	}
	if err := f.db.CreateSentences(f.ctx, batch); err != nil {
		t.Fatalf("CreateSentences: %v", err)
	}

	got, err := f.db.GetSentencesByMigration(f.ctx, migID)
	if err != nil {
		t.Fatalf("GetSentencesByMigration: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("got %d sentences, want 3", len(got))
	}
	for i, s := range got {
		if s.Ordinal != i {
			t.Errorf("index %d has ordinal %d — not ordinal-ordered", i, s.Ordinal)
		}
	}
	if got[1].PreviousSentenceID == nil || *got[1].PreviousSentenceID != prevIDs[0] {
		t.Errorf("prev-id scan: got %v, want %s", got[1].PreviousSentenceID, prevIDs[0])
	}
	if got[0].PreviousSentenceID != nil {
		t.Errorf("unlinked sentence should have nil prev, got %v", *got[0].PreviousSentenceID)
	}
}
