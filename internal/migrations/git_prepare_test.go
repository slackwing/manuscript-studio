package migrations

// GitRepository.Prepare tests (CODE_REVIEW_AUG_2026.md AREA 2 row #134):
// pull failure is SOFT (warn + proceed with local state), clone and
// content-read failures are FATAL, and ""/"HEAD" resolve to the latest
// commit touching the file. Uses the local-remote fixture from
// git_writebranch_test.go.

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func headSHA(t *testing.T, repoDir string) string {
	t.Helper()
	out, err := exec.Command("git", "-C", repoDir, "rev-parse", "HEAD").Output()
	if err != nil {
		t.Fatalf("rev-parse HEAD: %v", err)
	}
	return strings.TrimSpace(string(out))
}

func TestPrepare_ResolvesHEADAndReadsContent(t *testing.T) {
	g, _ := setupLocalRemote(t, "The opening line. The second line.")
	want := headSHA(t, g.Path)

	for _, ref := range []string{"", "HEAD"} {
		pc, err := g.Prepare(context.Background(), ref, nil)
		if err != nil {
			t.Fatalf("Prepare(%q): %v", ref, err)
		}
		if pc.CommitHash != want {
			t.Errorf("Prepare(%q) commit = %s, want resolved HEAD %s", ref, pc.CommitHash, want)
		}
		if pc.BranchName != "main" {
			t.Errorf("Prepare(%q) branch = %q, want main", ref, pc.BranchName)
		}
		if pc.Content != "The opening line. The second line." {
			t.Errorf("Prepare(%q) content = %q", ref, pc.Content)
		}
	}

	// An explicit SHA is honored as-is (no HEAD resolution).
	pc, err := g.Prepare(context.Background(), want, nil)
	if err != nil {
		t.Fatalf("Prepare(sha): %v", err)
	}
	if pc.CommitHash != want {
		t.Errorf("explicit sha rewritten: %s", pc.CommitHash)
	}
}

// Pull failure must warn and proceed with local state — webhook-triggered
// migrations race CI's push, and the target commit is often already local.
func TestPrepare_PullFailureIsSoft(t *testing.T) {
	g, remote := setupLocalRemote(t, "Local content survives.")

	// Kill the remote: pull now fails, but the clone is intact.
	if err := os.RemoveAll(remote); err != nil {
		t.Fatalf("remove remote: %v", err)
	}

	var warnings []string
	warnf := func(format string, args ...any) {
		warnings = append(warnings, fmt.Sprintf(format, args...))
	}
	pc, err := g.Prepare(context.Background(), "HEAD", warnf)
	if err != nil {
		t.Fatalf("Prepare should proceed on pull failure, got: %v", err)
	}
	if pc.Content != "Local content survives." {
		t.Errorf("content = %q, want the local state", pc.Content)
	}
	found := false
	for _, w := range warnings {
		if strings.Contains(w, "pull failed") {
			found = true
		}
	}
	if !found {
		t.Errorf("expected a 'pull failed' warning, got %v", warnings)
	}
}

// A commit that doesn't exist (valid format, unknown object) must fail the
// content read — never silently substitute other content.
func TestPrepare_MissingCommitReadIsFatal(t *testing.T) {
	g, _ := setupLocalRemote(t, "Whatever content.")

	_, err := g.Prepare(context.Background(), "0123456789abcdef0123456789abcdef01234567", nil)
	if err == nil {
		t.Fatal("Prepare with unknown commit should fail")
	}
	if !strings.Contains(err.Error(), "read content") {
		t.Errorf("error = %v, want the read-content failure surfaced", err)
	}
}

// Clone failure (fresh path + unreachable remote) is fatal.
func TestPrepare_CloneFailureIsFatal(t *testing.T) {
	root := t.TempDir()
	g := &GitRepository{
		Path:      filepath.Join(root, "never-cloned"),
		Branch:    "main",
		RemoteURL: filepath.Join(root, "no-such-remote.git"),
		FilePath:  "manuscript.md",
	}
	_, err := g.Prepare(context.Background(), "HEAD", nil)
	if err == nil {
		t.Fatal("Prepare should fail when the clone fails")
	}
	if !strings.Contains(err.Error(), "clone") {
		t.Errorf("error = %v, want the clone failure surfaced", err)
	}
}
