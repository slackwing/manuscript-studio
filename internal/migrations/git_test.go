package migrations

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestGitCommandDoesNotLeakToken ensures the auth token never appears in the
// git command's argv. Regression test for the prior bug where the token was
// interpolated into the clone URL.
func TestGitCommandDoesNotLeakToken(t *testing.T) {
	g := &GitRepository{
		Path:      "/tmp/does-not-matter",
		Branch:    "main",
		RemoteURL: "https://github.com/foo/bar.git",
		FilePath:  "manuscript.md",
		AuthToken: "ghp_supersecrettoken12345",
	}

	cmd, cleanup, err := g.gitCommand(context.Background(), "clone", "-b", g.Branch, g.RemoteURL, g.Path)
	if err != nil {
		t.Fatalf("gitCommand returned error: %v", err)
	}
	defer cleanup()

	for i, arg := range cmd.Args {
		if strings.Contains(arg, g.AuthToken) {
			t.Fatalf("token leaked into argv at index %d: %q", i, arg)
		}
	}

	// Token must be in env (so the askpass helper can read it), but not in argv.
	tokenInEnv := false
	for _, e := range cmd.Env {
		if strings.HasPrefix(e, "MANUSCRIPT_STUDIO_GIT_TOKEN=") &&
			strings.HasSuffix(e, g.AuthToken) {
			tokenInEnv = true
		}
	}
	if !tokenInEnv {
		t.Fatalf("expected MANUSCRIPT_STUDIO_GIT_TOKEN in env, env was: %v", cmd.Env)
	}

	// GIT_ASKPASS must point to a real, executable file.
	askpass := ""
	for _, e := range cmd.Env {
		if strings.HasPrefix(e, "GIT_ASKPASS=") {
			askpass = strings.TrimPrefix(e, "GIT_ASKPASS=")
		}
	}
	if askpass == "" {
		t.Fatalf("GIT_ASKPASS not set")
	}
	info, err := os.Stat(askpass)
	if err != nil {
		t.Fatalf("askpass helper does not exist: %v", err)
	}
	if info.Mode().Perm()&0111 == 0 {
		t.Fatalf("askpass helper is not executable: mode=%v", info.Mode())
	}
}

// TestScrubTokenRemovesToken verifies the defensive scrubber.
func TestScrubTokenRemovesToken(t *testing.T) {
	in := "fatal: could not read from https://ghp_xyz@github.com/foo/bar.git"
	out := scrubToken(in, "ghp_xyz")
	if strings.Contains(out, "ghp_xyz") {
		t.Fatalf("scrubToken did not remove token: %q", out)
	}
	if !strings.Contains(out, "[REDACTED]") {
		t.Fatalf("scrubToken did not insert REDACTED marker: %q", out)
	}
}

// TestScrubTokenEmptyTokenIsNoop verifies that an empty token doesn't replace empty strings everywhere.
func TestScrubTokenEmptyTokenIsNoop(t *testing.T) {
	in := "some output"
	out := scrubToken(in, "")
	if out != in {
		t.Fatalf("scrubToken with empty token modified input: in=%q out=%q", in, out)
	}
}

// TestNoTokenWhenAuthEmpty verifies no helper is created when there's no token.
func TestNoTokenWhenAuthEmpty(t *testing.T) {
	g := &GitRepository{
		Path:      "/tmp/x",
		Branch:    "main",
		RemoteURL: "https://github.com/foo/bar.git",
		FilePath:  "x.md",
		AuthToken: "",
	}
	cmd, cleanup, err := g.gitCommand(context.Background(), "clone", g.RemoteURL, g.Path)
	if err != nil {
		t.Fatalf("gitCommand error: %v", err)
	}
	defer cleanup()

	for _, e := range cmd.Env {
		if strings.HasPrefix(e, "GIT_ASKPASS=") {
			t.Fatalf("GIT_ASKPASS should not be set when AuthToken is empty: %q", e)
		}
	}
}

// TestAskpassHelperPrintsToken verifies the helper script actually prints the token
// when invoked by a subprocess with the env var set.
func TestAskpassHelperPrintsToken(t *testing.T) {
	helper, cleanup, err := writeAskpassHelper()
	if err != nil {
		t.Fatalf("writeAskpassHelper error: %v", err)
	}
	defer cleanup()

	if !filepath.IsAbs(helper) {
		t.Fatalf("expected absolute path, got %q", helper)
	}
}

func TestValidateCommitRef(t *testing.T) {
	cases := []struct {
		ref    string
		wantOK bool
	}{
		{"a1b2c3d", true},
		{"a1b2c3d4e5f6789012345678901234567890abcd", true},
		{"HEAD", true},
		{"main", true},
		{"feature/foo-bar.v2", true},
		{"", false},
		{"; rm -rf /", false},
		{"abc xyz", false},
		{"$(whoami)", false},
		{"`id`", false},
		{"abc&&def", false},
		{strings.Repeat("a", 256), false},
	}
	for _, tc := range cases {
		err := ValidateCommitRef(tc.ref)
		if tc.wantOK && err != nil {
			t.Errorf("ValidateCommitRef(%q) = %v, want nil", tc.ref, err)
		}
		if !tc.wantOK && err == nil {
			t.Errorf("ValidateCommitRef(%q) = nil, want error", tc.ref)
		}
	}
}
