package handlers

// Webhook commit-path filter tests (CODE_REVIEW_AUG_2026.md AREA 2 row #106):
// a push triggers a migration only when some commit MODIFIED or ADDED the
// manuscript's file path; Removed-only (and unrelated-path) pushes are
// ignored. Complements admin_test.go's signature/branch-filter coverage.
//
// Since the registry-to-DB refactor (037) the gate is the pure pipeline
// payload.modifiedPaths() → webhookTargets(), so it's tested without a DB
// by feeding the same JSON payloads GitHub would send.

import (
	"encoding/json"
	"testing"

	"github.com/slackwing/manuscript-studio/internal/models"
)

func TestWebhook_ModifiedAddedPaths(t *testing.T) {
	rows := []*models.Manuscript{{ManuscriptID: 1, Name: "wf", GitBranch: "main", FilePath: "manuscript.md"}}

	base := func(commits []map[string]any) map[string]any {
		return map[string]any{
			"ref": "refs/heads/main",
			"repository": map[string]any{
				"name": "wf", "full_name": "owner/wf",
				"clone_url": "https://github.com/owner/wf.git",
			},
			"commits":     commits,
			"head_commit": map[string]any{"id": "deadbeef"},
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
			raw, err := json.Marshal(base(tc.commits))
			if err != nil {
				t.Fatalf("marshal payload: %v", err)
			}
			var payload GitHubWebhookPayload
			if err := json.Unmarshal(raw, &payload); err != nil {
				t.Fatalf("unmarshal payload: %v", err)
			}

			targets := webhookTargets(rows, payload.Ref, payload.modifiedPaths())
			if tc.wantTrigger && len(targets) != 1 {
				t.Fatalf("expected the manuscript to be targeted, got %d targets", len(targets))
			}
			if !tc.wantTrigger && len(targets) != 0 {
				t.Fatalf("expected no targets, got %d", len(targets))
			}
		})
	}
}
