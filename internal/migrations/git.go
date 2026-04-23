package migrations

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

// PreparedCommit is what (*GitRepository).Prepare returns.
type PreparedCommit struct {
	CommitHash string // resolved SHA (HEAD/branch refs are dereferenced)
	BranchName string // current branch name; "" if undetectable
	Content    string // file content at CommitHash
}

// Accepts a 7-40 char hex SHA, the literal "HEAD", or a simple branch name.
// Rejects shell metacharacters — defense-in-depth even though git is invoked
// via exec.Command (no shell). Keeps future refactors and log lines safer.
var commitRefPattern = regexp.MustCompile(`^(?:HEAD|[A-Fa-f0-9]{7,40}|[A-Za-z0-9._/-]+)$`)

// ValidateCommitRef must run at every API boundary that accepts a ref.
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

// GitRepository: AuthToken (when set) is passed via a GIT_ASKPASS helper and
// env var — never via argv or remote URL — so it can't leak into `ps`,
// .git/config, or git's error output.
type GitRepository struct {
	Path      string // local on-disk path
	Branch    string // branch to track
	RemoteURL string // what git clone/pull/fetch use
	FilePath  string // path of the manuscript file inside the repo
	AuthToken string // optional; supplied via GIT_ASKPASS, never via URL
}

// Clone is a no-op if Path is already a git repo.
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

// Prepare brings the clone up to date and returns the resolved SHA, branch
// name, and file content. `ref` may be a SHA, branch, or "HEAD"/"" (both mean
// "latest commit on the configured branch that touched the file"). Pull failure
// is soft — we proceed with local state, since the target commit may already
// be present (typical for webhook-triggered migrations racing CI's push).
// `warnf` surfaces non-fatal events; nil silences them.
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

func (g *GitRepository) Pull(ctx context.Context) error {
	if g.RemoteURL == "" {
		return fmt.Errorf("RemoteURL is empty: set repository.url in your manuscript config")
	}
	if err := g.checkout(ctx); err != nil {
		return fmt.Errorf("failed to checkout branch: %w", err)
	}

	// Scrub any token-in-URL remote left by older versions of this code.
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

func (g *GitRepository) GetFileContent(ctx context.Context, commitHash string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", "-C", g.Path, "show",
		fmt.Sprintf("%s:%s", commitHash, g.FilePath))

	output, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("failed to get file content at commit %s: %w", commitHash, err)
	}

	return string(output), nil
}

// GetLatestCommitHash returns the newest commit that modified FilePath.
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

// GetBranchName returns an error on failure rather than a sentinel; the
// caller picks the fallback.
func (g *GitRepository) GetBranchName(ctx context.Context) (string, error) {
	cmd := exec.CommandContext(ctx, "git", "-C", g.Path, "rev-parse", "--abbrev-ref", "HEAD")

	output, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("failed to get branch name: %w", err)
	}

	return strings.TrimSpace(string(output)), nil
}

// checkout switches to Branch; if it doesn't exist locally, fetches origin
// and creates a tracking branch.
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

// ensureBareRemoteURL rewrites origin to the bare URL, scrubbing any
// https://TOKEN@... left in .git/config by older versions.
func (g *GitRepository) ensureBareRemoteURL(ctx context.Context) error {
	cmd := exec.CommandContext(ctx, "git", "-C", g.Path, "remote", "set-url", "origin", g.RemoteURL)
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to set remote URL: %w", err)
	}
	return nil
}

// WriteCommitPushBranch creates (or force-updates) a branch from a given
// base commit, with `fileContent` as the only change to `g.FilePath`,
// committed as `message` and pushed to `origin`. Uses git plumbing
// (read-tree + hash-object + commit-tree + update-ref) so it never touches
// the working tree or HEAD — safe to call concurrently with the migration
// processor's pull/checkout.
//
// `force` controls whether the push uses --force (used for `update` mode
// where the same branch is overwritten with a fresh commit). For a brand
// new branch, force is typically false.
func (g *GitRepository) WriteCommitPushBranch(
	ctx context.Context,
	baseCommit, branch string,
	fileContent []byte,
	message string,
	force bool,
) (commitSHA string, err error) {
	// 1. Hash the new file content as a blob in the object DB.
	blobCmd := exec.CommandContext(ctx, "git", "-C", g.Path, "hash-object", "-w", "--stdin")
	blobCmd.Stdin = bytes.NewReader(fileContent)
	blobOut, err := blobCmd.Output()
	if err != nil {
		return "", fmt.Errorf("git hash-object: %w", err)
	}
	blobSHA := strings.TrimSpace(string(blobOut))

	// 2. Build a tree based on baseCommit, with the new blob swapped in.
	indexFile, err := os.CreateTemp("", "manuscript-studio-index-*")
	if err != nil {
		return "", fmt.Errorf("temp index: %w", err)
	}
	indexPath := indexFile.Name()
	indexFile.Close()
	defer os.Remove(indexPath)

	indexEnv := append(os.Environ(), "GIT_INDEX_FILE="+indexPath)

	readTree := exec.CommandContext(ctx, "git", "-C", g.Path, "read-tree", baseCommit)
	readTree.Env = indexEnv
	if out, err := readTree.CombinedOutput(); err != nil {
		return "", fmt.Errorf("git read-tree %s: %w (%s)", baseCommit, err, out)
	}

	updateIdx := exec.CommandContext(ctx, "git", "-C", g.Path, "update-index", "--add",
		"--cacheinfo", fmt.Sprintf("100644,%s,%s", blobSHA, g.FilePath))
	updateIdx.Env = indexEnv
	if out, err := updateIdx.CombinedOutput(); err != nil {
		return "", fmt.Errorf("git update-index: %w (%s)", err, out)
	}

	writeTree := exec.CommandContext(ctx, "git", "-C", g.Path, "write-tree")
	writeTree.Env = indexEnv
	treeOut, err := writeTree.Output()
	if err != nil {
		return "", fmt.Errorf("git write-tree: %w", err)
	}
	treeSHA := strings.TrimSpace(string(treeOut))

	// 3. Make a commit with the user-author signature pulled from environment
	// or the manuscript repo's git config (whichever git resolves first).
	commitTree := exec.CommandContext(ctx, "git", "-C", g.Path, "commit-tree",
		treeSHA, "-p", baseCommit, "-m", message)
	commitOut, err := commitTree.Output()
	if err != nil {
		return "", fmt.Errorf("git commit-tree: %w", err)
	}
	commitSHA = strings.TrimSpace(string(commitOut))

	// 4. Move the branch ref to the new commit. update-ref creates the ref if
	// it doesn't exist and overwrites unconditionally if it does — exactly the
	// "update or create" semantics we want, with no policy hooks in the way.
	updateRef := exec.CommandContext(ctx, "git", "-C", g.Path, "update-ref",
		"refs/heads/"+branch, commitSHA)
	if out, err := updateRef.CombinedOutput(); err != nil {
		return "", fmt.Errorf("git update-ref refs/heads/%s: %w (%s)", branch, err, out)
	}

	// 5. Push.
	args := []string{"-C", g.Path, "push", "origin", "refs/heads/" + branch}
	if force {
		args = append(args[:3], append([]string{"--force"}, args[3:]...)...)
	}
	pushCmd, cleanup, err := g.gitCommand(ctx, args...)
	if err != nil {
		return "", err
	}
	defer cleanup()
	if out, err := pushCmd.CombinedOutput(); err != nil {
		return "", fmt.Errorf("git push %s: %w (%s)", branch, err, scrubToken(string(out), g.AuthToken))
	}

	return commitSHA, nil
}

// LocalBranchExists reports whether refs/heads/<branch> exists in the local
// clone. Used to decide between Push and Push New labels in the UI.
func (g *GitRepository) LocalBranchExists(ctx context.Context, branch string) (bool, error) {
	cmd := exec.CommandContext(ctx, "git", "-C", g.Path, "rev-parse", "--verify", "--quiet",
		"refs/heads/"+branch)
	err := cmd.Run()
	if err == nil {
		return true, nil
	}
	if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 1 {
		return false, nil
	}
	return false, fmt.Errorf("rev-parse refs/heads/%s: %w", branch, err)
}

func (g *GitRepository) isGitRepo() bool {
	gitDir := filepath.Join(g.Path, ".git")
	info, err := os.Stat(gitDir)
	return err == nil && info.IsDir()
}

// Always safe to defer.
func noopCleanup() {}

// gitCommand wires a GIT_ASKPASS helper when AuthToken is set so the token
// reaches git via its stdin prompt — never argv or the stored URL. Returns
// a cleanup that removes the helper; always safe to defer.
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
		// Custom name avoids colliding with a user-set GIT_TOKEN.
		"MANUSCRIPT_STUDIO_GIT_TOKEN="+g.AuthToken,
	)
	return cmd, cleanup, nil
}

// Prints the token git asks for (works for both username and password prompts
// since GitHub PATs accept either).
const askpassScript = `#!/bin/sh
printf '%s' "${MANUSCRIPT_STUDIO_GIT_TOKEN}"
`

func writeAskpassHelper() (path string, cleanup func(), err error) {
	f, err := os.CreateTemp("", "manuscript-studio-askpass-*.sh")
	if err != nil {
		return "", noopCleanup, err
	}
	path = f.Name()
	cleanup = func() { _ = os.Remove(path) }

	// Any failure past this point removes the half-written file.
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

// scrubToken defangs any accidental token occurrence before output reaches
// a caller that may log it. Defensive — git shouldn't echo it, but config
// mistakes or future git changes could.
func scrubToken(s, token string) string {
	if token == "" {
		return s
	}
	return strings.ReplaceAll(s, token, "[REDACTED]")
}
