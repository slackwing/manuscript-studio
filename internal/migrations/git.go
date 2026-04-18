package migrations

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// GitRepository handles git operations for a manuscript repository
type GitRepository struct {
	Path       string
	Branch     string
	AuthToken  string
	RemoteURL  string
	FilePath   string // Path to manuscript file within repo
}

// NewGitRepository creates a new git repository handler
func NewGitRepository(path, branch, remoteURL, filePath, authToken string) *GitRepository {
	return &GitRepository{
		Path:      path,
		Branch:    branch,
		RemoteURL: remoteURL,
		FilePath:  filePath,
		AuthToken: authToken,
	}
}

// Clone clones the repository if it doesn't exist
func (g *GitRepository) Clone(ctx context.Context) error {
	// Check if directory exists
	if _, err := os.Stat(g.Path); err == nil {
		// Directory exists, check if it's a git repo
		if g.isGitRepo() {
			return nil // Already cloned
		}
		return fmt.Errorf("directory %s exists but is not a git repository", g.Path)
	}

	// Create parent directory
	parentDir := filepath.Dir(g.Path)
	if err := os.MkdirAll(parentDir, 0755); err != nil {
		return fmt.Errorf("failed to create parent directory: %w", err)
	}

	// Clone with authentication
	cloneURL := g.getAuthenticatedURL()
	cmd := exec.CommandContext(ctx, "git", "clone", "-b", g.Branch, cloneURL, g.Path)
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0") // Disable password prompt

	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("git clone failed: %w\nOutput: %s", err, output)
	}

	return nil
}

// Pull pulls the latest changes from the remote
func (g *GitRepository) Pull(ctx context.Context) error {
	// Ensure we're on the right branch
	if err := g.checkout(ctx); err != nil {
		return fmt.Errorf("failed to checkout branch: %w", err)
	}

	// Set remote URL with auth token (in case it changed)
	if err := g.setRemoteURL(ctx); err != nil {
		return fmt.Errorf("failed to set remote URL: %w", err)
	}

	// Pull latest changes
	cmd := exec.CommandContext(ctx, "git", "-C", g.Path, "pull", "origin", g.Branch)
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")

	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("git pull failed: %w\nOutput: %s", err, output)
	}

	return nil
}

// GetFileContent retrieves the content of the manuscript file at a specific commit
func (g *GitRepository) GetFileContent(ctx context.Context, commitHash string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", "-C", g.Path, "show",
		fmt.Sprintf("%s:%s", commitHash, g.FilePath))

	output, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("failed to get file content at commit %s: %w", commitHash, err)
	}

	return string(output), nil
}

// GetLatestCommitHash gets the latest commit hash that modified the manuscript file
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

// GetBranchName gets the current branch name
func (g *GitRepository) GetBranchName(ctx context.Context) (string, error) {
	cmd := exec.CommandContext(ctx, "git", "-C", g.Path, "rev-parse", "--abbrev-ref", "HEAD")

	output, err := cmd.Output()
	if err != nil {
		return "unknown", nil
	}

	return strings.TrimSpace(string(output)), nil
}

// checkout switches to the configured branch
func (g *GitRepository) checkout(ctx context.Context) error {
	cmd := exec.CommandContext(ctx, "git", "-C", g.Path, "checkout", g.Branch)

	if err := cmd.Run(); err != nil {
		// Try to fetch and checkout if branch doesn't exist locally
		fetchCmd := exec.CommandContext(ctx, "git", "-C", g.Path, "fetch", "origin", g.Branch)
		if err := fetchCmd.Run(); err != nil {
			return fmt.Errorf("failed to fetch branch %s: %w", g.Branch, err)
		}

		checkoutCmd := exec.CommandContext(ctx, "git", "-C", g.Path, "checkout", "-b", g.Branch, fmt.Sprintf("origin/%s", g.Branch))
		if err := checkoutCmd.Run(); err != nil {
			return fmt.Errorf("failed to checkout branch %s: %w", g.Branch, err)
		}
	}

	return nil
}

// setRemoteURL updates the remote URL with authentication
func (g *GitRepository) setRemoteURL(ctx context.Context) error {
	remoteURL := g.getAuthenticatedURL()
	cmd := exec.CommandContext(ctx, "git", "-C", g.Path, "remote", "set-url", "origin", remoteURL)

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to set remote URL: %w", err)
	}

	return nil
}

// getAuthenticatedURL returns the repository URL with authentication token
func (g *GitRepository) getAuthenticatedURL() string {
	if g.AuthToken == "" {
		return g.RemoteURL
	}

	// For GitHub, insert the token as username
	if strings.Contains(g.RemoteURL, "github.com") {
		// Convert https://github.com/user/repo to https://TOKEN@github.com/user/repo
		url := strings.Replace(g.RemoteURL, "https://", fmt.Sprintf("https://%s@", g.AuthToken), 1)
		return url
	}

	return g.RemoteURL
}

// isGitRepo checks if the path is a git repository
func (g *GitRepository) isGitRepo() bool {
	gitDir := filepath.Join(g.Path, ".git")
	info, err := os.Stat(gitDir)
	return err == nil && info.IsDir()
}

// ValidateCommit checks if a commit exists and contains the manuscript file
func (g *GitRepository) ValidateCommit(ctx context.Context, commitHash string) error {
	// Check if commit exists
	cmd := exec.CommandContext(ctx, "git", "-C", g.Path, "rev-parse", commitHash)
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("commit %s does not exist", commitHash)
	}

	// Check if file exists in commit
	cmd = exec.CommandContext(ctx, "git", "-C", g.Path, "ls-tree", commitHash, g.FilePath)
	output, err := cmd.Output()
	if err != nil || len(output) == 0 {
		return fmt.Errorf("file %s does not exist in commit %s", g.FilePath, commitHash)
	}

	return nil
}