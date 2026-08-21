package handlers

// Layout-migration and resolver tests (Phase 0, MANUSCRIPT_LIFECYCLE_PLAN).

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/slackwing/manuscript-studio/internal/config"
	"github.com/slackwing/manuscript-studio/internal/models"
)

func gitInitDir(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(path, 0755); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command("git", "init", path).CombinedOutput(); err != nil {
		t.Fatalf("git init: %v (%s)", err, out)
	}
}

func TestMigrateReposLayout(t *testing.T) {
	root := t.TempDir()
	cfg := &config.Config{
		Paths: config.PathsConfig{ReposDir: root},
		GitRepos: []config.GitRepoConfig{
			{Name: "origin-fixture", URL: filepath.Join(root, "origin-fixture")},
		},
	}

	gitInitDir(t, filepath.Join(root, "old-checkout"))   // flat legacy checkout → moves
	gitInitDir(t, filepath.Join(root, "origin-fixture")) // referenced as URL → stays
	if err := os.MkdirAll(filepath.Join(root, "not-a-repo"), 0755); err != nil {
		t.Fatal(err)
	}

	MigrateReposLayout(cfg)

	if _, err := os.Stat(cfg.GitRemoteDir("old-checkout")); err != nil {
		t.Fatalf("old-checkout not moved to git/remote: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "old-checkout")); !os.IsNotExist(err) {
		t.Fatal("old-checkout should be gone from the flat layout")
	}
	if _, err := os.Stat(filepath.Join(root, "origin-fixture", ".git")); err != nil {
		t.Fatalf("origin dir must not move: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "not-a-repo")); err != nil {
		t.Fatalf("non-repo dir must not move: %v", err)
	}

	// Idempotent: a second run changes nothing and doesn't error.
	MigrateReposLayout(cfg)
	if _, err := os.Stat(cfg.GitRemoteDir("old-checkout")); err != nil {
		t.Fatalf("second run broke the moved checkout: %v", err)
	}
}

func TestGitRepoForManuscript(t *testing.T) {
	cfg := &config.Config{
		Paths:    config.PathsConfig{ReposDir: "/data/repos"},
		GitRepos: []config.GitRepoConfig{{Name: "wf-repo", Slug: "me/wf", AuthToken: "tok"}},
	}

	gh, err := gitRepoForManuscript(cfg, &models.Manuscript{
		Name: "wf", Storage: models.StorageGitHub, GitRepoName: "wf-repo",
		GitBranch: "main", FilePath: "book.manuscript",
	})
	if err != nil {
		t.Fatalf("github resolve: %v", err)
	}
	if gh.Path != "/data/repos/git/remote/wf-repo" || gh.RemoteURL != "https://github.com/me/wf.git" ||
		gh.AuthToken != "tok" || gh.Local {
		t.Fatalf("github repo = %+v", gh)
	}

	loc, err := gitRepoForManuscript(cfg, &models.Manuscript{
		Name: "my-book", Storage: models.StorageLocal, FilePath: "book.manuscript",
	})
	if err != nil {
		t.Fatalf("local resolve: %v", err)
	}
	if loc.Path != "/data/repos/git/local/my-book" || !loc.Local || loc.RemoteURL != "" || loc.Branch != "main" {
		t.Fatalf("local repo = %+v", loc)
	}

	if _, err := gitRepoForManuscript(cfg, &models.Manuscript{
		Name: "orphan", Storage: models.StorageGitHub, GitRepoName: "missing",
	}); err == nil {
		t.Fatal("missing registry entry must error")
	}
}
