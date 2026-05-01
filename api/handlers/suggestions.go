package handlers

import (
	"bytes"
	"encoding/json"
	"fmt"
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
	if _, ok := requireManuscriptAccessForMigration(w, r, h.DB, h.Config, migrationID); !ok {
		return
	}

	session, err := auth.GetSession(r)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	suggestions, err := h.DB.GetSuggestionsForMigration(ctx, migrationID, session.Username)
	if err != nil {
		http.Error(w, "Failed to load suggestions", http.StatusInternalServerError)
		return
	}
	if suggestions == nil {
		suggestions = []models.SuggestedChange{}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"suggestions": suggestions,
	})
}

// HandlePutSuggestion upserts a suggestion. Text identical to the original
// sentence is collapsed into a delete so "revert by re-saving the original"
// works without client logic.
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
		http.Error(w, fmt.Sprintf("Failed to save suggestion: %v", err), http.StatusInternalServerError)
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
	Branch     string                            `json:"branch"`
	CompareURL string                            `json:"compare_url"`
	CommitSHA  string                            `json:"commit_sha"`
	Applied    int                               `json:"applied"`
	Skipped    int                               `json:"skipped"`
	Results    []sentence.SuggestionApplyResult  `json:"results"`
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
	mc := h.findManuscriptConfig(manuscript.RepoPath, manuscript.FilePath)
	if mc == nil {
		http.Error(w, "Manuscript not configured on this server", http.StatusNotImplemented)
		return
	}

	branch := canonicalSuggestionsBranch(migration.CommitHash, session.Username)

	gitRepo := &migrations.GitRepository{
		Path:      h.Config.RepoPath(mc.Name),
		Branch:    mc.Repository.Branch,
		RemoteURL: mc.Repository.CloneURL(),
		FilePath:  mc.Repository.Path,
		AuthToken: mc.Repository.AuthToken,
	}
	exists, err := gitRepo.LocalBranchExists(ctx, branch)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to check branch: %v", err), http.StatusInternalServerError)
		return
	}

	compareURL := ""
	if mc.Repository.Slug != "" {
		compareURL = fmt.Sprintf("https://github.com/%s/compare/%s", mc.Repository.Slug, branch)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"branch":        branch,
		"branch_exists": exists,
		"compare_url":   compareURL,
	})
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
	if !requireManuscriptAccess(w, r, h.DB, h.Config, manuscriptID) {
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

	// Body is intentionally ignored — this endpoint has exactly one mode
	// (force-push the canonical branch). Older clients that send
	// {"action":"update"} continue to work; "new" is silently dropped.

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
			"error":          "stale",
			"latest_id":      strconv.Itoa(latest.MigrationID),
			"requested_id":   strconv.Itoa(migrationID),
			"hint":           "manuscript has been updated — please refresh",
		})
		return
	}

	manuscript, err := h.DB.GetManuscriptByID(ctx, manuscriptID)
	if err != nil || manuscript == nil {
		http.Error(w, "Manuscript not found", http.StatusNotFound)
		return
	}
	mc := h.findManuscriptConfig(manuscript.RepoPath, manuscript.FilePath)
	if mc == nil {
		http.Error(w, "Manuscript not configured on this server", http.StatusNotImplemented)
		return
	}

	suggestions, err := h.DB.GetSuggestionsForMigration(ctx, migrationID, session.Username)
	if err != nil {
		http.Error(w, "Failed to load suggestions", http.StatusInternalServerError)
		return
	}
	if len(suggestions) == 0 {
		http.Error(w, "No suggestions to push", http.StatusBadRequest)
		return
	}
	sentenceIDs := make([]string, len(suggestions))
	for i, s := range suggestions {
		sentenceIDs[i] = s.SentenceID
	}
	sentenceRows, err := h.DB.GetSentenceTextsByIDs(ctx, sentenceIDs)
	if err != nil {
		http.Error(w, "Failed to load sentence originals", http.StatusInternalServerError)
		return
	}
	originals := make(map[string]string, len(sentenceRows))
	for id, row := range sentenceRows {
		originals[id] = row.Text
	}

	gitRepo := &migrations.GitRepository{
		Path:      h.Config.RepoPath(mc.Name),
		Branch:    mc.Repository.Branch,
		RemoteURL: mc.Repository.CloneURL(),
		FilePath:  mc.Repository.Path,
		AuthToken: mc.Repository.AuthToken,
	}
	srcStr, err := gitRepo.GetFileContent(ctx, latest.CommitHash)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to read manuscript at %s: %v", latest.CommitHash, err), http.StatusInternalServerError)
		return
	}

	newContent, results := sentence.ApplySuggestions([]byte(srcStr), suggestions, originals)
	applied, skipped := 0, 0
	for _, r := range results {
		if r.Applied {
			applied++
		} else {
			skipped++
		}
	}
	if applied == 0 {
		http.Error(w, "No suggestions applied (all originals missing from source)", http.StatusConflict)
		return
	}

	files := map[string][]byte{
		mc.Repository.Path: newContent,
	}

	// Sentence-per-line companion file (see github.com/slackwing/segman
	// integrations/git-hook). Only stage it if the user maintains one in
	// their repo at the base commit — that's the "they opted in to this
	// format" signal. We don't presume to create it for repos that don't
	// already use it.
	segmanPath := segmanSiblingPath(mc.Repository.Path)
	hasSegman, err := gitRepo.PathExistsAtCommit(ctx, latest.CommitHash, segmanPath)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to probe segman sibling: %v", err), http.StatusInternalServerError)
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
		http.Error(w, fmt.Sprintf("Failed to push branch: %v", err), http.StatusInternalServerError)
		return
	}

	compareURL := ""
	if mc.Repository.Slug != "" {
		compareURL = fmt.Sprintf("https://github.com/%s/compare/%s", mc.Repository.Slug, branch)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(pushSuggestionsResponse{
		Branch:     branch,
		CompareURL: compareURL,
		CommitSHA:  commitSHA,
		Applied:    applied,
		Skipped:    skipped,
		Results:    results,
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

func (h *SuggestionHandlers) findManuscriptConfig(repoURL, filePath string) *config.ManuscriptConfig {
	for i, m := range h.Config.Manuscripts {
		if m.Repository.CloneURL() == repoURL && m.Repository.Path == filePath {
			return &h.Config.Manuscripts[i]
		}
	}
	return nil
}

