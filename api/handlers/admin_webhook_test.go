package handlers

// Webhook commit-path filter tests (CODE_REVIEW_AUG_2026.md AREA 2 row #106):
// a push triggers a migration only when some commit MODIFIED or ADDED the
// configured manuscript path; Removed-only (and unrelated-path) pushes are
// ignored. Complements admin_test.go's signature/branch-filter coverage.
//
// The "would trigger" arm is observed WITHOUT a DB: the payload carries an
// invalid head_commit.id, so a request that passes the modified/added gate
// dies at ValidateCommitRef (400 "Invalid head_commit id") — one step before
// startMigration — while a filtered request returns 200 "ignored".

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/slackwing/manuscript-studio/internal/config"
)

func webhookTestHandlers(secret string) *AdminHandlers {
	return &AdminHandlers{
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
}

func signedWebhookRequest(t *testing.T, secret string, payload map[string]any) *http.Request {
	t.Helper()
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	req := httptest.NewRequest(http.MethodPost, "/api/admin/webhook", strings.NewReader(string(body)))
	req.Header.Set("X-Hub-Signature-256", "sha256="+hex.EncodeToString(mac.Sum(nil)))
	return req
}

func TestHandleWebhook_ModifiedAddedPaths(t *testing.T) {
	const secret = "test-secret"
	base := func(commits []map[string]any) map[string]any {
		return map[string]any{
			"ref": "refs/heads/main",
			"repository": map[string]any{
				"name": "wf", "full_name": "owner/wf",
				"clone_url": "https://github.com/owner/wf.git",
			},
			"commits": commits,
			// Deliberately invalid: passing the modified/added gate must
			// surface as the 400 from ValidateCommitRef, not reach
			// startMigration.
			"head_commit": map[string]any{"id": "not a valid ref !!"},
		}
	}

	cases := []struct {
		name        string
		commits     []map[string]any
		wantTrigger bool
	}{
		{"modified manuscript triggers",
			[]map[string]any{{"id": "c1", "modified": []string{"manuscript.md"}}}, true},
		{"added manuscript triggers",
			[]map[string]any{{"id": "c1", "added": []string{"manuscript.md"}}}, true},
		{"modified in a LATER commit still triggers",
			[]map[string]any{
				{"id": "c1", "modified": []string{"README.md"}},
				{"id": "c2", "modified": []string{"manuscript.md"}},
			}, true},
		{"removed-only is ignored",
			[]map[string]any{{"id": "c1", "removed": []string{"manuscript.md"}}}, false},
		{"unrelated paths are ignored",
			[]map[string]any{{"id": "c1", "modified": []string{"notes.md"}, "added": []string{"img.png"}}}, false},
		{"empty commit list is ignored",
			[]map[string]any{}, false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := webhookTestHandlers(secret)
			rec := httptest.NewRecorder()
			h.HandleWebhook(rec, signedWebhookRequest(t, secret, base(tc.commits)))

			if tc.wantTrigger {
				if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "Invalid head_commit") {
					t.Fatalf("expected to pass the modified/added gate (400 Invalid head_commit), got %d %q",
						rec.Code, rec.Body.String())
				}
			} else {
				if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "manuscript not modified") {
					t.Fatalf("expected 200 ignored/manuscript-not-modified, got %d %q",
						rec.Code, rec.Body.String())
				}
			}
		})
	}
}
