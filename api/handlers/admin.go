package handlers

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"

	"github.com/slackwing/manuscript-studio/internal/config"
	"github.com/slackwing/manuscript-studio/internal/database"
	"github.com/slackwing/manuscript-studio/internal/migrations"
)

// AdminHandlers contains admin/system-level handlers
type AdminHandlers struct {
	DB        *database.DB
	Config    *config.Config
	Processor *migrations.Processor
}

// GitHubWebhookPayload represents the webhook payload from GitHub
type GitHubWebhookPayload struct {
	Ref        string `json:"ref"`        // refs/heads/main
	Repository struct {
		Name     string `json:"name"`
		FullName string `json:"full_name"`
		CloneURL string `json:"clone_url"`
	} `json:"repository"`
	Commits []struct {
		ID      string   `json:"id"`
		Message string   `json:"message"`
		Added   []string `json:"added"`
		Modified []string `json:"modified"`
		Removed  []string `json:"removed"`
	} `json:"commits"`
	HeadCommit struct {
		ID string `json:"id"`
	} `json:"head_commit"`
}

// HandleWebhook processes GitHub webhook push events
func (h *AdminHandlers) HandleWebhook(w http.ResponseWriter, r *http.Request) {
	// Read body
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "Failed to read request body", http.StatusBadRequest)
		return
	}

	// Verify signature
	signature := r.Header.Get("X-Hub-Signature-256")
	if !h.validateGitHubSignature(body, signature, h.Config.Auth.WebhookSecret) {
		http.Error(w, "Invalid signature", http.StatusForbidden)
		return
	}

	// Parse payload
	var payload GitHubWebhookPayload
	if err := json.Unmarshal(body, &payload); err != nil {
		http.Error(w, "Invalid payload", http.StatusBadRequest)
		return
	}

	// Check if this is a push to the tracked branch
	// Find which manuscript this webhook is for
	var manuscriptConfig *config.ManuscriptConfig
	for _, m := range h.Config.Manuscripts {
		if m.Repository.URL == payload.Repository.CloneURL {
			manuscriptConfig = &m
			break
		}
	}

	if manuscriptConfig == nil {
		log.Printf("Webhook received for unknown repository: %s", payload.Repository.CloneURL)
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"ignored","reason":"repository not configured"}`))
		return
	}

	// Check if any commits modified the manuscript file
	manuscriptModified := false
	for _, commit := range payload.Commits {
		for _, file := range commit.Modified {
			if file == manuscriptConfig.Repository.Path {
				manuscriptModified = true
				break
			}
		}
		if !manuscriptModified {
			for _, file := range commit.Added {
				if file == manuscriptConfig.Repository.Path {
					manuscriptModified = true
					break
				}
			}
		}
	}

	if !manuscriptModified {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"ignored","reason":"manuscript not modified"}`))
		return
	}

	// Trigger migration processing
	// This should be done asynchronously in production
	go h.processMigration(manuscriptConfig, payload.HeadCommit.ID)

	w.WriteHeader(http.StatusAccepted)
	w.Write([]byte(`{"status":"accepted","message":"migration processing started"}`))
}

// HandleSync manually triggers a sync for a manuscript
func (h *AdminHandlers) HandleSync(w http.ResponseWriter, r *http.Request) {
	// Verify system token
	authHeader := r.Header.Get("Authorization")
	expectedToken := "Bearer " + h.Config.Auth.SystemToken
	if authHeader != expectedToken {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}

	// Parse request
	var req struct {
		ManuscriptName string `json:"manuscript_name"`
		CommitHash     string `json:"commit_hash,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	// Find manuscript config
	manuscriptConfig, err := h.Config.GetManuscript(req.ManuscriptName)
	if err != nil {
		http.Error(w, "Manuscript not found", http.StatusNotFound)
		return
	}

	// If no commit hash specified, get latest
	commitHash := req.CommitHash
	if commitHash == "" {
		// TODO: Get latest commit from git
		commitHash = "HEAD"
	}

	// Trigger migration processing
	go h.processMigration(manuscriptConfig, commitHash)

	w.WriteHeader(http.StatusAccepted)
	w.Write([]byte(`{"status":"accepted","message":"sync started"}`))
}

// HandleStatus returns the status of ongoing migrations
func (h *AdminHandlers) HandleStatus(w http.ResponseWriter, r *http.Request) {
	// Verify system token
	authHeader := r.Header.Get("Authorization")
	expectedToken := "Bearer " + h.Config.Auth.SystemToken
	if authHeader != expectedToken {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}

	// TODO: Implement migration status tracking
	// For now, return placeholder
	status := map[string]interface{}{
		"migrations_in_progress": 0,
		"last_migration":         nil,
		"status":                 "idle",
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(status)
}

// validateGitHubSignature validates the GitHub webhook signature
func (h *AdminHandlers) validateGitHubSignature(payload []byte, signature string, secret string) bool {
	if signature == "" || secret == "" {
		return false
	}

	// Calculate expected signature
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(payload)
	expectedSig := "sha256=" + hex.EncodeToString(mac.Sum(nil))

	// Compare signatures
	return hmac.Equal([]byte(signature), []byte(expectedSig))
}

// processMigration handles the actual migration processing
func (h *AdminHandlers) processMigration(manuscriptConfig *config.ManuscriptConfig, commitHash string) {
	ctx := context.Background()

	log.Printf("Starting migration for manuscript %s at commit %s", manuscriptConfig.Name, commitHash)

	// Get manuscript from database
	manuscript, err := h.DB.GetManuscript(ctx, manuscriptConfig.Repository.URL, manuscriptConfig.Repository.Path)
	if err != nil {
		log.Printf("Failed to get manuscript: %v", err)
		return
	}

	if manuscript == nil {
		// Create manuscript entry
		manuscript, err = h.DB.CreateManuscript(ctx, manuscriptConfig.Repository.URL, manuscriptConfig.Repository.Path)
		if err != nil {
			log.Printf("Failed to create manuscript: %v", err)
			return
		}
	}

	// Create git repository handler
	gitRepo := migrations.NewGitRepository(
		fmt.Sprintf("%s/%s", h.Config.Paths.ManuscriptRepos, manuscriptConfig.Name),
		manuscriptConfig.Repository.Branch,
		manuscriptConfig.Repository.URL,
		manuscriptConfig.Repository.Path,
		manuscriptConfig.Repository.AuthToken,
	)

	// Clone or pull repository
	if err := gitRepo.Clone(ctx); err != nil {
		log.Printf("Failed to clone repository: %v", err)
		return
	}

	if err := gitRepo.Pull(ctx); err != nil {
		log.Printf("Failed to pull repository: %v", err)
		return
	}

	// Get manuscript content
	content, err := gitRepo.GetFileContent(ctx, commitHash)
	if err != nil {
		log.Printf("Failed to get file content: %v", err)
		return
	}

	// Process migration
	result, err := h.Processor.ProcessManuscript(ctx, manuscript.ManuscriptID, commitHash, content)
	if err != nil {
		log.Printf("Migration failed: %v", err)
		return
	}

	log.Printf("Migration completed: %s", result.Message)
}