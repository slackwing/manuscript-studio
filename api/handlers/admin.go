package handlers

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"time"

	"github.com/slackwing/manuscript-studio/internal/auth"
	"github.com/slackwing/manuscript-studio/internal/config"
	"github.com/slackwing/manuscript-studio/internal/database"
	"github.com/slackwing/manuscript-studio/internal/migrations"
)

// migrationTimeout caps how long a single migration's goroutine can run
// before we abort it and mark the row 'error'.
const migrationTimeout = 5 * time.Minute


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

	// Verify signature. Failures are logged with the source IP and whether
	// a header was present so an operator can tell a misconfigured webhook
	// from an attacker probing the endpoint.
	signature := r.Header.Get("X-Hub-Signature-256")
	if !h.validateGitHubSignature(body, signature, h.Config.Auth.WebhookSecret) {
		log.Printf("webhook signature rejected: ip=%s sig_present=%t body_len=%d",
			r.RemoteAddr, signature != "", len(body))
		http.Error(w, "Invalid signature", http.StatusForbidden)
		return
	}

	// Parse payload
	var payload GitHubWebhookPayload
	if err := json.Unmarshal(body, &payload); err != nil {
		http.Error(w, "Invalid payload", http.StatusBadRequest)
		return
	}

	manuscriptConfig := matchManuscriptForWebhook(h.Config.Manuscripts, payload.Repository.FullName, payload.Repository.CloneURL)
	if manuscriptConfig == nil {
		log.Printf("Webhook received for unknown repository: full_name=%s clone_url=%s",
			payload.Repository.FullName, payload.Repository.CloneURL)
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

	// Webhook always has a real commit SHA from the payload, so we can
	// dedupe on (manuscript_id, commit_hash, segmenter) before kicking off
	// the goroutine.
	h.startMigration(r.Context(), w, manuscriptConfig, payload.HeadCommit.ID)
}

// HandleSync manually triggers a sync for a manuscript
func (h *AdminHandlers) HandleSync(w http.ResponseWriter, r *http.Request) {
	if !h.checkSystemToken(r) {
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
		commitHash = "HEAD"
	}

	if err := migrations.ValidateCommitRef(commitHash); err != nil {
		http.Error(w, "Invalid commit_hash: "+err.Error(), http.StatusBadRequest)
		return
	}

	h.startMigration(r.Context(), w, manuscriptConfig, commitHash)
}

// HandleStatus returns the state of any in-flight migrations.
// Returns rows currently at status='pending' or 'running'. Empty list means
// nothing is in progress.
func (h *AdminHandlers) HandleStatus(w http.ResponseWriter, r *http.Request) {
	if !h.checkSystemToken(r) {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}

	active, err := h.DB.GetActiveMigrations(r.Context())
	if err != nil {
		http.Error(w, "failed to query migrations", http.StatusInternalServerError)
		log.Printf("HandleStatus: %v", err)
		return
	}

	overall := "idle"
	if len(active) > 0 {
		overall = "in_progress"
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":                 overall,
		"migrations_in_progress": len(active),
		"active":                 active,
	})
}

// HandleCreateUser creates or updates a user. Requires system token.
// Request body: {"username": "...", "password": "...", "role": "author"}
func (h *AdminHandlers) HandleCreateUser(w http.ResponseWriter, r *http.Request) {
	if !h.checkSystemToken(r) {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}

	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
		Role     string `json:"role,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}
	if req.Username == "" || req.Password == "" {
		http.Error(w, "username and password are required", http.StatusBadRequest)
		return
	}
	if err := auth.ValidatePassword(req.Password); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if req.Role == "" {
		req.Role = "author"
	}

	hash, err := auth.HashPassword(req.Password)
	if err != nil {
		http.Error(w, "Failed to hash password", http.StatusInternalServerError)
		return
	}

	// Upsert user: insert or update password_hash on conflict.
	query := `
		INSERT INTO "user" (username, password_hash, role)
		VALUES ($1, $2, $3)
		ON CONFLICT (username) DO UPDATE
		    SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role
	`
	if _, err := h.DB.Pool.Exec(r.Context(), query, req.Username, hash, req.Role); err != nil {
		log.Printf("Failed to upsert user %s: %v", req.Username, err)
		http.Error(w, "Failed to create user", http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusCreated)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"username": req.Username,
		"role":     req.Role,
	})
}

// HandleCreateGrant grants a user access to a manuscript. Requires system token.
// Request body: {"username": "...", "manuscript_name": "..."}
// Idempotent: repeated grants are a no-op.
func (h *AdminHandlers) HandleCreateGrant(w http.ResponseWriter, r *http.Request) {
	if !h.checkSystemToken(r) {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}

	var req struct {
		Username       string `json:"username"`
		ManuscriptName string `json:"manuscript_name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}
	if req.Username == "" || req.ManuscriptName == "" {
		http.Error(w, "username and manuscript_name are required", http.StatusBadRequest)
		return
	}

	query := `
		INSERT INTO manuscript_access (username, manuscript_name)
		VALUES ($1, $2)
		ON CONFLICT (username, manuscript_name) DO NOTHING
	`
	if _, err := h.DB.Pool.Exec(r.Context(), query, req.Username, req.ManuscriptName); err != nil {
		log.Printf("Failed to grant %s access to %s: %v", req.Username, req.ManuscriptName, err)
		http.Error(w, "Failed to grant access", http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusCreated)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"username":        req.Username,
		"manuscript_name": req.ManuscriptName,
	})
}

// checkSystemToken verifies the Authorization header contains the configured
// system token. Uses subtle.ConstantTimeCompare to avoid leaking the token
// one byte at a time via response timing.
func (h *AdminHandlers) checkSystemToken(r *http.Request) bool {
	if h.Config.Auth.SystemToken == "" {
		return false
	}
	authHeader := r.Header.Get("Authorization")
	expected := "Bearer " + h.Config.Auth.SystemToken
	return subtle.ConstantTimeCompare([]byte(authHeader), []byte(expected)) == 1
}

// matchManuscriptForWebhook picks the manuscript config a webhook payload
// applies to. Match order:
//   1. By `repository.slug` against the payload's `full_name` (the canonical
//      "owner/repo" identifier GitHub always sends regardless of clone URL form).
//   2. As a fallback for configs that don't set a slug, by literal
//      `repository.url` equality against the payload's `clone_url`.
// Returns nil if no manuscript matches.
//
// Returning a pointer into the slice (via index) avoids the classic
// range-loop-pointer-aliases-loop-variable bug.
func matchManuscriptForWebhook(manuscripts []config.ManuscriptConfig, fullName, cloneURL string) *config.ManuscriptConfig {
	for i, m := range manuscripts {
		if m.Repository.Slug != "" && m.Repository.Slug == fullName {
			return &manuscripts[i]
		}
		if m.Repository.Slug == "" && m.Repository.URL == cloneURL {
			return &manuscripts[i]
		}
	}
	return nil
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

// startMigration is the synchronous prelude to a background migration.
// It looks up (or creates) the manuscript row, inserts a pending migration
// row keyed by (manuscript_id, commit_hash, segmenter), and — if that
// succeeds — launches a goroutine that does the actual work.
//
// Writes the HTTP response in all cases:
//   202 Accepted with {migration_id, started_at}
//   409 Conflict if an identical migration is already pending/running/done
//   500 / 502 for server-side problems before the row was inserted
//
// Note about commitHash="HEAD" or branch names: the dedup unique constraint
// is on the literal string, so two concurrent "HEAD" requests are treated
// as duplicates (the second gets 409). For dedupe by resolved SHA, callers
// should pass an explicit commit hash. This is a feature, not a bug — it
// stops users from accidentally enqueueing the same job twice.
func (h *AdminHandlers) startMigration(ctx context.Context, w http.ResponseWriter, m *config.ManuscriptConfig, commitHash string) {
	manuscript, err := h.DB.GetManuscript(ctx, m.Repository.URL, m.Repository.Path)
	if err != nil {
		http.Error(w, "failed to get manuscript", http.StatusInternalServerError)
		log.Printf("startMigration: GetManuscript: %v", err)
		return
	}
	if manuscript == nil {
		manuscript, err = h.DB.CreateManuscript(ctx, m.Repository.URL, m.Repository.Path)
		if err != nil {
			http.Error(w, "failed to create manuscript", http.StatusInternalServerError)
			log.Printf("startMigration: CreateManuscript: %v", err)
			return
		}
	}

	migrationID, err := h.DB.CreatePendingMigration(ctx, manuscript.ManuscriptID, commitHash, h.Processor.SegmenterVersion())
	if err != nil {
		if errors.Is(err, database.ErrMigrationInProgress) {
			http.Error(w, "migration for this commit is already pending or completed", http.StatusConflict)
			return
		}
		http.Error(w, "failed to start migration", http.StatusInternalServerError)
		log.Printf("startMigration: CreatePendingMigration: %v", err)
		return
	}

	startedAt := time.Now().UTC()
	go h.runMigration(migrationID, manuscript.ManuscriptID, m, commitHash)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":       "accepted",
		"migration_id": migrationID,
		"started_at":   startedAt,
	})
}

// runMigration is the goroutine body. The pending row already exists; we
// must ensure it ends up at status='done' or 'error' regardless of what
// happens here.
func (h *AdminHandlers) runMigration(migrationID, manuscriptID int, m *config.ManuscriptConfig, commitHash string) {
	ctx, cancel := context.WithTimeout(context.Background(), migrationTimeout)
	defer cancel()

	log.Printf("Starting migration %d for manuscript %s at commit %s", migrationID, m.Name, commitHash)

	// Helper: any error before Processor.Run reaches it must be recorded
	// on the row ourselves; Processor.Run handles its own.
	fail := func(stage string, err error) {
		log.Printf("Migration %d failed at %s: %v", migrationID, stage, err)
		if mErr := h.DB.MarkMigrationError(context.Background(), migrationID, stage+": "+err.Error()); mErr != nil {
			log.Printf("Migration %d: also failed to record error: %v", migrationID, mErr)
		}
	}

	gitRepo := migrations.NewGitRepository(
		h.Config.RepoPath(m.Name),
		m.Repository.Branch,
		m.Repository.URL,
		m.Repository.Path,
		m.Repository.AuthToken,
	)

	if err := gitRepo.Clone(ctx); err != nil {
		fail("clone", err)
		return
	}
	if err := gitRepo.Pull(ctx); err != nil {
		// Same tolerance as before: a failed pull is not fatal — we'll
		// proceed with whatever's locally checked out.
		log.Printf("Migration %d: git pull failed (continuing): %v", migrationID, err)
	}

	resolved := commitHash
	if commitHash == "" || commitHash == "HEAD" {
		r, err := gitRepo.GetLatestCommitHash(ctx)
		if err != nil {
			fail("resolve_head", err)
			return
		}
		resolved = r
		log.Printf("Migration %d: resolved HEAD to %s", migrationID, resolved)
	}

	branchName, err := gitRepo.GetBranchName(ctx)
	if err != nil {
		// Not fatal — record empty branch name and proceed.
		log.Printf("Migration %d: could not read branch name: %v", migrationID, err)
		branchName = ""
	}

	content, err := gitRepo.GetFileContent(ctx, resolved)
	if err != nil {
		fail("read_content", err)
		return
	}

	result, err := h.Processor.Run(ctx, migrationID, manuscriptID, resolved, branchName, content)
	if err != nil {
		// Processor.Run already marked the row as error.
		log.Printf("Migration %d: processor failed: %v", migrationID, err)
		return
	}
	log.Printf("Migration %d completed: %s", migrationID, result.Message)
}