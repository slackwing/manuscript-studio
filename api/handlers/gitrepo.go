package handlers

// Phase 0 of MANUSCRIPT_LIFECYCLE_PLAN: manuscript rows are the registry;
// this file resolves a row (+ config's git_repos credential registry) into
// the migrations.GitRepository all git operations run through, and owns the
// startup reconciliation that migrates legacy state into the new shape.

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"

	"github.com/slackwing/manuscript-studio/internal/config"
	"github.com/slackwing/manuscript-studio/internal/migrations"
	"github.com/slackwing/manuscript-studio/internal/models"
)

// Commits made by the server itself (seeds, local commits) carry this
// author; user-attributed commits pass the username instead.
const (
	serverGitAuthor = "manuscript-studio"
	serverGitEmail  = "manuscript-studio@localhost"
)

// gitRepoForManuscript resolves the row into a ready-to-use GitRepository.
// github mode requires a git_repos registry entry (credentials live only in
// config); local mode needs nothing but the repos dir.
func gitRepoForManuscript(cfg *config.Config, m *models.Manuscript) (*migrations.GitRepository, error) {
	switch m.Storage {
	case models.StorageLocal:
		return &migrations.GitRepository{
			Path:     cfg.GitLocalDir(m.Name),
			Branch:   m.Branch(),
			FilePath: m.FilePath,
			Local:    true,
		}, nil
	default: // github
		rc := cfg.GetGitRepo(m.GitRepoName)
		if rc == nil {
			return nil, fmt.Errorf("manuscript %q references git repo %q which is not in the git_repos registry", m.Name, m.GitRepoName)
		}
		return &migrations.GitRepository{
			Path:      cfg.GitRemoteDir(rc.Name),
			Branch:    m.Branch(),
			RemoteURL: rc.CloneURL(),
			FilePath:  m.FilePath,
			AuthToken: rc.AuthToken,
		}, nil
	}
}

// MigrateReposLayout moves flat legacy checkouts (ReposDir/<name>) into
// ReposDir/git/remote/<name>. Idempotent; errors are logged, never fatal —
// a missed move just means the next sync re-clones.
func MigrateReposLayout(cfg *config.Config) {
	root := cfg.ReposDir()
	entries, err := os.ReadDir(root)
	if err != nil {
		return // no repos dir yet — nothing to migrate
	}

	// Dev-style configs point a repo's clone URL at a directory INSIDE
	// repos_dir (the fixture repo is its own origin). Those are origins,
	// not checkouts — moving them would break every clone/pull against
	// them, so they stay put.
	isOrigin := make(map[string]bool)
	for _, g := range cfg.GitRepos {
		if g.URL != "" {
			if abs, err := filepath.Abs(g.URL); err == nil {
				isOrigin[filepath.Clean(abs)] = true
			}
		}
	}

	for _, e := range entries {
		if !e.IsDir() || e.Name() == "git" {
			continue
		}
		src := filepath.Join(root, e.Name())
		if abs, err := filepath.Abs(src); err == nil && isOrigin[filepath.Clean(abs)] {
			continue
		}
		if _, err := os.Stat(filepath.Join(src, ".git")); err != nil {
			continue // not a git checkout; leave it alone
		}
		dst := cfg.GitRemoteDir(e.Name())
		if _, err := os.Stat(dst); err == nil {
			continue // already migrated (or name collision — don't clobber)
		}
		if err := os.MkdirAll(filepath.Dir(dst), 0755); err != nil {
			log.Printf("repos layout: mkdir %s: %v", filepath.Dir(dst), err)
			continue
		}
		if err := os.Rename(src, dst); err != nil {
			log.Printf("repos layout: move %s -> %s: %v", src, dst, err)
			continue
		}
		log.Printf("repos layout: moved %s -> %s", src, dst)
	}
}

// ReconcileRegistry upserts every legacy config manuscripts: entry into the
// manuscript table (name/storage/git_repo_name/git_branch). Runs once at
// startup, after MigrateReposLayout. Errors are logged, never fatal.
func (h *AdminHandlers) ReconcileRegistry(ctx context.Context) {
	for _, m := range h.Config.Manuscripts {
		cloneURL := m.Repository.CloneURL()
		if cloneURL == "" {
			log.Printf("reconcile: manuscript %q has neither slug nor url; skipping", m.Name)
			continue
		}
		branch := m.Repository.Branch
		if branch == "" {
			branch = "main"
		}
		row, err := h.DB.ReconcileManuscriptFromConfig(ctx, m.Name, cloneURL, m.Repository.Path, m.Name, branch)
		if err != nil {
			log.Printf("reconcile: %v", err)
			continue
		}
		if row.Name != m.Name {
			// Row predates 037 and was already named differently — surface it.
			log.Printf("reconcile: config manuscript %q maps to existing row named %q (manuscript_id=%d); config name ignored",
				m.Name, row.Name, row.ManuscriptID)
		}
	}
}
