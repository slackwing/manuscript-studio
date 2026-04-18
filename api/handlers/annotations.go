package handlers

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/slackwing/manuscript-studio/internal/auth"
	"github.com/slackwing/manuscript-studio/internal/database"
	"github.com/slackwing/manuscript-studio/internal/models"
)

// AnnotationHandlers contains annotation-related handlers
type AnnotationHandlers struct {
	DB           *database.DB
	SessionStore *auth.SessionStore
}

// CreateAnnotationRequest represents a request to create an annotation
type CreateAnnotationRequest struct {
	SentenceID string  `json:"sentence_id"`
	Color      string  `json:"color"`
	Note       string  `json:"note"`
	Priority   int     `json:"priority"`
	Position   float64 `json:"position"`
	Flagged    bool    `json:"flagged"`
}

// HandleGetAnnotationsByCommit returns annotations for a specific commit
func (h *AnnotationHandlers) HandleGetAnnotationsByCommit(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	// Get commit_hash from URL
	commitHash := chi.URLParam(r, "commit_hash")
	if commitHash == "" {
		http.Error(w, "commit_hash is required", http.StatusBadRequest)
		return
	}

	// Get user from context (set by auth middleware)
	userVal := ctx.Value("user")
	if userVal == nil {
		http.Error(w, "User not found in context", http.StatusInternalServerError)
		return
	}
	username := userVal.(string)

	// Get annotations for this commit and user
	// Note: UserID in database is actually the username (VARCHAR)
	annotations, err := h.DB.GetAnnotationsForCommitAndUser(ctx, commitHash, username)
	if err != nil {
		http.Error(w, "Failed to get annotations", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"annotations": annotations,
	})
}

// HandleCreateAnnotation creates a new annotation
func (h *AnnotationHandlers) HandleCreateAnnotation(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	// Get user from context
	userVal := ctx.Value("user")
	if userVal == nil {
		http.Error(w, "User not found in context", http.StatusInternalServerError)
		return
	}
	username := userVal.(string)

	// Parse request
	var req CreateAnnotationRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	// Validate
	if req.SentenceID == "" {
		http.Error(w, "sentence_id is required", http.StatusBadRequest)
		return
	}

	// Create annotation
	annotation := &models.Annotation{
		SentenceID: req.SentenceID,
		UserID:     username, // UserID is actually username in the database
		Color:      req.Color,
		Note:       req.Note,
		Priority:   req.Priority,
		Position:   req.Position,
		Flagged:    req.Flagged,
	}

	// Default color if not specified
	if annotation.Color == "" {
		annotation.Color = "yellow"
	}

	// Create initial version (required for CreateAnnotation)
	version := &models.AnnotationVersion{
		SentenceID:          req.SentenceID,
		Color:               annotation.Color,
		Note:                annotation.Note,
		Priority:            annotation.Priority,
		Flagged:             annotation.Flagged,
		MigrationConfidence: 1.0,
		CreatedBy:           username,
	}

	if err := h.DB.CreateAnnotation(ctx, annotation, version); err != nil {
		http.Error(w, "Failed to create annotation", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(annotation)
}

// HandleUpdateAnnotation updates an existing annotation
func (h *AnnotationHandlers) HandleUpdateAnnotation(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	// Get annotation ID from URL
	annotationIDStr := chi.URLParam(r, "annotation_id")
	annotationID, err := strconv.Atoi(annotationIDStr)
	if err != nil {
		http.Error(w, "Invalid annotation_id", http.StatusBadRequest)
		return
	}

	// Get user from context
	userVal := ctx.Value("user")
	if userVal == nil {
		http.Error(w, "User not found in context", http.StatusInternalServerError)
		return
	}
	username := userVal.(string)

	// Verify CSRF token
	csrfToken := r.Header.Get("X-CSRF-Token")
	if !auth.ValidateCSRFToken(r, h.SessionStore, csrfToken) {
		http.Error(w, "Invalid CSRF token", http.StatusForbidden)
		return
	}

	// Get existing annotation to verify ownership
	existing, err := h.DB.GetAnnotationByID(ctx, annotationID)
	if err != nil {
		http.Error(w, "Annotation not found", http.StatusNotFound)
		return
	}

	if existing.UserID != username {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}

	// Parse update request
	var updates map[string]interface{}
	if err := json.NewDecoder(r.Body).Decode(&updates); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	// Update allowed fields
	if color, ok := updates["color"].(string); ok {
		existing.Color = color
	}
	if note, ok := updates["note"].(string); ok {
		existing.Note = note
	}
	if priority, ok := updates["priority"].(float64); ok {
		existing.Priority = int(priority)
	}
	if flagged, ok := updates["flagged"].(bool); ok {
		existing.Flagged = flagged
	}

	// Create new version for update
	version := &models.AnnotationVersion{
		SentenceID:          existing.SentenceID,
		Color:               existing.Color,
		Note:                existing.Note,
		Priority:            existing.Priority,
		Flagged:             existing.Flagged,
		MigrationConfidence: 1.0,
		CreatedBy:           username,
	}

	// Save updates
	if err := h.DB.UpdateAnnotation(ctx, annotationID, existing, version); err != nil {
		http.Error(w, "Failed to update annotation", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(existing)
}

// HandleDeleteAnnotation deletes an annotation (soft delete)
func (h *AnnotationHandlers) HandleDeleteAnnotation(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	// Get annotation ID from URL
	annotationIDStr := chi.URLParam(r, "annotation_id")
	annotationID, err := strconv.Atoi(annotationIDStr)
	if err != nil {
		http.Error(w, "Invalid annotation_id", http.StatusBadRequest)
		return
	}

	// Get user from context
	userVal := ctx.Value("user")
	if userVal == nil {
		http.Error(w, "User not found in context", http.StatusInternalServerError)
		return
	}
	username := userVal.(string)

	// Verify CSRF token
	csrfToken := r.Header.Get("X-CSRF-Token")
	if !auth.ValidateCSRFToken(r, h.SessionStore, csrfToken) {
		http.Error(w, "Invalid CSRF token", http.StatusForbidden)
		return
	}

	// Get existing annotation to verify ownership
	existing, err := h.DB.GetAnnotationByID(ctx, annotationID)
	if err != nil {
		http.Error(w, "Annotation not found", http.StatusNotFound)
		return
	}

	if existing.UserID != username {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}

	// Soft delete
	if err := h.DB.DeleteAnnotation(ctx, annotationID); err != nil {
		http.Error(w, "Failed to delete annotation", http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}