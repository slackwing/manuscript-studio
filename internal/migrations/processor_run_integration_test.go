package migrations

// Processor.Run lifecycle tests against the dev DB (CODE_REVIEW_AUG_2026.md
// AREA 2 rows #127–128). Shares the fixture helpers in
// processor_integration_test.go.

import (
	"context"
	"log/slog"
	"testing"
)

// #127 — "Changes" is defined in processor.go as sentences tracked to a
// successor with sub-unity confidence (the fixed code stores that computed
// count; the old code stored len(diff.Deleted)). The two diverge whenever a
// deleted sentence gets NO pairing at all — e.g. a full rewrite with zero
// matches: every old sentence is "deleted", none is a tracked change.
func TestMigration_ChangesCountIsSubUnityPairingCount(t *testing.T) {
	f := newFixture(t)

	// v1 → v2 share no vocabulary: similarity < 0.40 for every pair, so the
	// migration plan is empty. Intended changes_count = 0 (two deletions +
	// two additions, zero tracked changes); the bug stores 2.
	v1 := "Alpha bravo charlie delta echo. Foxtrot golf hotel india juliett."
	v2 := "One two three four five six. Seven eight nine ten eleven twelve."

	runProcessor(t, f.ctx, f.processor, f.db, f.manuscriptID, "v1-changes", v1)
	mID2 := runProcessor(t, f.ctx, f.processor, f.db, f.manuscriptID, "v2-changes", v2)

	m, err := f.db.GetMigrationByID(f.ctx, mID2)
	if err != nil || m == nil {
		t.Fatalf("GetMigrationByID: %v, %v", m, err)
	}
	if m.DeletionsCount != 2 || m.AdditionsCount != 2 {
		t.Fatalf("scenario drifted: deletions %d additions %d, want 2/2", m.DeletionsCount, m.AdditionsCount)
	}
	if m.ChangesCount != 0 {
		t.Errorf("changes_count = %d, want 0 (= sub-unity-confidence pairing count; bug stores len(diff.Deleted) = %d)",
			m.ChangesCount, m.DeletionsCount)
	}

	// Cross-check on a scenario WITH a tracked change: one fuzzy edit.
	v3 := "One two three four five six. Seven eight nine ten eleven TWELVE-ish."
	mID3 := runProcessor(t, f.ctx, f.processor, f.db, f.manuscriptID, "v3-changes", v3)
	m3, err := f.db.GetMigrationByID(f.ctx, mID3)
	if err != nil || m3 == nil {
		t.Fatalf("GetMigrationByID v3: %v, %v", m3, err)
	}
	if m3.ChangesCount != 1 {
		t.Errorf("one fuzzy edit: changes_count = %d, want 1", m3.ChangesCount)
	}
}

// #128 — the deferred error-mark is registered BEFORE MarkMigrationRunning
// (processor.go:64–73) and runs on context.Background(), so even when the
// very first write fails the row still finishes at 'error' instead of
// sitting at 'pending' forever.
func TestRun_MarksErrorEvenIfMarkRunningFails(t *testing.T) {
	f := newFixture(t)

	id, err := f.db.CreatePendingMigration(f.ctx, f.manuscriptID, "doomed-run", f.processor.SegmenterVersion())
	if err != nil {
		t.Fatalf("CreatePendingMigration: %v", err)
	}

	// A dead context makes MarkMigrationRunning (the first write) fail.
	dead, cancel := context.WithCancel(f.ctx)
	cancel()

	if _, err := f.processor.Run(dead, slog.Default(), id, f.manuscriptID, "doomed-run", "main", "Some content."); err == nil {
		t.Fatal("Run with dead context should return an error")
	}

	var status string
	var errMsg *string
	if err := f.pool.QueryRow(f.ctx, `
		SELECT status, error FROM migration WHERE migration_id = $1
	`, id).Scan(&status, &errMsg); err != nil {
		t.Fatalf("read migration row: %v", err)
	}
	if status != "error" {
		t.Fatalf("row status = %q, want 'error' (never stuck at pending)", status)
	}
	if errMsg == nil || *errMsg == "" {
		t.Errorf("error_message empty, want the failure recorded")
	}
}
