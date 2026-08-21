package database

// Registry-to-DB tests (037, MANUSCRIPT_LIFECYCLE_PLAN Phase 0):
// local-manuscript creation, config reconciliation, and webhook fan-out
// lookup by git_repo_name.

import (
	"fmt"
	"testing"
	"time"

	"github.com/slackwing/manuscript-studio/internal/models"
)

func uniqueName(prefix string) string {
	return fmt.Sprintf("%s-%d-%d", prefix, time.Now().UnixNano(), itNext())
}

func TestCreateLocalManuscript_AndNameConflict(t *testing.T) {
	f := newITFixture(t)
	name := uniqueName("it-local")

	m, err := f.db.CreateLocalManuscript(f.ctx, name, "book.manuscript", "My Local Book")
	if err != nil {
		t.Fatalf("CreateLocalManuscript: %v", err)
	}
	t.Cleanup(func() {
		f.pool.Exec(f.ctx, `DELETE FROM manuscript WHERE manuscript_id = $1`, m.ManuscriptID)
	})

	if m.Storage != models.StorageLocal || m.Name != name || m.DisplayName != "My Local Book" {
		t.Fatalf("row = %+v", m)
	}
	if m.GitRepoPath != LocalGitRepoPath(name) || m.Branch() != "main" {
		t.Fatalf("identity = %q branch = %q", m.GitRepoPath, m.Branch())
	}

	// Duplicate name must error (uq_manuscript_name), not upsert.
	if _, err := f.db.CreateLocalManuscript(f.ctx, name, "book.manuscript", "Again"); err == nil {
		t.Fatal("duplicate name should error")
	}

	byName, err := f.db.GetManuscriptByName(f.ctx, name)
	if err != nil || byName == nil || byName.ManuscriptID != m.ManuscriptID {
		t.Fatalf("GetManuscriptByName = %+v, %v", byName, err)
	}
}

func TestReconcileManuscriptFromConfig_BackfillsWithoutRenaming(t *testing.T) {
	f := newITFixture(t)
	// The fixture row was created pre-reconcile style (no name/registry cols).
	name := uniqueName("it-reconcile")

	row, err := f.db.ReconcileManuscriptFromConfig(f.ctx, name, f.repoPath, "manuscript.md", "the-repo", "trunk")
	if err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if row.ManuscriptID != f.manuscriptID {
		t.Fatalf("reconcile minted a new row: %d, want %d", row.ManuscriptID, f.manuscriptID)
	}
	if row.Name != name || row.GitRepoName != "the-repo" || row.GitBranch != "trunk" || row.Storage != models.StorageGitHub {
		t.Fatalf("row = %+v", row)
	}

	// Re-reconciling under a DIFFERENT name must keep the existing name —
	// renames would orphan manuscript_access grants.
	other := uniqueName("it-reconcile-other")
	row2, err := f.db.ReconcileManuscriptFromConfig(f.ctx, other, f.repoPath, "manuscript.md", "the-repo", "trunk")
	if err != nil {
		t.Fatalf("re-reconcile: %v", err)
	}
	if row2.Name != name {
		t.Fatalf("re-reconcile renamed the row to %q, want %q kept", row2.Name, name)
	}

	// Webhook fan-out lookup sees it under its registry entry.
	rows, err := f.db.GetManuscriptsByGitRepoName(f.ctx, "the-repo")
	if err != nil {
		t.Fatalf("GetManuscriptsByGitRepoName: %v", err)
	}
	found := false
	for _, r := range rows {
		if r.ManuscriptID == f.manuscriptID {
			found = true
		}
	}
	if !found {
		t.Fatalf("fixture row not found under its git_repo_name; got %d rows", len(rows))
	}
}
