package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/slackwing/manuscript-studio/internal/auth"
	"github.com/slackwing/manuscript-studio/internal/database"
	"github.com/slackwing/manuscript-studio/internal/models"
)

// Suggestions are per-user, per-sentence, scoped to a migration via sentence_id FK.
type SuggestionHandlers struct {
	DB           *database.DB
	SessionStore *auth.SessionStore
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

