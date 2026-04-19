package config

import (
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
	if !strings.Contains(err.Error(), "escapes repos_dir") {
		t.Fatalf("expected 'escapes repos_dir' in error, got: %v", err)
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
			SessionSecret: "real-session-secret",
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
		{"empty session secret", func(c *Config) { c.Auth.SessionSecret = "" }, "auth.session_secret"},
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
