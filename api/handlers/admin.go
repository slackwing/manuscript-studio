package handlers

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"log/slog"
	"net/http"
	"time"

	"github.com/slackwing/manuscript-studio/internal/auth"
	"github.com/slackwing/manuscript-studio/internal/config"
	"github.com/slackwing/manuscript-studio/internal/database"
	"github.com/slackwing/manuscript-studio/internal/migrations"
)

// migrationTimeout caps a single migration goroutine before it's aborted
// and the row marked 'error'.
const migrationTimeout = 5 * time.Minute

type AdminHandlers struct {
	DB        *database.DB
	Config    *config.Config
	Processor *migrations.Processor
}

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

// HandleWebhook processes GitHub push webhook events.
func (h *AdminHandlers) HandleWebhook(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "Failed to read request body", http.StatusBadRequest)
		return
	}

	// Log IP and whether a signature header was sent so a misconfigured webhook
	// is distinguishable from an attacker probing the endpoint.
	signature := r.Header.Get("X-Hub-Signature-256")
	if !h.validateGitHubSignature(body, signature, h.Config.Auth.WebhookSecret) {
		log.Printf("webhook signature rejected: ip=%s sig_present=%t body_len=%d",
			r.RemoteAddr, signature != "", len(body))
		http.Error(w, "Invalid signature", http.StatusForbidden)
		return
	}

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

	// Webhook carries a real SHA, so dedupe on (manuscript_id, commit_hash,
	// segmenter) is safe here.
	h.startMigration(r.Context(), w, manuscriptConfig, payload.HeadCommit.ID)
}

// HandleSync manually triggers a sync for a manuscript.
func (h *AdminHandlers) HandleSync(w http.ResponseWriter, r *http.Request) {
	if !h.checkSystemToken(r) {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}

	var req struct {
		ManuscriptName string `json:"manuscript_name"`
		CommitHash     string `json:"commit_hash,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	manuscriptConfig, err := h.Config.GetManuscript(req.ManuscriptName)
	if err != nil {
		http.Error(w, "Manuscript not found", http.StatusNotFound)
		return
	}

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

// HandleStatus returns migrations currently at status='pending' or 'running'.
// An empty list means nothing is in progress.
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

// HandleCreateUser upserts a user. Body: {"username","password","role?"}. Requires system token.
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

// HandleCreateGrant grants a user access to a manuscript (idempotent).
// Body: {"username","manuscript_name"}. Requires system token.
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

// checkSystemToken compares the Authorization header to the configured system
// token in constant time to avoid byte-level timing leaks.
func (h *AdminHandlers) checkSystemToken(r *http.Request) bool {
	if h.Config.Auth.SystemToken == "" {
		return false
	}
	authHeader := r.Header.Get("Authorization")
	expected := "Bearer " + h.Config.Auth.SystemToken
	return subtle.ConstantTimeCompare([]byte(authHeader), []byte(expected)) == 1
}

// matchManuscriptForWebhook picks the manuscript for a webhook payload:
// first by repository.slug == full_name (the canonical "owner/repo" GitHub
// always sends), then as a fallback by literal repository.url == clone_url
// for slug-less configs. Returns nil if none match.
func matchManuscriptForWebhook(manuscripts []config.ManuscriptConfig, fullName, cloneURL string) *config.ManuscriptConfig {
	for i, m := range manuscripts {
		if m.Repository.Slug != "" && m.Repository.Slug == fullName {
			return &manuscripts[i]
		}
		if m.Repository.Slug == "" && m.Repository.URL != "" && m.Repository.URL == cloneURL {
			return &manuscripts[i]
		}
	}
	return nil
}

func (h *AdminHandlers) validateGitHubSignature(payload []byte, signature string, secret string) bool {
	if signature == "" || secret == "" {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(payload)
	expectedSig := "sha256=" + hex.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(signature), []byte(expectedSig))
}

// startMigration: sync prelude that upserts the manuscript row, inserts a
// pending migration keyed by (manuscript_id, commit_hash, segmenter), and
// launches the goroutine. Responds 202 with {migration_id, started_at}, 409
// if an identical migration is pending/running/done, or 5xx on setup errors.
//
// Dedup is by literal commitHash, so two concurrent "HEAD" requests collide
// (second gets 409). That's intentional — it prevents accidental double-enqueue.
// For dedupe by resolved SHA, callers must pass an explicit hash.
func (h *AdminHandlers) startMigration(ctx context.Context, w http.ResponseWriter, m *config.ManuscriptConfig, commitHash string) {
	cloneURL := m.Repository.CloneURL()
	if cloneURL == "" {
		http.Error(w, "manuscript repository has neither slug nor url configured", http.StatusInternalServerError)
		log.Printf("startMigration: manuscript %q has empty clone URL", m.Name)
		return
	}
	manuscript, err := h.DB.GetManuscript(ctx, cloneURL, m.Repository.Path)
	if err != nil {
		http.Error(w, "failed to get manuscript", http.StatusInternalServerError)
		log.Printf("startMigration: GetManuscript: %v", err)
		return
	}
	if manuscript == nil {
		manuscript, err = h.DB.CreateManuscript(ctx, cloneURL, m.Repository.Path)
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

// runMigration is the goroutine body. Must always leave the pending row at
// 'done' or 'error', whatever happens.
func (h *AdminHandlers) runMigration(migrationID, manuscriptID int, m *config.ManuscriptConfig, commitHash string) {
	ctx, cancel := context.WithTimeout(context.Background(), migrationTimeout)
	defer cancel()

	mlog := slog.Default().With(
		slog.Int("migration_id", migrationID),
		slog.Int("manuscript_id", manuscriptID),
		slog.String("manuscript", m.Name),
		slog.String("requested_commit", commitHash),
	)
	mlog.Info("migration started")

	gitRepo := &migrations.GitRepository{
		Path:      h.Config.RepoPath(m.Name),
		Branch:    m.Repository.Branch,
		RemoteURL: m.Repository.CloneURL(),
		FilePath:  m.Repository.Path,
		AuthToken: m.Repository.AuthToken,
	}

	prepared, err := gitRepo.Prepare(ctx, commitHash, func(format string, args ...any) {
		mlog.Warn(fmt.Sprintf(format, args...))
	})
	if err != nil {
		mlog.Warn("git prep failed", slog.Any("err", err))
		if mErr := h.DB.MarkMigrationError(context.Background(), migrationID, err.Error()); mErr != nil {
			mlog.Warn("also failed to record error on row", slog.Any("err", mErr))
		}
		return
	}
	mlog.Info("git prep complete",
		slog.String("commit", prepared.CommitHash),
		slog.String("branch", prepared.BranchName),
		slog.Int("bytes", len(prepared.Content)),
	)

	result, err := h.Processor.Run(ctx, mlog, migrationID, manuscriptID, prepared.CommitHash, prepared.BranchName, prepared.Content)
	if err != nil {
		// Processor.Run has already marked the row as error.
		mlog.Warn("processor failed", slog.Any("err", err))
		return
	}
	mlog.Info("migration done", slog.String("result", result.Message))
}