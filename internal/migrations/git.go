package migrations

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

// PreparedCommit is the everything-we-need-from-git bundle returned by
// (*GitRepository).Prepare.
type PreparedCommit struct {
	CommitHash string // resolved SHA (HEAD/branch refs are dereferenced)
	BranchName string // current branch name; "" if undetectable
	Content    string // file content at CommitHash
}

// commitRefPattern accepts:
//   - a 7-to-40-character hex SHA (full or short)
//   - the literal "HEAD"
//   - a simple branch name [A-Za-z0-9._/-]+
//
// This rejects shell metacharacters before they can reach git. Even though
// we always invoke git via exec.Command (not a shell), keeping the input
// shape narrow protects against future refactors and makes log lines safer.
var commitRefPattern = regexp.MustCompile(`^(?:HEAD|[A-Fa-f0-9]{7,40}|[A-Za-z0-9._/-]+)$`)

// ValidateCommitRef returns nil if ref looks like a safe commit hash or
// branch reference. Use at every API boundary that accepts a ref.
func ValidateCommitRef(ref string) error {
	if ref == "" {
		return fmt.Errorf("commit ref is empty")
	}
	if len(ref) > 255 {
		return fmt.Errorf("commit ref too long (%d chars)", len(ref))
	}
	if !commitRefPattern.MatchString(ref) {
		return fmt.Errorf("commit ref %q has invalid format", ref)
	}
	return nil
}

// GitRepository handles git operations for a manuscript repository.
//
// AuthToken (when non-empty) is supplied to git via a GIT_ASKPASS helper
// script and an environment variable, never via argv or the remote URL.
// This prevents the token from appearing in `ps`, in remote `.git/config`,
// or in error output from git itself.
//
// Construct with a struct literal — the field set is small enough that the
// positional constructor it used to have was just adding noise.
type GitRepository struct {
	Path      string // local on-disk path
	Branch    string // branch to track
	RemoteURL string // what git clone/pull/fetch use
	FilePath  string // path of the manuscript file inside the repo
	AuthToken string // optional; supplied via GIT_ASKPASS, never via URL
}

// Clone clones the repository if it doesn't exist.
func (g *GitRepository) Clone(ctx context.Context) error {
	if g.RemoteURL == "" {
		return fmt.Errorf("RemoteURL is empty: set repository.url in your manuscript config")
	}
	if _, err := os.Stat(g.Path); err == nil {
		if g.isGitRepo() {
			return nil
		}
		return fmt.Errorf("directory %s exists but is not a git repository", g.Path)
	}

	parentDir := filepath.Dir(g.Path)
	if err := os.MkdirAll(parentDir, 0755); err != nil {
		return fmt.Errorf("failed to create parent directory: %w", err)
	}

	cmd, cleanup, err := g.gitCommand(ctx, "clone", "-b", g.Branch, g.RemoteURL, g.Path)
	if err != nil {
		return err
	}
	defer cleanup()

	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("git clone failed: %w\nOutput: %s", err, scrubToken(string(output), g.AuthToken))
	}
	return nil
}

// Prepare brings the local clone up to date and returns the resolved commit
// SHA, current branch name, and file content for the manuscript file at
// that commit.
//
// `ref` may be a SHA, a branch name, or "HEAD" / "" (both treated as "use
// the latest commit on the configured branch that touched the manuscript
// file"). A pull failure is treated as a soft warning — we proceed with
// whatever's on disk — because the same commit may already be present
// locally (typical for webhook-triggered migrations that race CI's push).
//
// `warnf` is called for non-fatal events worth surfacing (typically a
// pull failure). Pass nil to silence them.
func (g *GitRepository) Prepare(ctx context.Context, ref string, warnf func(format string, args ...any)) (*PreparedCommit, error) {
	if warnf == nil {
		warnf = func(string, ...any) {}
	}
	if err := g.Clone(ctx); err != nil {
		return nil, fmt.Errorf("clone: %w", err)
	}
	if err := g.Pull(ctx); err != nil {
		warnf("git pull failed (continuing with local HEAD): %v", err)
	}

	commit := ref
	if commit == "" || commit == "HEAD" {
		resolved, err := g.GetLatestCommitHash(ctx)
		if err != nil {
			return nil, fmt.Errorf("resolve HEAD: %w", err)
		}
		commit = resolved
	}

	branch, err := g.GetBranchName(ctx)
	if err != nil {
		warnf("could not read branch name (continuing): %v", err)
		branch = ""
	}

	content, err := g.GetFileContent(ctx, commit)
	if err != nil {
		return nil, fmt.Errorf("read content: %w", err)
	}
	return &PreparedCommit{CommitHash: commit, BranchName: branch, Content: content}, nil
}

// Pull pulls the latest changes from the remote.
func (g *GitRepository) Pull(ctx context.Context) error {
	if g.RemoteURL == "" {
		return fmt.Errorf("RemoteURL is empty: set repository.url in your manuscript config")
	}
	if err := g.checkout(ctx); err != nil {
		return fmt.Errorf("failed to checkout branch: %w", err)
	}

	// Make sure the remote URL is the bare URL (no token leftovers from older
	// versions of this code that interpolated the token into the URL).
	if err := g.ensureBareRemoteURL(ctx); err != nil {
		return fmt.Errorf("failed to set remote URL: %w", err)
	}

	cmd, cleanup, err := g.gitCommand(ctx, "-C", g.Path, "pull", "origin", g.Branch)
	if err != nil {
		return err
	}
	defer cleanup()

	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("git pull failed: %w\nOutput: %s", err, scrubToken(string(output), g.AuthToken))
	}
	return nil
}

// GetFileContent retrieves the content of the manuscript file at a specific commit.
func (g *GitRepository) GetFileContent(ctx context.Context, commitHash string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", "-C", g.Path, "show",
		fmt.Sprintf("%s:%s", commitHash, g.FilePath))

	output, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("failed to get file content at commit %s: %w", commitHash, err)
	}

	return string(output), nil
}

// GetLatestCommitHash gets the latest commit hash that modified the manuscript file.
func (g *GitRepository) GetLatestCommitHash(ctx context.Context) (string, error) {
	cmd := exec.CommandContext(ctx, "git", "-C", g.Path, "log",
		"-n", "1", "--format=%H", "--", g.FilePath)

	output, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("failed to get latest commit: %w", err)
	}

	hash := strings.TrimSpace(string(output))
	if hash == "" {
		return "", fmt.Errorf("no commits found for file %s", g.FilePath)
	}

	return hash, nil
}

// GetBranchName gets the current branch name. Returns an error on failure
// rather than a sentinel string — the caller decides how to fall back.
func (g *GitRepository) GetBranchName(ctx context.Context) (string, error) {
	cmd := exec.CommandContext(ctx, "git", "-C", g.Path, "rev-parse", "--abbrev-ref", "HEAD")

	output, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("failed to get branch name: %w", err)
	}

	return strings.TrimSpace(string(output)), nil
}

// checkout switches to the configured branch. If the branch doesn't exist
// locally, fetches from origin and checks out a tracking branch.
func (g *GitRepository) checkout(ctx context.Context) error {
	if err := exec.CommandContext(ctx, "git", "-C", g.Path, "checkout", g.Branch).Run(); err == nil {
		return nil
	}

	fetchCmd, cleanup, err := g.gitCommand(ctx, "-C", g.Path, "fetch", "origin", g.Branch)
	if err != nil {
		return err
	}
	defer cleanup()
	if out, err := fetchCmd.CombinedOutput(); err != nil {
		return fmt.Errorf("git fetch %s failed: %w\nOutput: %s", g.Branch, err, scrubToken(string(out), g.AuthToken))
	}

	out, err := exec.CommandContext(ctx, "git", "-C", g.Path, "checkout", "-b", g.Branch, "origin/"+g.Branch).CombinedOutput()
	if err != nil {
		return fmt.Errorf("git checkout -b %s origin/%s failed: %w\nOutput: %s", g.Branch, g.Branch, err, string(out))
	}
	return nil
}

// ensureBareRemoteURL sets origin to the bare RemoteURL (no embedded token).
// Older versions of this code stored https://TOKEN@github.com/... in
// .git/config; this rewrites it to the clean URL.
func (g *GitRepository) ensureBareRemoteURL(ctx context.Context) error {
	cmd := exec.CommandContext(ctx, "git", "-C", g.Path, "remote", "set-url", "origin", g.RemoteURL)
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to set remote URL: %w", err)
	}
	return nil
}

// isGitRepo checks if the path is a git repository.
func (g *GitRepository) isGitRepo() bool {
	gitDir := filepath.Join(g.Path, ".git")
	info, err := os.Stat(gitDir)
	return err == nil && info.IsDir()
}

// noopCleanup is returned when there's nothing for the caller to clean up;
// callers can defer it unconditionally.
func noopCleanup() {}

// gitCommand builds an exec.Cmd for a git invocation. When AuthToken is
// non-empty, it wires up a GIT_ASKPASS helper so the token is supplied
// to git over its stdin prompt — never via argv or via the stored remote
// URL — and returns a cleanup func that deletes the helper script.
//
// The returned cleanup is always safe to defer.
func (g *GitRepository) gitCommand(ctx context.Context, args ...string) (*exec.Cmd, func(), error) {
	cmd := exec.CommandContext(ctx, "git", args...)
	env := append(os.Environ(), "GIT_TERMINAL_PROMPT=0")

	if g.AuthToken == "" {
		cmd.Env = env
		return cmd, noopCleanup, nil
	}

	helper, cleanup, err := writeAskpassHelper()
	if err != nil {
		return nil, noopCleanup, fmt.Errorf("create askpass helper: %w", err)
	}
	cmd.Env = append(env,
		"GIT_ASKPASS="+helper,
		// Helper reads MANUSCRIPT_STUDIO_GIT_TOKEN from its env. Custom
		// name avoids collision with any user-set GIT_TOKEN.
		"MANUSCRIPT_STUDIO_GIT_TOKEN="+g.AuthToken,
	)
	return cmd, cleanup, nil
}

// askpassScript prints the token git needs for password (and username,
// since GitHub PATs work either way) prompts. The token comes from the
// parent process's MANUSCRIPT_STUDIO_GIT_TOKEN env var.
const askpassScript = `#!/bin/sh
printf '%s' "${MANUSCRIPT_STUDIO_GIT_TOKEN}"
`

// writeAskpassHelper writes the askpass script to a private temp file and
// returns the path plus a cleanup func that deletes it.
func writeAskpassHelper() (path string, cleanup func(), err error) {
	f, err := os.CreateTemp("", "manuscript-studio-askpass-*.sh")
	if err != nil {
		return "", noopCleanup, err
	}
	path = f.Name()
	cleanup = func() { _ = os.Remove(path) }

	// Any failure past this point should clean up the half-written file.
	defer func() {
		if err != nil {
			cleanup()
			path, cleanup = "", noopCleanup
		}
	}()

	if _, err = f.WriteString(askpassScript); err != nil {
		f.Close()
		return
	}
	if err = f.Close(); err != nil {
		return
	}
	err = os.Chmod(path, 0700)
	return
}

// scrubToken removes any accidental occurrence of the auth token from a
// string before it's returned to a caller (which may log it). Defensive:
// git itself shouldn't echo the token, but if a user misconfigures something
// or git's behavior changes, we don't want to leak.
func scrubToken(s, token string) string {
	if token == "" {
		return s
	}
	return strings.ReplaceAll(s, token, "[REDACTED]")
}
