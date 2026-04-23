package handlers

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"strings"
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

// Webhook ignores pushes to any branch other than the configured one.
// Critical because the upcoming push-to-PR feature creates suggestions-*
// branches that GitHub will fire push webhooks for; without the filter,
// every PR branch would trigger a migration of the wrong commit as if
// it were the canonical history.
func TestHandleWebhook_IgnoresNonTrackedBranch(t *testing.T) {
	const secret = "test-secret"
	h := &AdminHandlers{
		Config: &config.Config{
			Auth: config.AuthConfig{WebhookSecret: secret},
			Manuscripts: []config.ManuscriptConfig{{
				Name: "wf",
				Repository: config.RepositoryConfig{
					Slug:   "owner/wf",
					Branch: "main",
					Path:   "manuscript.md",
				},
			}},
		},
	}

	cases := []struct {
		name       string
		ref        string
		wantStatus int
		wantBody   string
	}{
		{"push to main matches → not ignored on branch grounds",
			"refs/heads/main", http.StatusOK, "non-tracked"},
		{"push to feature branch is ignored",
			"refs/heads/suggestions-abc-test", http.StatusOK, "non-tracked"},
		{"push to a tag is ignored",
			"refs/tags/v1.0", http.StatusOK, "non-tracked"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			body := `{"ref":"` + tc.ref + `","repository":{"name":"wf","full_name":"owner/wf","clone_url":"https://github.com/owner/wf.git"},"commits":[],"head_commit":{"id":"deadbeef"}}`
			mac := hmac.New(sha256.New, []byte(secret))
			mac.Write([]byte(body))
			sig := "sha256=" + hex.EncodeToString(mac.Sum(nil))

			req := httptest.NewRequest(http.MethodPost, "/api/admin/webhook", strings.NewReader(body))
			req.Header.Set("X-Hub-Signature-256", sig)
			rec := httptest.NewRecorder()

			h.HandleWebhook(rec, req)

			if rec.Code != tc.wantStatus {
				t.Fatalf("status=%d body=%q", rec.Code, rec.Body.String())
			}
			// "main" case should pass the branch check; the fact that no commits
			// modify the manuscript path means the next gate ignores it as
			// "manuscript not modified" — but NOT as "non-tracked branch".
			isMainCase := tc.ref == "refs/heads/main"
			gotNonTracked := strings.Contains(rec.Body.String(), "non-tracked")
			if isMainCase && gotNonTracked {
				t.Fatalf("main branch should not be filtered as non-tracked: %s", rec.Body.String())
			}
			if !isMainCase && !gotNonTracked {
				t.Fatalf("non-main branch should be filtered as non-tracked: %s", rec.Body.String())
			}
		})
	}
}
