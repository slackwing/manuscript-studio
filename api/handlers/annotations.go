package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/slackwing/manuscript-studio/internal/auth"
	"github.com/slackwing/manuscript-studio/internal/config"
	"github.com/slackwing/manuscript-studio/internal/database"
	"github.com/slackwing/manuscript-studio/internal/models"
)

type AnnotationHandlers struct {
	DB           *database.DB
	SessionStore *auth.SessionStore
	Config       *config.Config
}

type CreateAnnotationRequest struct {
	SentenceID string  `json:"sentence_id"`
	Color      string  `json:"color"`
	Note       *string `json:"note"`
	Priority   string  `json:"priority"`
	Flagged    bool    `json:"flagged"`
}

type UpdateAnnotationRequest struct {
	Color    *string `json:"color,omitempty"`
	Note     *string `json:"note,omitempty"`
	Priority *string `json:"priority,omitempty"`
	Flagged  *bool   `json:"flagged,omitempty"`
}

type ReorderAnnotationRequest struct {
	SentenceID string `json:"sentence_id"`
	NewIndex   int    `json:"new_index"`
}

func (h *AnnotationHandlers) HandleGetAnnotationsByCommit(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	commitHash := chi.URLParam(r, "commit_hash")
	if commitHash == "" {
		http.Error(w, "commit_hash is required", http.StatusBadRequest)
		return
	}

	session, err := auth.GetSession(r)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	annotations, err := h.DB.GetAnnotationsByCommit(ctx, commitHash, session.Username)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to get annotations: %v", err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"annotations": annotations,
	})
}

func (h *AnnotationHandlers) HandleGetAnnotationsBySentence(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	sentenceID := chi.URLParam(r, "sentence_id")
	if !requireManuscriptAccessForSentence(w, r, h.DB, h.Config, sentenceID) {
		return
	}

	session, err := auth.GetSession(r)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	annotations, err := h.DB.GetAnnotationsBySentence(ctx, sentenceID, session.Username)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to get annotations: %v", err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"annotations": annotations,
	})
}

func (h *AnnotationHandlers) HandleCreateAnnotation(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	var req CreateAnnotationRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}
	if req.Color == "" || req.SentenceID == "" {
		http.Error(w, "Missing required fields: color, sentence_id", http.StatusBadRequest)
		return
	}
	if !requireManuscriptAccessForSentence(w, r, h.DB, h.Config, req.SentenceID) {
		return
	}

	session, err := auth.GetSession(r)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	priority := req.Priority
	if priority == "" {
		priority = "none"
	}

	annotation := &models.Annotation{
		SentenceID: req.SentenceID,
		UserID:     session.Username,
		Color:      req.Color,
		Note:       req.Note,
		Priority:   priority,
		Flagged:    req.Flagged,
	}

	version := &models.AnnotationVersion{
		MigrationConfidence: nil,
	}

	if err := h.DB.CreateAnnotation(ctx, annotation, version); err != nil {
		http.Error(w, fmt.Sprintf("Failed to create annotation: %v", err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"annotation_id": annotation.AnnotationID,
		"version":       version.Version,
	})
}

// HandleUpdateAnnotation mutates the head row and appends a new version.
func (h *AnnotationHandlers) HandleUpdateAnnotation(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	annotationIDStr := chi.URLParam(r, "annotation_id")
	annotationID, err := strconv.Atoi(annotationIDStr)
	if err != nil {
		http.Error(w, "Invalid annotation_id", http.StatusBadRequest)
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

	existing, err := h.DB.GetAnnotationByID(ctx, annotationID)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to get annotation: %v", err), http.StatusInternalServerError)
		return
	}
	if existing == nil {
		http.Error(w, "Annotation not found", http.StatusNotFound)
		return
	}
	if existing.UserID != session.Username {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}

	var req UpdateAnnotationRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	if req.Color != nil {
		existing.Color = *req.Color
	}
	if req.Note != nil {
		existing.Note = req.Note
	}
	if req.Priority != nil {
		existing.Priority = *req.Priority
	}
	if req.Flagged != nil {
		existing.Flagged = *req.Flagged
	}

	version := &models.AnnotationVersion{
		MigrationConfidence: nil,
	}

	if err := h.DB.UpdateAnnotation(ctx, annotationID, existing, version); err != nil {
		http.Error(w, fmt.Sprintf("Failed to update annotation: %v", err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(existing)
}

func (h *AnnotationHandlers) HandleReorderAnnotation(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	annotationIDStr := chi.URLParam(r, "annotation_id")
	annotationID, err := strconv.Atoi(annotationIDStr)
	if err != nil {
		http.Error(w, "Invalid annotation_id", http.StatusBadRequest)
		return
	}

	session, err := auth.GetSession(r)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	existing, err := h.DB.GetAnnotationByID(ctx, annotationID)
	if err != nil || existing == nil {
		http.Error(w, "Annotation not found", http.StatusNotFound)
		return
	}
	if existing.UserID != session.Username {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}

	var req ReorderAnnotationRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	if err := h.DB.ReorderAnnotation(ctx, annotationID, req.SentenceID, req.NewIndex); err != nil {
		http.Error(w, fmt.Sprintf("Failed to reorder: %v", err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"message": "Annotation reordered successfully"})
}

func (h *AnnotationHandlers) HandleDeleteAnnotation(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	annotationIDStr := chi.URLParam(r, "annotation_id")
	annotationID, err := strconv.Atoi(annotationIDStr)
	if err != nil {
		http.Error(w, "Invalid annotation_id", http.StatusBadRequest)
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

	existing, err := h.DB.GetAnnotationByID(ctx, annotationID)
	if err != nil || existing == nil {
		http.Error(w, "Annotation not found", http.StatusNotFound)
		return
	}
	if existing.UserID != session.Username {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}

	if err := h.DB.SoftDeleteAnnotation(ctx, annotationID); err != nil {
		http.Error(w, fmt.Sprintf("Failed to delete: %v", err), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

func (h *AnnotationHandlers) HandleCompleteAnnotation(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	annotationIDStr := chi.URLParam(r, "annotation_id")
	annotationID, err := strconv.Atoi(annotationIDStr)
	if err != nil {
		http.Error(w, "Invalid annotation_id", http.StatusBadRequest)
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

	existing, err := h.DB.GetAnnotationByID(ctx, annotationID)
	if err != nil || existing == nil {
		http.Error(w, "Annotation not found", http.StatusNotFound)
		return
	}
	if existing.UserID != session.Username {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}

	if err := h.DB.CompleteAnnotation(ctx, annotationID); err != nil {
		http.Error(w, fmt.Sprintf("Failed to complete: %v", err), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

func (h *AnnotationHandlers) HandleGetTagsForAnnotation(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	annotationIDStr := chi.URLParam(r, "annotation_id")
	annotationID, err := strconv.Atoi(annotationIDStr)
	if err != nil {
		http.Error(w, "Invalid annotation_id", http.StatusBadRequest)
		return
	}

	tags, err := h.DB.GetTagsForAnnotation(ctx, annotationID)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to get tags: %v", err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"tags": tags})
}

type AddTagRequest struct {
	TagName     string `json:"tag_name"`
	MigrationID int    `json:"migration_id"`
}

// HandleAddTagToAnnotation creates the tag if needed and links it.
func (h *AnnotationHandlers) HandleAddTagToAnnotation(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	annotationIDStr := chi.URLParam(r, "annotation_id")
	annotationID, err := strconv.Atoi(annotationIDStr)
	if err != nil {
		http.Error(w, "Invalid annotation_id", http.StatusBadRequest)
		return
	}

	var req AddTagRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}
	if req.TagName == "" || req.MigrationID == 0 {
		http.Error(w, "tag_name and migration_id are required", http.StatusBadRequest)
		return
	}

	if err := h.DB.AddTagToAnnotation(ctx, annotationID, req.TagName, req.MigrationID); err != nil {
		http.Error(w, fmt.Sprintf("Failed to add tag: %v", err), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusCreated)
}

func (h *AnnotationHandlers) HandleRemoveTagFromAnnotation(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	annotationIDStr := chi.URLParam(r, "annotation_id")
	annotationID, err := strconv.Atoi(annotationIDStr)
	if err != nil {
		http.Error(w, "Invalid annotation_id", http.StatusBadRequest)
		return
	}
	tagIDStr := chi.URLParam(r, "tag_id")
	tagID, err := strconv.Atoi(tagIDStr)
	if err != nil {
		http.Error(w, "Invalid tag_id", http.StatusBadRequest)
		return
	}

	if err := h.DB.RemoveTagFromAnnotation(ctx, annotationID, tagID); err != nil {
		http.Error(w, fmt.Sprintf("Failed to remove tag: %v", err), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}
