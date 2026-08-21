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
	"sync"
	"time"

	"github.com/slackwing/manuscript-studio/internal/auth"
	"github.com/slackwing/manuscript-studio/internal/config"
	"github.com/slackwing/manuscript-studio/internal/database"
	"github.com/slackwing/manuscript-studio/internal/migrations"
	"github.com/slackwing/manuscript-studio/internal/models"
	"github.com/slackwing/manuscript-studio/internal/perm"
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
	Ref        string `json:"ref"` // refs/heads/main
	Repository struct {
		Name     string `json:"name"`
		FullName string `json:"full_name"`
		CloneURL string `json:"clone_url"`
	} `json:"repository"`
	Commits []struct {
		ID       string   `json:"id"`
		Message  string   `json:"message"`
		Added    []string `json:"added"`
		Modified []string `json:"modified"`
		Removed  []string `json:"removed"`
	} `json:"commits"`
	HeadCommit struct {
		ID string `json:"id"`
	} `json:"head_commit"`
}

// modifiedPaths collects every path some commit Modified or Added. Removed
// paths deliberately don't count — deleting the manuscript file must not
// trigger a migration of its absence.
func (p *GitHubWebhookPayload) modifiedPaths() map[string]bool {
	modified := make(map[string]bool)
	for _, commit := range p.Commits {
		for _, file := range commit.Modified {
			modified[file] = true
		}
		for _, file := range commit.Added {
			modified[file] = true
		}
	}
	return modified
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

	repo := matchGitRepoForWebhook(h.Config.GitRepos, payload.Repository.FullName, payload.Repository.CloneURL)
	if repo == nil {
		log.Printf("Webhook received for unknown repository: full_name=%s clone_url=%s",
			payload.Repository.FullName, payload.Repository.CloneURL)
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"ignored","reason":"repository not configured"}`))
		return
	}

	// The ref validator "must run at every API boundary" (git.go) — the
	// signature check gates who can call us, not what a compromised or
	// misconfigured sender puts in head_commit.id.
	if err := migrations.ValidateCommitRef(payload.HeadCommit.ID); err != nil {
		http.Error(w, "Invalid head_commit id: "+err.Error(), http.StatusBadRequest)
		return
	}

	// One repo can back several manuscripts (registry-to-DB, Phase 0): fan
	// out over the DB rows bound to it.
	rows, err := h.DB.GetManuscriptsByGitRepoName(r.Context(), repo.Name)
	if err != nil {
		http.Error(w, "failed to look up manuscripts", http.StatusInternalServerError)
		log.Printf("webhook: manuscripts for repo %q: %v", repo.Name, err)
		return
	}
	if len(rows) == 0 {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"ignored","reason":"no manuscripts bound to repository"}`))
		return
	}

	started := []map[string]interface{}{}
	for _, m := range webhookTargets(rows, payload.Ref, payload.modifiedPaths()) {
		// Webhook carries a real SHA, so dedupe on (manuscript_id,
		// commit_hash, segmenter) is safe here.
		migrationID, err := h.enqueueMigration(r.Context(), m, payload.HeadCommit.ID)
		if errors.Is(err, database.ErrMigrationInProgress) {
			started = append(started, map[string]interface{}{"manuscript": m.Name, "status": "duplicate"})
			continue
		}
		if err != nil {
			log.Printf("webhook: enqueue %q: %v", m.Name, err)
			started = append(started, map[string]interface{}{"manuscript": m.Name, "status": "error"})
			continue
		}
		started = append(started, map[string]interface{}{"manuscript": m.Name, "status": "accepted", "migration_id": migrationID})
	}

	if len(started) == 0 {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"ignored","reason":"no tracked manuscript modified on tracked branch"}`))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":     "accepted",
		"started_at": time.Now().UTC(),
		"migrations": started,
	})
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

	m, err := h.DB.GetManuscriptByName(r.Context(), req.ManuscriptName)
	if err != nil {
		http.Error(w, "failed to look up manuscript", http.StatusInternalServerError)
		log.Printf("sync: %v", err)
		return
	}
	if m == nil {
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

	h.startMigration(r.Context(), w, m, commitHash)
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

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{
		"username": req.Username,
		"role":     req.Role,
	})
}

// HandleCreateGrant grants a user roles on a manuscript (idempotent).
// Body: {"username","manuscript_name","roles":["editor",…]?}. When roles
// is omitted the legacy power set (admin+author+editor+pointer) is
// granted — matching the 038 data migration, so ops/tests that predate v3
// keep full capability. Requires system token.
func (h *AdminHandlers) HandleCreateGrant(w http.ResponseWriter, r *http.Request) {
	if !h.checkSystemToken(r) {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}

	var req struct {
		Username       string   `json:"username"`
		ManuscriptName string   `json:"manuscript_name"`
		Roles          []string `json:"roles"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}
	if req.Username == "" || req.ManuscriptName == "" {
		http.Error(w, "username and manuscript_name are required", http.StatusBadRequest)
		return
	}
	if len(req.Roles) == 0 {
		req.Roles = []string{"admin", "author", "editor", "pointer"}
	}
	for _, role := range req.Roles {
		if !perm.ValidRole(role) {
			http.Error(w, "unknown role "+role, http.StatusBadRequest)
			return
		}
	}

	m, err := h.DB.GetManuscriptByName(r.Context(), req.ManuscriptName)
	if err != nil || m == nil {
		http.Error(w, "Manuscript not found", http.StatusNotFound)
		return
	}
	for _, role := range req.Roles {
		if err := h.DB.GrantRole(r.Context(), req.Username, m.ManuscriptID, role); err != nil {
			log.Printf("Failed to grant %s %s on %s: %v", req.Username, role, req.ManuscriptName, err)
			http.Error(w, "Failed to grant access", http.StatusInternalServerError)
			return
		}
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"username":        req.Username,
		"manuscript_name": req.ManuscriptName,
		"roles":           req.Roles,
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

// webhookTargets filters a repo's manuscripts to the ones a push actually
// affects: the pushed ref must be the manuscript's tracked branch (pushes to
// non-canonical branches — e.g. suggestions-* PR branches — must be ignored
// or the server would migrate every PR branch as if it were main), and some
// commit must have touched the manuscript file.
func webhookTargets(rows []*models.Manuscript, ref string, modified map[string]bool) []*models.Manuscript {
	var out []*models.Manuscript
	for _, m := range rows {
		if ref != "refs/heads/"+m.Branch() {
			continue
		}
		if !modified[m.FilePath] {
			continue
		}
		out = append(out, m)
	}
	return out
}

// matchGitRepoForWebhook picks the registry entry for a webhook payload:
// first by slug == full_name (the canonical "owner/repo" GitHub always
// sends), then as a fallback by literal url == clone_url for slug-less
// configs. Returns nil if none match.
func matchGitRepoForWebhook(repos []config.GitRepoConfig, fullName, cloneURL string) *config.GitRepoConfig {
	for i, g := range repos {
		if g.Slug != "" && g.Slug == fullName {
			return &repos[i]
		}
		if g.Slug == "" && g.URL != "" && g.URL == cloneURL {
			return &repos[i]
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
func (h *AdminHandlers) startMigration(ctx context.Context, w http.ResponseWriter, m *models.Manuscript, commitHash string) {
	migrationID, err := h.enqueueMigration(ctx, m, commitHash)
	if err != nil {
		if errors.Is(err, database.ErrMigrationInProgress) {
			http.Error(w, "migration for this commit is already pending or completed", http.StatusConflict)
			return
		}
		http.Error(w, "failed to start migration", http.StatusInternalServerError)
		log.Printf("startMigration: %v", err)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":       "accepted",
		"migration_id": migrationID,
		"started_at":   time.Now().UTC(),
	})
}

// enqueueMigration reserves a pending migration keyed by (manuscript_id,
// commit_hash, segmenter) and launches the worker goroutine. Returns
// database.ErrMigrationInProgress when an identical migration already exists.
func (h *AdminHandlers) enqueueMigration(ctx context.Context, m *models.Manuscript, commitHash string) (int, error) {
	// Resolve now so a broken registry reference fails the request, not the
	// goroutine.
	if _, err := gitRepoForManuscript(h.Config, m); err != nil {
		return 0, err
	}

	migrationID, err := h.DB.CreatePendingMigration(ctx, m.ManuscriptID, commitHash, h.Processor.SegmenterVersion())
	if err != nil {
		if errors.Is(err, database.ErrMigrationInProgress) {
			return 0, err
		}
		return 0, fmt.Errorf("CreatePendingMigration: %w", err)
	}

	go h.runMigration(migrationID, m, commitHash)
	return migrationID, nil
}

// ResegmentOnSegmenterChange re-enqueues each manuscript's latest done
// commit when its migration was produced by a different segmenter version
// than the one this binary carries. Called once at startup (after
// ReconcileRegistry) so a deploy that bumps the vendored segman re-hashes
// sentences without waiting for the next push or a manual sync. Errors are
// logged, never fatal — the server must come up regardless.
func (h *AdminHandlers) ResegmentOnSegmenterChange(ctx context.Context) {
	current := h.Processor.SegmenterVersion()
	rows, err := h.DB.ListManuscripts(ctx)
	if err != nil {
		log.Printf("resegment check: list manuscripts: %v", err)
		return
	}
	for _, m := range rows {
		latest, err := h.DB.GetLatestMigration(ctx, m.ManuscriptID)
		if err != nil {
			log.Printf("resegment check: GetLatestMigration %q: %v", m.Name, err)
			continue
		}
		if latest == nil || latest.Segmenter == current {
			continue
		}
		migrationID, err := h.enqueueMigration(ctx, m, latest.CommitHash)
		if errors.Is(err, database.ErrMigrationInProgress) {
			log.Printf("resegment %q: migration for %s + %s already exists", m.Name, latest.CommitHash, current)
			continue
		}
		if err != nil {
			log.Printf("resegment %q: %v", m.Name, err)
			continue
		}
		log.Printf("resegment %q: segmenter %s → %s, re-migrating commit %s (migration %d)",
			m.Name, latest.Segmenter, current, latest.CommitHash, migrationID)
	}
}

// migrationLocks serializes migration goroutines per git checkout path.
// Concurrent runs (webhook push + manual sync for different commits, or two
// manuscripts sharing one clone) would otherwise race on the checkout
// (index.lock) and both carry notes forward from the same parent migration.
// A manuscript always resolves to exactly one path, so this subsumes the
// old per-manuscript-ID lock.
var migrationLocks sync.Map // checkout path → *sync.Mutex

func lockMigrationPath(path string) (unlock func()) {
	v, _ := migrationLocks.LoadOrStore(path, &sync.Mutex{})
	mu := v.(*sync.Mutex)
	mu.Lock()
	return mu.Unlock
}

// runMigration is the goroutine body. Must always leave the pending row at
// 'done' or 'error', whatever happens.
func (h *AdminHandlers) runMigration(migrationID int, m *models.Manuscript, commitHash string) {
	mlog := slog.Default().With(
		slog.Int("migration_id", migrationID),
		slog.Int("manuscript_id", m.ManuscriptID),
		slog.String("manuscript", m.Name),
		slog.String("requested_commit", commitHash),
	)

	gitRepo, err := gitRepoForManuscript(h.Config, m)
	if err != nil {
		// enqueueMigration pre-resolved, so this is config drift mid-flight.
		mlog.Warn("git repo resolution failed", slog.Any("err", err))
		if mErr := h.DB.MarkMigrationError(context.Background(), migrationID, err.Error()); mErr != nil {
			mlog.Warn("also failed to record error on row", slog.Any("err", mErr))
		}
		return
	}

	// Acquire before starting the timeout clock so a queued migration gets
	// its full budget once it actually starts.
	unlock := lockMigrationPath(gitRepo.Path)
	defer unlock()

	ctx, cancel := context.WithTimeout(context.Background(), migrationTimeout)
	defer cancel()

	mlog.Info("migration started")

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

	result, err := h.Processor.Run(ctx, mlog, migrationID, m.ManuscriptID, prepared.CommitHash, prepared.BranchName, prepared.Content)
	if err != nil {
		// Processor.Run has already marked the row as error.
		mlog.Warn("processor failed", slog.Any("err", err))
		return
	}
	mlog.Info("migration done", slog.String("result", result.Message))
}

// HandleWordcountCompute forces a wordcount-history run right now (the same
// computation as the in-process cron). Works even with the feature disabled
// — useful for tests and one-off refreshes; only serving switches on the
// config flag.
func (h *AdminHandlers) HandleWordcountCompute(w http.ResponseWriter, r *http.Request) {
	if !h.checkSystemToken(r) {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}
	rows, err := h.DB.ComputeWordcountHistory(r.Context(), h.Config.WordcountHistory.Location())
	if err != nil {
		http.Error(w, "Wordcount compute failed: "+err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(struct {
		Rows []database.WordcountRow `json:"rows"`
	}{rows})
}
