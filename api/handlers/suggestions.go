package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/slackwing/manuscript-studio/internal/auth"
	"github.com/slackwing/manuscript-studio/internal/config"
	"github.com/slackwing/manuscript-studio/internal/database"
	"github.com/slackwing/manuscript-studio/internal/migrations"
	"github.com/slackwing/manuscript-studio/internal/models"
	"github.com/slackwing/manuscript-studio/internal/segman"
	"github.com/slackwing/manuscript-studio/internal/sentence"
)

// segmanSiblingPath returns the .segman counterpart for a manuscript
// path: "book.manuscript" → "book.segman", "dir/x.manuscript" → "dir/x.segman".
// Other extensions are passed through unchanged so absurd inputs don't
// silently land somewhere weird.
func segmanSiblingPath(manuscriptPath string) string {
	if strings.HasSuffix(manuscriptPath, ".manuscript") {
		return strings.TrimSuffix(manuscriptPath, ".manuscript") + ".segman"
	}
	return manuscriptPath + ".segman"
}

// Suggestions are per-user, per-sentence, scoped to a migration via sentence_id FK.
type SuggestionHandlers struct {
	DB           *database.DB
	SessionStore *auth.SessionStore
	Config       *config.Config
	// Admin provides enqueueMigration for the local-mode commit path
	// (commit + migrate in one request — no webhook exists locally).
	Admin *AdminHandlers
}

type upsertSuggestionRequest struct {
	Text string `json:"text"`
}

func (h *SuggestionHandlers) HandleGetSuggestionsForMigration(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	migrationIDStr := chi.URLParam(r, "migration_id")
	migrationID, err := strconv.Atoi(migrationIDStr)
	if err != nil {
		http.Error(w, "Invalid migration_id", http.StatusBadRequest)
		return
	}
	manuscriptID, ok := requireManuscriptAccessForMigration(w, r, h.DB, h.Config, migrationID)
	if !ok {
		return
	}

	session, err := auth.GetSession(r)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	// v3 multi-user view: everyone's suggestions when the caller may see
	// them; own-only otherwise (the reader experience).
	seeOthers, err := userHasAction(ctx, h.DB, session.Username, manuscriptID, "see-others-edits")
	if err != nil {
		http.Error(w, "Failed to check permissions", http.StatusInternalServerError)
		return
	}
	var suggestions []models.SuggestedChange
	if seeOthers {
		suggestions, err = h.DB.GetAllSuggestionsForMigration(ctx, migrationID)
	} else {
		suggestions, err = h.DB.GetSuggestionsForMigration(ctx, migrationID, session.Username)
	}
	if err != nil {
		http.Error(w, "Failed to load suggestions", http.StatusInternalServerError)
		return
	}
	if suggestions == nil {
		suggestions = []models.SuggestedChange{}
	}

	// v3.1 (review round 2): accept/reject CHANGES the manuscript, so it is
	// author/editor territory even for one's own suggestion — readers and
	// beta-readers file suggestions and wait for review.
	canReview, err := userHasAction(ctx, h.DB, session.Username, manuscriptID, "manage-suggestions")
	if err != nil {
		http.Error(w, "Failed to check permissions", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"suggestions": suggestions,
		"viewer":      session.Username,
		"can_review":  canReview,
	})
}

// HandleReviewSuggestion sets/clears a suggestion's verdict.
// Body: {"username","status":"accepted"|"rejected"|null}. v3.1: reviewing
// ANY suggestion — one's own included — needs manage-suggestions (author/
// editor): accepting changes the manuscript, so readers and beta-readers
// only file suggestions (PERMISSIONS_PLAN §4).
func (h *SuggestionHandlers) HandleReviewSuggestion(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	sentenceID := chi.URLParam(r, "sentence_id")
	if sentenceID == "" {
		http.Error(w, "sentence_id required", http.StatusBadRequest)
		return
	}
	session, err := auth.GetSession(r)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	if !auth.ValidateCSRFToken(r, h.SessionStore, r.Header.Get("X-CSRF-Token")) {
		http.Error(w, "Invalid CSRF token", http.StatusForbidden)
		return
	}
	var req struct {
		Username string  `json:"username"`
		Status   *string `json:"status"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Username == "" {
		http.Error(w, "username is required", http.StatusBadRequest)
		return
	}
	if req.Status != nil && *req.Status != models.ReviewAccepted && *req.Status != models.ReviewRejected {
		http.Error(w, "status must be accepted, rejected, or null", http.StatusBadRequest)
		return
	}
	migrationID, err := h.DB.GetMigrationIDForSentence(ctx, sentenceID)
	if err != nil || migrationID == 0 {
		http.Error(w, "Sentence not found", http.StatusNotFound)
		return
	}
	migration, err := h.DB.GetMigrationByID(ctx, migrationID)
	if err != nil || migration == nil {
		http.Error(w, "Migration not found", http.StatusNotFound)
		return
	}
	if !requireAction(w, r, h.DB, migration.ManuscriptID, "manage-suggestions") {
		return
	}
	found, err := h.DB.SetSuggestionReview(ctx, sentenceID, req.Username, req.Status, session.Username)
	if errors.Is(err, database.ErrCompetingAccepted) {
		http.Error(w, "Another suggestion on this sentence is already accepted — reject or clear it first.", http.StatusConflict)
		return
	}
	if err != nil {
		log.Printf("suggestions: review %s/%s: %v", sentenceID, req.Username, err)
		http.Error(w, "Failed to set review", http.StatusInternalServerError)
		return
	}
	if !found {
		http.Error(w, "No such suggestion", http.StatusNotFound)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// HandleAcceptOwnUncontested marks every own fresh unreviewed suggestion
// on the migration accepted where no other user has a live suggestion on
// the same sentence — the one-click path to today's "my edits are ready".
// v3.1: gated like any accept (manage-suggestions).
func (h *SuggestionHandlers) HandleAcceptOwnUncontested(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	migrationID, err := strconv.Atoi(chi.URLParam(r, "migration_id"))
	if err != nil {
		http.Error(w, "Invalid migration_id", http.StatusBadRequest)
		return
	}
	mig, err := h.DB.GetMigrationByID(ctx, migrationID)
	if err != nil || mig == nil {
		http.Error(w, "Migration not found", http.StatusNotFound)
		return
	}
	if !requireAction(w, r, h.DB, mig.ManuscriptID, "manage-suggestions") {
		return
	}
	session, err := auth.GetSession(r)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	if !auth.ValidateCSRFToken(r, h.SessionStore, r.Header.Get("X-CSRF-Token")) {
		http.Error(w, "Invalid CSRF token", http.StatusForbidden)
		return
	}
	n, err := h.DB.AcceptOwnUncontested(ctx, migrationID, session.Username)
	if err != nil {
		log.Printf("suggestions: accept own uncontested: %v", err)
		http.Error(w, "Failed to accept", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]int{"accepted": n})
}

// HandlePutSuggestion upserts a suggestion. Text identical to the original
// sentence is collapsed into a delete so "revert by re-saving the original"
// works without client logic.
//
// Rejects writes against sentences on a non-latest migration with 409 stale.
// Without this guard, a stale tab (loaded before a new migration arrived)
// would silently accumulate suggestions on orphaned sentence_ids — they'd
// still be per-user and access-checked, but they'd never surface for the
// current view of the manuscript and never carry forward.
func (h *SuggestionHandlers) HandlePutSuggestion(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	sentenceID := chi.URLParam(r, "sentence_id")
	if sentenceID == "" {
		http.Error(w, "sentence_id required", http.StatusBadRequest)
		return
	}
	if !requireManuscriptAccessForSentence(w, r, h.DB, h.Config, sentenceID) {
		return
	}

	session, err := auth.GetSession(r)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	csrfToken := r.Header.Get("X-CSRF-Token")
	if !auth.ValidateCSRFToken(r, h.SessionStore, csrfToken) {
		http.Error(w, "Invalid CSRF token", http.StatusForbidden)
		return
	}

	var req upsertSuggestionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	sentenceMigrationID, err := h.DB.GetMigrationIDForSentence(ctx, sentenceID)
	if err != nil {
		http.Error(w, "Failed to resolve sentence migration", http.StatusInternalServerError)
		return
	}
	if sentenceMigrationID == 0 {
		http.Error(w, "Sentence not found", http.StatusNotFound)
		return
	}
	migration, err := h.DB.GetMigrationByID(ctx, sentenceMigrationID)
	if err != nil {
		http.Error(w, "Failed to load migration", http.StatusInternalServerError)
		return
	}
	if migration == nil {
		// Defensive: the access guard above already 404s sentences whose
		// migration isn't 'done', and done rows never change status — but a
		// missing migration is "not found", never a server error.
		http.Error(w, "Migration not found", http.StatusNotFound)
		return
	}
	latest, err := h.DB.GetLatestMigration(ctx, migration.ManuscriptID)
	if err != nil {
		http.Error(w, "Failed to load latest migration", http.StatusInternalServerError)
		return
	}
	if latest != nil && latest.MigrationID != sentenceMigrationID {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"error":       "stale",
			"latest_id":   latest.MigrationID,
			"sentence_id": sentenceID,
			"hint":        "manuscript has been updated — please refresh",
		})
		return
	}

	orig, err := h.DB.GetSentenceTextsByIDs(ctx, []string{sentenceID})
	if err != nil {
		http.Error(w, "Failed to load sentence", http.StatusInternalServerError)
		return
	}
	row, ok := orig[sentenceID]
	if !ok {
		http.Error(w, "Sentence not found", http.StatusNotFound)
		return
	}

	if req.Text == row.Text {
		if _, err := h.DB.DeleteSuggestion(ctx, sentenceID, session.Username); err != nil {
			http.Error(w, "Failed to delete suggestion", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}

	saved, err := h.DB.UpsertSuggestion(ctx, sentenceID, session.Username, req.Text)
	if err != nil {
		log.Printf("suggestions: upsert for sentence %s: %v", sentenceID, err)
		http.Error(w, "Failed to save suggestion", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(saved)
}

// HandleDeleteSuggestion is idempotent: missing rows return 204 just the same.
func (h *SuggestionHandlers) HandleDeleteSuggestion(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	sentenceID := chi.URLParam(r, "sentence_id")
	if sentenceID == "" {
		http.Error(w, "sentence_id required", http.StatusBadRequest)
		return
	}
	if !requireManuscriptAccessForSentence(w, r, h.DB, h.Config, sentenceID) {
		return
	}

	session, err := auth.GetSession(r)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	csrfToken := r.Header.Get("X-CSRF-Token")
	if !auth.ValidateCSRFToken(r, h.SessionStore, csrfToken) {
		http.Error(w, "Invalid CSRF token", http.StatusForbidden)
		return
	}

	if _, err := h.DB.DeleteSuggestion(ctx, sentenceID, session.Username); err != nil {
		http.Error(w, "Failed to delete suggestion", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type pushSuggestionsResponse struct {
	Branch     string                           `json:"branch"`
	CompareURL string                           `json:"compare_url"`
	CommitSHA  string                           `json:"commit_sha"`
	Applied    int                              `json:"applied"`
	Skipped    int                              `json:"skipped"`
	Results    []sentence.SuggestionApplyResult `json:"results"`
	// MigrationID is set on local-mode commits (the migration enqueued in
	// the same request); zero for github-mode pushes.
	MigrationID int `json:"migration_id,omitempty"`
}

// Branch component sanitizer: the username appears in a ref name, so anything
// outside [a-zA-Z0-9_-] becomes '-'. Empty becomes "user".
var branchSafe = regexp.MustCompile(`[^a-zA-Z0-9_-]+`)

func sanitizeBranchComponent(s string) string {
	out := branchSafe.ReplaceAllString(s, "-")
	if out == "" {
		return "user"
	}
	return out
}

// HandleGetPushState reports whether the canonical "suggestions-{shortSHA}-{user}"
// branch already exists locally — used by the UI to label the push button as
// "Push" (update) vs "Push New" (create).
func (h *SuggestionHandlers) HandleGetPushState(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	manuscriptIDStr := chi.URLParam(r, "manuscript_id")
	manuscriptID, err := strconv.Atoi(manuscriptIDStr)
	if err != nil {
		http.Error(w, "Invalid manuscript_id", http.StatusBadRequest)
		return
	}
	migrationIDStr := chi.URLParam(r, "migration_id")
	migrationID, err := strconv.Atoi(migrationIDStr)
	if err != nil {
		http.Error(w, "Invalid migration_id", http.StatusBadRequest)
		return
	}
	if !requireManuscriptAccess(w, r, h.DB, h.Config, manuscriptID) {
		return
	}
	session, err := auth.GetSession(r)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	migration, err := h.DB.GetMigrationByID(ctx, migrationID)
	if err != nil || migration == nil {
		http.Error(w, "Migration not found", http.StatusNotFound)
		return
	}
	manuscript, err := h.DB.GetManuscriptByID(ctx, manuscriptID)
	if err != nil || manuscript == nil {
		http.Error(w, "Manuscript not found", http.StatusNotFound)
		return
	}
	gitRepo, err := gitRepoForManuscript(h.Config, manuscript)
	if err != nil {
		http.Error(w, "Manuscript not configured on this server", http.StatusNotImplemented)
		return
	}

	// Local mode has no PR branches: the button is always plain "Commit".
	if manuscript.Storage == models.StorageLocal {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"storage":       models.StorageLocal,
			"branch":        manuscript.Branch(),
			"branch_exists": true,
			"compare_url":   "",
		})
		return
	}

	branch := canonicalSuggestionsBranch(migration.CommitHash, session.Username)
	// The checkout may not exist yet (fresh server, wiped repos dir) —
	// Clone is a no-op when present. Failure degrades to "no branch"
	// rather than a 500: push-state is advisory.
	if err := gitRepo.Clone(ctx); err != nil {
		log.Printf("suggestions: push-state clone %s: %v", manuscript.Name, err)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"storage":       models.StorageGitHub,
			"branch":        branch,
			"branch_exists": false,
			"compare_url":   h.compareURLFor(manuscript, branch),
		})
		return
	}
	exists, err := gitRepo.LocalBranchExists(ctx, branch)
	if err != nil {
		log.Printf("suggestions: check branch %s: %v", branch, err)
		http.Error(w, "Failed to check branch", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"storage":       models.StorageGitHub,
		"branch":        branch,
		"branch_exists": exists,
		"compare_url":   h.compareURLFor(manuscript, branch),
	})
}

// compareURLFor builds the GitHub compare link for a pushed branch; empty
// when the manuscript's registry entry has no slug (or is local).
func (h *SuggestionHandlers) compareURLFor(m *models.Manuscript, branch string) string {
	if m.Storage == models.StorageLocal {
		return ""
	}
	rc := h.Config.GetGitRepo(m.GitRepoName)
	if rc == nil || rc.Slug == "" {
		return ""
	}
	return fmt.Sprintf("https://github.com/%s/compare/%s", rc.Slug, branch)
}

// HandlePushSuggestions pushes the calling user's unmerged suggestions for the
// given manuscript as a branch on the manuscript's GitHub repo. See
// PUSH_FEATURE_PLAN.md for the contract.
func (h *SuggestionHandlers) HandlePushSuggestions(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	manuscriptIDStr := chi.URLParam(r, "manuscript_id")
	manuscriptID, err := strconv.Atoi(manuscriptIDStr)
	if err != nil {
		http.Error(w, "Invalid manuscript_id", http.StatusBadRequest)
		return
	}

	migrationIDStr := chi.URLParam(r, "migration_id")
	migrationID, err := strconv.Atoi(migrationIDStr)
	if err != nil {
		http.Error(w, "Invalid migration_id", http.StatusBadRequest)
		return
	}
	// v3: the Push/Commit button is a real permission — same action for
	// github and local storage (PERMISSIONS_PLAN §2).
	if !requireAction(w, r, h.DB, manuscriptID, "commit-and-push-suggestions") {
		return
	}

	session, err := auth.GetSession(r)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	csrfToken := r.Header.Get("X-CSRF-Token")
	if !auth.ValidateCSRFToken(r, h.SessionStore, csrfToken) {
		http.Error(w, "Invalid CSRF token", http.StatusForbidden)
		return
	}

	// v3 (PERMISSIONS_PLAN §4): pushes land ACCEPTED suggestions only.
	// scope: "all-accepted" (default — People-order winner on per-sentence
	// conflicts) or "own-accepted". Older clients' {"action":"update"}
	// bodies parse harmlessly into the default scope.
	var pushBody struct {
		Scope string `json:"scope"`
	}
	_ = json.NewDecoder(r.Body).Decode(&pushBody)
	if pushBody.Scope == "" {
		pushBody.Scope = "all-accepted"
	}
	if pushBody.Scope != "all-accepted" && pushBody.Scope != "own-accepted" {
		http.Error(w, "scope must be all-accepted or own-accepted", http.StatusBadRequest)
		return
	}

	// Stale-migration guard: only push from the latest migration.
	latest, err := h.DB.GetLatestMigration(ctx, manuscriptID)
	if err != nil {
		http.Error(w, "Failed to load latest migration", http.StatusInternalServerError)
		return
	}
	if latest == nil {
		http.Error(w, "No migrations exist for this manuscript", http.StatusNotFound)
		return
	}
	if latest.MigrationID != migrationID {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		json.NewEncoder(w).Encode(map[string]string{
			"error":        "stale",
			"latest_id":    strconv.Itoa(latest.MigrationID),
			"requested_id": strconv.Itoa(migrationID),
			"hint":         "manuscript has been updated — please refresh",
		})
		return
	}

	manuscript, err := h.DB.GetManuscriptByID(ctx, manuscriptID)
	if err != nil || manuscript == nil {
		http.Error(w, "Manuscript not found", http.StatusNotFound)
		return
	}
	gitRepo, err := gitRepoForManuscript(h.Config, manuscript)
	if err != nil {
		http.Error(w, "Manuscript not configured on this server", http.StatusNotImplemented)
		return
	}

	var suggestions []models.SuggestedChange
	if pushBody.Scope == "own-accepted" {
		suggestions, err = h.DB.GetSuggestionsForMigration(ctx, migrationID, session.Username)
	} else {
		suggestions, err = h.DB.GetAllSuggestionsForMigration(ctx, migrationID)
	}
	if err != nil {
		http.Error(w, "Failed to load suggestions", http.StatusInternalServerError)
		return
	}
	// Accepted + fresh only — the push applies EXACTLY the accepted set
	// (v3.2): accepting is exclusive per sentence, so there is nothing to
	// resolve here. Defensive dedupe for pre-v3.2 data: earliest review
	// wins, and we log the anomaly.
	accepted := suggestions[:0]
	seenSentence := map[string]bool{}
	for _, s := range suggestions {
		if s.Stale || s.ReviewStatus == nil || *s.ReviewStatus != models.ReviewAccepted {
			continue
		}
		if seenSentence[s.SentenceID] {
			log.Printf("suggestions: push %d: multiple accepted on %s (pre-v3.2 data?) — keeping the first", migrationID, s.SentenceID)
			continue
		}
		seenSentence[s.SentenceID] = true
		accepted = append(accepted, s)
	}
	suggestions = accepted
	if len(suggestions) == 0 {
		http.Error(w, "No accepted suggestions to push (accept your edits first)", http.StatusBadRequest)
		return
	}
	// Rebuild the WHOLE manuscript in canonical form from the migration's
	// sentences overlaid with this user's suggestions — the same per-sentence
	// Canonicalize the client render loop runs, so "what you see is what you
	// push". This replaces the old substring-replace (ApplySuggestions); the
	// pushed file is now canonical, so the FIRST push reformats the whole file
	// (by design — CANONICALIZE_PLAN.md).
	allSentences, err := h.DB.GetSentencesByMigration(ctx, migrationID)
	if err != nil {
		http.Error(w, "Failed to load migration sentences", http.StatusInternalServerError)
		return
	}
	orderedIDs := make([]string, 0, len(allSentences))
	committedByID := make(map[string]string, len(allSentences))
	for _, s := range allSentences {
		orderedIDs = append(orderedIDs, s.SentenceID)
		committedByID[s.SentenceID] = s.Text
	}

	suggestionByID := make(map[string]string, len(suggestions))
	for _, s := range suggestions {
		suggestionByID[s.SentenceID] = s.Text
	}

	// applied = suggestions that overlay a sentence still present in the
	// migration; skipped = suggestions whose sentence vanished (defensive —
	// the stale guard above makes this rare). results mirrors the old shape.
	applied, skipped := 0, 0
	results := make([]sentence.SuggestionApplyResult, 0, len(suggestions))
	for _, s := range suggestions {
		if _, ok := committedByID[s.SentenceID]; ok {
			applied++
			results = append(results, sentence.SuggestionApplyResult{SentenceID: s.SentenceID, Applied: true})
		} else {
			skipped++
			results = append(results, sentence.SuggestionApplyResult{
				SentenceID: s.SentenceID, Applied: false,
				Reason: "sentence not present in latest migration",
			})
		}
	}
	if applied == 0 {
		http.Error(w, "No suggestions applied (none target a current sentence)", http.StatusConflict)
		return
	}

	newContent := []byte(sentence.RebuildManuscript(orderedIDs, committedByID, suggestionByID))

	files := map[string][]byte{
		manuscript.FilePath: newContent,
	}

	// Local mode: commit straight onto the tracked branch and migrate —
	// there is no origin, no PR, no .segman sibling (its only purpose is
	// sentence-granular PR diffs). See MANUSCRIPT_LIFECYCLE_PLAN §3.
	if manuscript.Storage == models.StorageLocal {
		h.commitLocalSuggestions(ctx, w, manuscript, gitRepo, latest, files, applied, skipped, results, session.Username)
		return
	}

	// The checkout may not exist yet (fresh server, wiped repos dir) —
	// Clone is a no-op when present, and the base commit is reachable from
	// origin by definition (it was migrated from there).
	if err := gitRepo.Clone(ctx); err != nil {
		log.Printf("suggestions: push clone %s: %v", manuscript.Name, err)
		http.Error(w, "Failed to prepare repository", http.StatusInternalServerError)
		return
	}

	// Sentence-per-line companion file (see github.com/slackwing/segman
	// integrations/git-hook). Only stage it if the user maintains one in
	// their repo at the base commit — that's the "they opted in to this
	// format" signal. We don't presume to create it for repos that don't
	// already use it.
	segmanPath := segmanSiblingPath(manuscript.FilePath)
	hasSegman, err := gitRepo.PathExistsAtCommit(ctx, latest.CommitHash, segmanPath)
	if err != nil {
		log.Printf("suggestions: probe segman sibling %s: %v", segmanPath, err)
		http.Error(w, "Failed to probe segman sibling", http.StatusInternalServerError)
		return
	}
	if hasSegman {
		segmented := segman.Segment(string(newContent))
		var b bytes.Buffer
		for _, s := range segmented {
			// Defensive: collapse any embedded newlines so the
			// "one sentence per line" invariant of the file format
			// holds even if a future segman revision starts emitting
			// multi-line sentences.
			b.WriteString(strings.ReplaceAll(s, "\n", " "))
			b.WriteByte('\n')
		}
		files[segmanPath] = b.Bytes()
	}

	branch := canonicalSuggestionsBranch(latest.CommitHash, session.Username)
	message := fmt.Sprintf("Apply %d suggested edit(s) from %s", applied, session.Username)
	// Synth an email so commit-tree never depends on host-side git config.
	authorEmail := fmt.Sprintf("%s@manuscript-studio.local", sanitizeBranchComponent(session.Username))
	// Always force-push: the branch is a per-(commit, user) canonical name and
	// we own it.
	commitSHA, err := gitRepo.WriteCommitPushBranch(ctx, latest.CommitHash, branch, files, message, true, session.Username, authorEmail)
	if err != nil {
		log.Printf("suggestions: push branch %s: %v", branch, err)
		http.Error(w, "Failed to push branch", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(pushSuggestionsResponse{
		Branch:     branch,
		CompareURL: h.compareURLFor(manuscript, branch),
		CommitSHA:  commitSHA,
		Applied:    applied,
		Skipped:    skipped,
		Results:    results,
	})
}

// commitLocalSuggestions is the local-mode tail of HandlePushSuggestions:
// commit the rebuilt manuscript onto the tracked branch, then enqueue the
// migration that would normally arrive via webhook. Holds the same lock as
// the migration goroutines so a base-vs-HEAD race can't drop a commit.
func (h *SuggestionHandlers) commitLocalSuggestions(
	ctx context.Context, w http.ResponseWriter,
	manuscript *models.Manuscript, gitRepo *migrations.GitRepository,
	latest *models.Migration, files map[string][]byte,
	applied, skipped int, results []sentence.SuggestionApplyResult, username string,
) {
	unlock := lockMigrationPath(gitRepo.Path)
	head, err := gitRepo.GetLatestCommitHash(ctx)
	if err != nil {
		unlock()
		log.Printf("suggestions: local HEAD %s: %v", manuscript.Name, err)
		http.Error(w, "Failed to read local repo", http.StatusInternalServerError)
		return
	}
	// The stale-migration guard already ran, but a commit whose migration
	// hasn't completed yet wouldn't trip it — compare against the actual
	// branch head so a second commit can't base on a superseded state.
	if head != latest.CommitHash {
		unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "stale",
			"hint":  "a commit is still migrating — please refresh",
		})
		return
	}

	message := fmt.Sprintf("Apply %d suggested edit(s) from %s", applied, username)
	authorEmail := fmt.Sprintf("%s@manuscript-studio.local", sanitizeBranchComponent(username))
	commitSHA, err := gitRepo.WriteCommitPushBranch(ctx, latest.CommitHash, manuscript.Branch(), files, message, false, username, authorEmail)
	unlock()
	if err != nil {
		log.Printf("suggestions: local commit %s: %v", manuscript.Name, err)
		http.Error(w, "Failed to commit", http.StatusInternalServerError)
		return
	}

	migrationID, err := h.Admin.enqueueMigration(ctx, manuscript, commitSHA)
	if err != nil && !errors.Is(err, database.ErrMigrationInProgress) {
		// The commit landed; the migration can be retried via sync. Surface
		// the partial state honestly.
		log.Printf("suggestions: local commit %s migrated=false: %v", manuscript.Name, err)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(pushSuggestionsResponse{
		Branch:      manuscript.Branch(),
		CommitSHA:   commitSHA,
		Applied:     applied,
		Skipped:     skipped,
		Results:     results,
		MigrationID: migrationID,
	})
}

// canonicalSuggestionsBranch is the one-and-only branch name that push and
// push-state target for this (commit, user). Stable across sessions so
// View-on-GitHub always points at the right place.
func canonicalSuggestionsBranch(commitHash, username string) string {
	commitShort := commitHash
	if len(commitShort) > 7 {
		commitShort = commitShort[:7]
	}
	return fmt.Sprintf("suggestions-%s-%s", commitShort, sanitizeBranchComponent(username))
}

