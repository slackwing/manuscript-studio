package handlers

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/slackwing/manuscript-studio/internal/config"
)

// TestCheckSystemToken_RejectsEmpty: an empty configured token must always
// reject, even if the request also presents an empty Authorization header.
// This guards against a misconfigured prod server treating "no token at all"
// as authorization.
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

// TestCheckSystemToken_AcceptsExactMatch ensures the happy path works.
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

// TestCheckSystemToken_RejectsMismatch covers wrong tokens and missing prefix.
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

// TestValidateGitHubSignature_RejectsEmptySecret guards against an
// accidentally-empty webhook secret rendering the validation a no-op.
func TestValidateGitHubSignature_RejectsEmptySecret(t *testing.T) {
	h := &AdminHandlers{}
	if h.validateGitHubSignature([]byte("body"), "sha256=anything", "") {
		t.Fatal("validation must reject when secret is empty")
	}
}

// TestValidateGitHubSignature_RejectsEmptySignature guards against a
// missing X-Hub-Signature-256 header counting as valid.
func TestValidateGitHubSignature_RejectsEmptySignature(t *testing.T) {
	h := &AdminHandlers{}
	if h.validateGitHubSignature([]byte("body"), "", "secret") {
		t.Fatal("validation must reject when signature header is missing")
	}
}
