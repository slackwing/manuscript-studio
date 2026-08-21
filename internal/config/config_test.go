package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestValidateManuscriptPaths_AllInside(t *testing.T) {
	c := &Config{
		Paths:       PathsConfig{ReposDir: "/tmp/repos"},
		Manuscripts: []ManuscriptConfig{{Name: "alpha"}, {Name: "beta"}},
	}
	if err := c.ValidateManuscriptPaths(); err != nil {
		t.Fatalf("expected pass, got: %v", err)
	}
}

func TestValidateManuscriptPaths_NameWithTraversalEscapes(t *testing.T) {
	c := &Config{
		Paths:       PathsConfig{ReposDir: "/tmp/repos"},
		Manuscripts: []ManuscriptConfig{{Name: "../../../etc"}},
	}
	err := c.ValidateManuscriptPaths()
	if err == nil {
		t.Fatalf("expected escape rejection")
	}
	// Since 037 the rejection happens at the name level (single clean
	// segment) rather than by path-prefix comparison.
	if !strings.Contains(err.Error(), "plain directory name") {
		t.Fatalf("expected plain-directory-name rejection, got: %v", err)
	}
}

func TestValidateManuscriptPaths_EmptyName(t *testing.T) {
	c := &Config{
		Paths:       PathsConfig{ReposDir: "/tmp/repos"},
		Manuscripts: []ManuscriptConfig{{Name: ""}},
	}
	if err := c.ValidateManuscriptPaths(); err == nil {
		t.Fatalf("expected empty-name rejection")
	}
}

func TestCloneURL(t *testing.T) {
	cases := []struct {
		name string
		in   RepositoryConfig
		want string
	}{
		{"slug + default ssh=false → https", RepositoryConfig{Slug: "alice/repo"}, "https://github.com/alice/repo.git"},
		{"slug + ssh=true → ssh", RepositoryConfig{Slug: "alice/repo", UseSSH: true}, "git@github.com:alice/repo.git"},
		{"explicit url overrides slug+ssh", RepositoryConfig{Slug: "alice/repo", UseSSH: true, URL: "/tmp/local-repo"}, "/tmp/local-repo"},
		{"explicit url overrides slug only", RepositoryConfig{Slug: "alice/repo", URL: "https://example.com/git/repo.git"}, "https://example.com/git/repo.git"},
		{"empty everything → empty", RepositoryConfig{}, ""},
		{"only url set", RepositoryConfig{URL: "/tmp/x"}, "/tmp/x"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := tc.in.CloneURL()
			if got != tc.want {
				t.Errorf("CloneURL() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestValidate_BasePath(t *testing.T) {
	mk := func(bp string) *Config {
		return &Config{
			Paths:  PathsConfig{ReposDir: "/tmp/repos"},
			Server: ServerConfig{Env: "development", BasePath: bp},
		}
	}

	good := []string{"", "/foo", "/foo/bar", "/manuscripts", "/api-v2", "/x.y", "/_a", "/~user"}
	for _, bp := range good {
		if err := mk(bp).Validate(); err != nil {
			t.Errorf("base_path %q rejected unexpectedly: %v", bp, err)
		}
	}

	bad := []string{
		`/foo"onclick="alert(1)`,
		`/foo bar`,
		`/foo<script>`,
		`/foo'`,
		`/foo>`,
	}
	for _, bp := range bad {
		if err := mk(bp).Validate(); err == nil {
			t.Errorf("base_path %q should have been rejected", bp)
		}
	}
}

func baseValidProdConfig() *Config {
	return &Config{
		Database: DatabaseConfig{Password: "real-password"},
		Auth: AuthConfig{
			AdminPassword: "real-admin",
			SystemToken:   "real-system-token",

			WebhookSecret: "real-webhook-secret",
		},
		Server: ServerConfig{Env: "production"},
	}
}

func TestValidate_DevConfigSkipsChecks(t *testing.T) {
	c := &Config{
		Server: ServerConfig{Env: "development"},
		Auth:   AuthConfig{SystemToken: "REPLACE_ME_OR_SERVER_WONT_START"},
	}
	if err := c.Validate(); err != nil {
		t.Fatalf("dev config should not be validated, got: %v", err)
	}
}

func TestValidate_ProdConfigPassesWhenAllSet(t *testing.T) {
	c := baseValidProdConfig()
	if err := c.Validate(); err != nil {
		t.Fatalf("expected pass, got: %v", err)
	}
}

func TestValidate_RejectsEmptySecret(t *testing.T) {
	cases := []struct {
		name    string
		mutate  func(*Config)
		wantSub string
	}{
		{"empty db password", func(c *Config) { c.Database.Password = "" }, "database.password"},
		{"empty admin password", func(c *Config) { c.Auth.AdminPassword = "" }, "auth.admin_password"},
		{"empty system token", func(c *Config) { c.Auth.SystemToken = "" }, "auth.system_token"},

		{"empty webhook secret", func(c *Config) { c.Auth.WebhookSecret = "" }, "auth.webhook_secret"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := baseValidProdConfig()
			tc.mutate(c)
			err := c.Validate()
			if err == nil {
				t.Fatalf("expected error, got nil")
			}
			if !strings.Contains(err.Error(), tc.wantSub) {
				t.Fatalf("error %q missing substring %q", err.Error(), tc.wantSub)
			}
		})
	}
}

func TestValidate_RejectsPlaceholderSecret(t *testing.T) {
	c := baseValidProdConfig()
	c.Auth.SystemToken = "REPLACE_ME_OR_SERVER_WONT_START"
	err := c.Validate()
	if err == nil || !strings.Contains(err.Error(), "REPLACE_ME") {
		t.Fatalf("expected REPLACE_ME rejection, got: %v", err)
	}
}

func TestValidate_RejectsPlaceholderInManuscriptToken(t *testing.T) {
	c := baseValidProdConfig()
	c.Manuscripts = []ManuscriptConfig{
		{Name: "x", Repository: RepositoryConfig{AuthToken: "REPLACE_ME_OR_SERVER_WONT_START"}},
	}
	err := c.Validate()
	if err == nil || !strings.Contains(err.Error(), "manuscripts[0]") {
		t.Fatalf("expected manuscript[0] rejection, got: %v", err)
	}
}

// Regression: `path[0] == '~'` expanded "~user/x" (and any "~foo") into
// $HOME/foo — only "~" and "~/..." should expand.
func TestExpandPath(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skip("no home dir")
	}
	cases := map[string]string{
		"~/repos":        filepath.Join(home, "repos"),
		"~":              home,
		"~otheruser/x":   "~otheruser/x", // must NOT expand
		"/absolute/path": "/absolute/path",
		"relative/path":  "relative/path",
		"":               "",
	}
	for in, want := range cases {
		if got := expandPath(in); got != want {
			t.Errorf("expandPath(%q) = %q, want %q", in, got, want)
		}
	}
}

// Legacy manuscripts: entries synthesize git_repos registry entries of the
// same name; an explicit git_repos entry with that name wins (037).
func TestSynthesizeLegacyGitRepos(t *testing.T) {
	c := &Config{
		GitRepos: []GitRepoConfig{{Name: "explicit", Slug: "me/explicit", AuthToken: "keep"}},
		Manuscripts: []ManuscriptConfig{
			{Name: "legacy", Repository: RepositoryConfig{Slug: "me/legacy", UseSSH: true, AuthToken: "tok"}, WebhookSecret: "sec"},
			{Name: "explicit", Repository: RepositoryConfig{Slug: "me/OVERRIDDEN"}},
		},
	}
	c.synthesizeLegacyGitRepos()

	if g := c.GetGitRepo("legacy"); g == nil || g.Slug != "me/legacy" || !g.UseSSH || g.AuthToken != "tok" || g.WebhookSecret != "sec" {
		t.Fatalf("legacy synthesis = %+v", c.GetGitRepo("legacy"))
	}
	if g := c.GetGitRepo("explicit"); g == nil || g.Slug != "me/explicit" || g.AuthToken != "keep" {
		t.Fatalf("explicit entry should win, got %+v", c.GetGitRepo("explicit"))
	}
	if got := c.GetGitRepo("legacy").CloneURL(); got != "git@github.com:me/legacy.git" {
		t.Fatalf("CloneURL = %q", got)
	}
}

// The git/[local,remote] layout helpers and the local-name path-escape guard.
func TestGitDirLayoutAndLocalNameValidation(t *testing.T) {
	c := &Config{Paths: PathsConfig{ReposDir: "/data/repos"}}
	if got := c.GitRemoteDir("wf"); got != "/data/repos/git/remote/wf" {
		t.Fatalf("GitRemoteDir = %q", got)
	}
	if got := c.GitLocalDir("book"); got != "/data/repos/git/local/book" {
		t.Fatalf("GitLocalDir = %q", got)
	}
	if err := c.ValidateLocalName("fine-name"); err != nil {
		t.Fatalf("ValidateLocalName(fine-name): %v", err)
	}
	if err := c.ValidateLocalName("../../../etc"); err == nil {
		t.Fatal("path-escaping local name must be rejected")
	}
	if err := c.ValidateLocalName(""); err == nil {
		t.Fatal("empty local name must be rejected")
	}
}

// git_repos entries are path-validated like manuscripts.
func TestValidateManuscriptPaths_GitRepos(t *testing.T) {
	c := &Config{
		Paths:    PathsConfig{ReposDir: "/data/repos"},
		GitRepos: []GitRepoConfig{{Name: "../../evil"}},
	}
	if err := c.ValidateManuscriptPaths(); err == nil {
		t.Fatal("escaping git_repos name must be rejected")
	}
	c.GitRepos = []GitRepoConfig{{Name: ""}}
	if err := c.ValidateManuscriptPaths(); err == nil {
		t.Fatal("empty git_repos name must be rejected")
	}
}
