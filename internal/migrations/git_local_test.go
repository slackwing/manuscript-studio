package migrations

// Local-mode GitRepository tests (MANUSCRIPT_LIFECYCLE_PLAN Phase 1):
// server-owned repos with no origin — init, seed, commit-without-push.

import (
	"context"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func newLocalRepo(t *testing.T) *GitRepository {
	t.Helper()
	return &GitRepository{
		Path:     filepath.Join(t.TempDir(), "book"),
		Branch:   "main",
		FilePath: "book.manuscript",
		Local:    true,
	}
}

func TestInitLocal_SeedCommit_LocalWrite(t *testing.T) {
	ctx := context.Background()
	g := newLocalRepo(t)

	// Clone on a missing local repo must fail loudly, not silently init.
	if err := g.Clone(ctx); err == nil {
		t.Fatal("Clone on missing local repo should error")
	}

	if err := g.InitLocal(ctx); err != nil {
		t.Fatalf("InitLocal: %v", err)
	}
	// Second init = name conflict.
	if err := g.InitLocal(ctx); err == nil {
		t.Fatal("second InitLocal should error (repo exists)")
	}

	seedSHA, err := g.CommitSeedFile(ctx, []byte("# My Book\n"), "Initial manuscript", "tester", "t@example.com")
	if err != nil {
		t.Fatalf("CommitSeedFile: %v", err)
	}

	// Prepare must work with no RemoteURL: Clone no-ops, Pull no-ops.
	prepared, err := g.Prepare(ctx, "HEAD", nil)
	if err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	if prepared.CommitHash != seedSHA {
		t.Fatalf("Prepare commit = %s, want seed %s", prepared.CommitHash, seedSHA)
	}
	if prepared.Content != "# My Book\n" {
		t.Fatalf("Prepare content = %q", prepared.Content)
	}
	if prepared.BranchName != "main" {
		t.Fatalf("branch = %q, want main", prepared.BranchName)
	}

	// A local WriteCommitPushBranch commits WITHOUT pushing (no origin to
	// push to — reaching the push step would fail) and advances the branch.
	files := map[string][]byte{"book.manuscript": []byte("# My Book\n\nA first sentence.\n")}
	sha2, err := g.WriteCommitPushBranch(ctx, seedSHA, "main", files, "local edit", false, "tester", "t@example.com")
	if err != nil {
		t.Fatalf("WriteCommitPushBranch (local): %v", err)
	}
	head, err := g.GetLatestCommitHash(ctx)
	if err != nil {
		t.Fatalf("GetLatestCommitHash: %v", err)
	}
	if head != sha2 {
		t.Fatalf("branch head = %s, want %s", head, sha2)
	}
	content, err := g.GetFileContent(ctx, sha2)
	if err != nil {
		t.Fatalf("GetFileContent: %v", err)
	}
	if content != string(files["book.manuscript"]) {
		t.Fatalf("content after local commit = %q", content)
	}

	// The working tree is synced (reset --hard) so the on-disk repo stays
	// readable by humans and backup jobs.
	out, err := exec.CommandContext(ctx, "git", "-C", g.Path, "status", "--porcelain").Output()
	if err != nil {
		t.Fatalf("git status: %v", err)
	}
	if strings.TrimSpace(string(out)) != "" {
		t.Fatalf("working tree dirty after local commit:\n%s", out)
	}
}
