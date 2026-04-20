package handlers

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/slackwing/manuscript-studio/internal/config"
)

// An empty configured token must never authorize, even when the request also
// sends an empty header — guards against a misconfigured prod server treating
// "no token at all" as authorization.
func TestCheckSystemToken_RejectsEmpty(t *testing.T) {
	h := &AdminHandlers{Config: &config.Config{}}
	r := httptest.NewRequest(http.MethodGet, "/api/admin/status", nil)
	if h.checkSystemToken(r) {
		t.Fatal("expected reject when system token is empty")
	}
	r.Header.Set("Authorization", "")
	if h.checkSystemToken(r) {
		t.Fatal("expected reject when system token is empty (with empty header)")
	}
	r.Header.Set("Authorization", "Bearer ")
	if h.checkSystemToken(r) {
		t.Fatal("expected reject when system token is empty (with Bearer-only header)")
	}
}

func TestCheckSystemToken_AcceptsExactMatch(t *testing.T) {
	h := &AdminHandlers{Config: &config.Config{
		Auth: config.AuthConfig{SystemToken: "the-token"},
	}}
	r := httptest.NewRequest(http.MethodGet, "/api/admin/status", nil)
	r.Header.Set("Authorization", "Bearer the-token")
	if !h.checkSystemToken(r) {
		t.Fatal("expected accept on exact match")
	}
}

func TestCheckSystemToken_RejectsMismatch(t *testing.T) {
	h := &AdminHandlers{Config: &config.Config{
		Auth: config.AuthConfig{SystemToken: "the-token"},
	}}
	cases := []string{"", "the-token", "Bearer wrong-token", "Bearer", "bearer the-token"}
	for _, hdr := range cases {
		r := httptest.NewRequest(http.MethodGet, "/api/admin/status", nil)
		if hdr != "" {
			r.Header.Set("Authorization", hdr)
		}
		if h.checkSystemToken(r) {
			t.Errorf("expected reject for header %q", hdr)
		}
	}
}

// An empty webhook secret must not reduce validation to a no-op.
func TestValidateGitHubSignature_RejectsEmptySecret(t *testing.T) {
	h := &AdminHandlers{}
	if h.validateGitHubSignature([]byte("body"), "sha256=anything", "") {
		t.Fatal("validation must reject when secret is empty")
	}
}

// A missing X-Hub-Signature-256 header must never count as valid.
func TestValidateGitHubSignature_RejectsEmptySignature(t *testing.T) {
	h := &AdminHandlers{}
	if h.validateGitHubSignature([]byte("body"), "", "secret") {
		t.Fatal("validation must reject when signature header is missing")
	}
}

// Motivating case: config has SSH `url`, GitHub sends HTTPS `clone_url` —
// slug-based matching is the only thing that makes that work.
func TestMatchManuscriptForWebhook(t *testing.T) {
	manuscripts := []config.ManuscriptConfig{
		{
			Name: "ssh-repo",
			Repository: config.RepositoryConfig{
				Slug: "alice/ssh-repo",
				URL:  "git@github.com:alice/ssh-repo.git",
			},
		},
		{
			Name: "https-only",
			Repository: config.RepositoryConfig{
				URL: "https://github.com/bob/https-only.git",
			},
		},
	}

	cases := []struct {
		name      string
		fullName  string
		cloneURL  string
		wantName  string // empty = expect no match
	}{
		{
			name:     "slug matches full_name regardless of url form",
			fullName: "alice/ssh-repo",
			cloneURL: "https://github.com/alice/ssh-repo.git",
			wantName: "ssh-repo",
		},
		{
			name:     "url fallback works when slug not set",
			fullName: "bob/https-only",
			cloneURL: "https://github.com/bob/https-only.git",
			wantName: "https-only",
		},
		{
			name:     "no slug, url mismatch -> no match",
			fullName: "bob/https-only",
			cloneURL: "https://github.com/bob/different.git",
			wantName: "",
		},
		{
			name:     "slug mismatch and not falling through to url equality on slug-having entries",
			fullName: "alice/wrong",
			cloneURL: "git@github.com:alice/ssh-repo.git",
			wantName: "",
		},
		{
			name:     "unknown repo entirely",
			fullName: "stranger/repo",
			cloneURL: "https://github.com/stranger/repo.git",
			wantName: "",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := matchManuscriptForWebhook(manuscripts, tc.fullName, tc.cloneURL)
			if tc.wantName == "" {
				if got != nil {
					t.Fatalf("expected no match, got %q", got.Name)
				}
				return
			}
			if got == nil {
				t.Fatalf("expected match %q, got nil", tc.wantName)
			}
			if got.Name != tc.wantName {
				t.Fatalf("expected match %q, got %q", tc.wantName, got.Name)
			}
		})
	}
}
