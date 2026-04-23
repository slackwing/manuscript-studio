package migrations

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// setupLocalRemote creates a bare "remote" repo and a working clone with one
// initial commit containing manuscript.md. Returns the GitRepository pointed
// at the working clone and the bare-repo path (so tests can inspect what was
// actually pushed).
func setupLocalRemote(t *testing.T, initialContent string) (*GitRepository, string) {
	t.Helper()
	root := t.TempDir()
	remote := filepath.Join(root, "remote.git")
	work := filepath.Join(root, "work")

	mustRun(t, "", "git", "init", "--bare", "-b", "main", remote)

	// Seed the remote: create a normal repo, commit a file, push.
	seed := filepath.Join(root, "seed")
	mustRun(t, "", "git", "init", "-b", "main", seed)
	mustRun(t, seed, "git", "config", "user.email", "test@example.com")
	mustRun(t, seed, "git", "config", "user.name", "Test")
	if err := os.WriteFile(filepath.Join(seed, "manuscript.md"), []byte(initialContent), 0644); err != nil {
		t.Fatalf("seed write: %v", err)
	}
	mustRun(t, seed, "git", "add", "manuscript.md")
	mustRun(t, seed, "git", "commit", "-m", "init")
	mustRun(t, seed, "git", "remote", "add", "origin", remote)
	mustRun(t, seed, "git", "push", "origin", "main")

	mustRun(t, "", "git", "clone", "-b", "main", remote, work)
	mustRun(t, work, "git", "config", "user.email", "test@example.com")
	mustRun(t, work, "git", "config", "user.name", "Test")

	return &GitRepository{
		Path:      work,
		Branch:    "main",
		RemoteURL: remote,
		FilePath:  "manuscript.md",
	}, remote
}

func mustRun(t *testing.T, dir string, name string, args ...string) {
	t.Helper()
	cmd := exec.Command(name, args...)
	if dir != "" {
		cmd.Dir = dir
	}
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("%s %v: %v\n%s", name, args, err, out)
	}
}

func TestLocalBranchExists(t *testing.T) {
	g, _ := setupLocalRemote(t, "Hello.\n")
	ctx := context.Background()

	exists, err := g.LocalBranchExists(ctx, "main")
	if err != nil {
		t.Fatalf("LocalBranchExists(main): %v", err)
	}
	if !exists {
		t.Fatal("main should exist")
	}

	exists, err = g.LocalBranchExists(ctx, "no-such-branch")
	if err != nil {
		t.Fatalf("LocalBranchExists(no-such-branch): %v", err)
	}
	if exists {
		t.Fatal("no-such-branch should not exist")
	}
}

func TestWriteCommitPushBranch_CreatesBranchAndPushes(t *testing.T) {
	g, remote := setupLocalRemote(t, "Original.\n")
	ctx := context.Background()

	baseSHA := strings.TrimSpace(runOut(t, g.Path, "git", "rev-parse", "HEAD"))

	newContent := []byte("Edited.\n")
	commitSHA, err := g.WriteCommitPushBranch(ctx, baseSHA, "suggestions-abc", newContent, "Apply suggestions", false)
	if err != nil {
		t.Fatalf("WriteCommitPushBranch: %v", err)
	}
	if commitSHA == "" {
		t.Fatal("expected non-empty commit SHA")
	}

	// Local branch must exist at the new commit.
	localSHA := strings.TrimSpace(runOut(t, g.Path, "git", "rev-parse", "refs/heads/suggestions-abc"))
	if localSHA != commitSHA {
		t.Fatalf("local ref = %s, want %s", localSHA, commitSHA)
	}

	// Remote (bare) repo must have the branch at the same commit.
	remoteSHA := strings.TrimSpace(runOut(t, remote, "git", "rev-parse", "refs/heads/suggestions-abc"))
	if remoteSHA != commitSHA {
		t.Fatalf("remote ref = %s, want %s", remoteSHA, commitSHA)
	}

	// File contents at the new commit must be the new content.
	got := runOut(t, g.Path, "git", "show", commitSHA+":manuscript.md")
	if got != string(newContent) {
		t.Fatalf("file at commit = %q, want %q", got, newContent)
	}

	// HEAD/working tree must be untouched (still on main, still original file).
	head := strings.TrimSpace(runOut(t, g.Path, "git", "rev-parse", "HEAD"))
	if head != baseSHA {
		t.Fatalf("HEAD moved: %s != %s", head, baseSHA)
	}
	wt, err := os.ReadFile(filepath.Join(g.Path, "manuscript.md"))
	if err != nil {
		t.Fatalf("read working tree file: %v", err)
	}
	if string(wt) != "Original.\n" {
		t.Fatalf("working tree was modified: %q", wt)
	}
}

func TestWriteCommitPushBranch_ForceUpdatesExistingBranch(t *testing.T) {
	g, remote := setupLocalRemote(t, "Original.\n")
	ctx := context.Background()

	baseSHA := strings.TrimSpace(runOut(t, g.Path, "git", "rev-parse", "HEAD"))

	first, err := g.WriteCommitPushBranch(ctx, baseSHA, "suggestions-abc", []byte("First.\n"), "first", false)
	if err != nil {
		t.Fatalf("first push: %v", err)
	}

	// Force-update with new content from the same base.
	second, err := g.WriteCommitPushBranch(ctx, baseSHA, "suggestions-abc", []byte("Second.\n"), "second", true)
	if err != nil {
		t.Fatalf("force update: %v", err)
	}
	if first == second {
		t.Fatal("expected a new commit SHA on force-update")
	}

	remoteSHA := strings.TrimSpace(runOut(t, remote, "git", "rev-parse", "refs/heads/suggestions-abc"))
	if remoteSHA != second {
		t.Fatalf("remote not force-updated: %s != %s", remoteSHA, second)
	}
}

func runOut(t *testing.T, dir string, name string, args ...string) string {
	t.Helper()
	cmd := exec.Command(name, args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("%s %v: %v\n%s", name, args, err, out)
	}
	return string(out)
}
