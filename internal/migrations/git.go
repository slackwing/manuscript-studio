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
type GitRepository struct {
	Path      string
	Branch    string
	AuthToken string
	RemoteURL string
	FilePath  string
}

// NewGitRepository creates a new git repository handler.
func NewGitRepository(path, branch, remoteURL, filePath, authToken string) *GitRepository {
	return &GitRepository{
		Path:      path,
		Branch:    branch,
		RemoteURL: remoteURL,
		FilePath:  filePath,
		AuthToken: authToken,
	}
}

// Clone clones the repository if it doesn't exist.
func (g *GitRepository) Clone(ctx context.Context) error {
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

// Pull pulls the latest changes from the remote.
func (g *GitRepository) Pull(ctx context.Context) error {
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

// checkout switches to the configured branch.
func (g *GitRepository) checkout(ctx context.Context) error {
	cmd := exec.CommandContext(ctx, "git", "-C", g.Path, "checkout", g.Branch)
	if err := cmd.Run(); err == nil {
		return nil
	}

	fetchCmd, cleanup, err := g.gitCommand(ctx, "-C", g.Path, "fetch", "origin", g.Branch)
	if err != nil {
		return err
	}
	defer cleanup()
	if err := fetchCmd.Run(); err != nil {
		return fmt.Errorf("failed to fetch branch %s: %w", g.Branch, err)
	}

	checkoutCmd := exec.CommandContext(ctx, "git", "-C", g.Path, "checkout", "-b", g.Branch, fmt.Sprintf("origin/%s", g.Branch))
	if err := checkoutCmd.Run(); err != nil {
		return fmt.Errorf("failed to checkout branch %s: %w", g.Branch, err)
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

// ValidateCommit checks if a commit exists and contains the manuscript file.
func (g *GitRepository) ValidateCommit(ctx context.Context, commitHash string) error {
	cmd := exec.CommandContext(ctx, "git", "-C", g.Path, "rev-parse", commitHash)
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("commit %s does not exist", commitHash)
	}

	cmd = exec.CommandContext(ctx, "git", "-C", g.Path, "ls-tree", commitHash, g.FilePath)
	output, err := cmd.Output()
	if err != nil || len(output) == 0 {
		return fmt.Errorf("file %s does not exist in commit %s", g.FilePath, commitHash)
	}
	return nil
}

// gitCommand builds an exec.Cmd for a git invocation that may need to
// authenticate. Authentication is supplied via a GIT_ASKPASS helper script
// and an environment variable, so the token never appears in argv or in
// the repository's stored remote URL.
//
// The returned cleanup function deletes the helper script. It is always
// safe to call (even if the script wasn't created).
func (g *GitRepository) gitCommand(ctx context.Context, args ...string) (*exec.Cmd, func(), error) {
	cmd := exec.CommandContext(ctx, "git", args...)
	env := append(os.Environ(),
		"GIT_TERMINAL_PROMPT=0", // never block on a TTY prompt
	)

	if g.AuthToken == "" {
		cmd.Env = env
		return cmd, func() {}, nil
	}

	helper, cleanup, err := writeAskpassHelper()
	if err != nil {
		return nil, func() {}, fmt.Errorf("failed to create askpass helper: %w", err)
	}

	env = append(env,
		"GIT_ASKPASS="+helper,
		// The helper reads MANUSCRIPT_STUDIO_GIT_TOKEN from its environment.
		// Using a custom name avoids collision with any user-set GIT_TOKEN.
		"MANUSCRIPT_STUDIO_GIT_TOKEN="+g.AuthToken,
	)
	cmd.Env = env
	return cmd, cleanup, nil
}

// writeAskpassHelper writes a small shell script that prints the token to
// stdout. Git invokes it for both the username and password prompts; for
// HTTPS to GitHub the username is irrelevant when a PAT is used as the
// password, so we just print the token in both cases.
func writeAskpassHelper() (string, func(), error) {
	f, err := os.CreateTemp("", "manuscript-studio-askpass-*.sh")
	if err != nil {
		return "", func() {}, err
	}
	path := f.Name()
	cleanup := func() { _ = os.Remove(path) }

	script := `#!/bin/sh
# Auto-generated. Prints the manuscript-studio git token for git's askpass prompts.
# The token is supplied via the MANUSCRIPT_STUDIO_GIT_TOKEN env var by the parent process.
printf '%s' "${MANUSCRIPT_STUDIO_GIT_TOKEN}"
`
	if _, err := f.WriteString(script); err != nil {
		f.Close()
		cleanup()
		return "", func() {}, err
	}
	if err := f.Close(); err != nil {
		cleanup()
		return "", func() {}, err
	}
	if err := os.Chmod(path, 0700); err != nil {
		cleanup()
		return "", func() {}, err
	}
	return path, cleanup, nil
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
