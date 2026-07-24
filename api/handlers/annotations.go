package handlers

import (
	"encoding/json"
	"log"
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

// requireOwnedAnnotation loads an annotation and enforces the full guard
// chain for per-annotation endpoints: the row must exist, belong to the
// session user, and live in a manuscript the user still has access to.
// Writes the HTTP error and returns nil on any failure; callers should
// `return` immediately on nil.
func (h *AnnotationHandlers) requireOwnedAnnotation(w http.ResponseWriter, r *http.Request,
	annotationID int, username string,
) *models.Annotation {
	existing, err := h.DB.GetAnnotationByID(r.Context(), annotationID)
	if err != nil {
		log.Printf("annotations: load %d: %v", annotationID, err)
		http.Error(w, "Failed to get annotation", http.StatusInternalServerError)
		return nil
	}
	if existing == nil {
		http.Error(w, "Annotation not found", http.StatusNotFound)
		return nil
	}
	if existing.UserID != username {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return nil
	}
	if !requireManuscriptAccessForSentence(w, r, h.DB, h.Config, existing.SentenceID) {
		return nil
	}
	return existing
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
		log.Printf("annotations: list by commit %s: %v", commitHash, err)
		http.Error(w, "Failed to get annotations", http.StatusInternalServerError)
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
		log.Printf("annotations: list by sentence %s: %v", sentenceID, err)
		http.Error(w, "Failed to get annotations", http.StatusInternalServerError)
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
		log.Printf("annotations: create on sentence %s: %v", req.SentenceID, err)
		http.Error(w, "Failed to create annotation", http.StatusInternalServerError)
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

	existing := h.requireOwnedAnnotation(w, r, annotationID, session.Username)
	if existing == nil {
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
		log.Printf("annotations: update %d: %v", annotationID, err)
		http.Error(w, "Failed to update annotation", http.StatusInternalServerError)
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

	csrfToken := r.Header.Get("X-CSRF-Token")
	if !auth.ValidateCSRFToken(r, h.SessionStore, csrfToken) {
		http.Error(w, "Invalid CSRF token", http.StatusForbidden)
		return
	}

	if h.requireOwnedAnnotation(w, r, annotationID, session.Username) == nil {
		return
	}

	var req ReorderAnnotationRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	if err := h.DB.ReorderAnnotation(ctx, annotationID, req.SentenceID, req.NewIndex); err != nil {
		log.Printf("annotations: reorder %d: %v", annotationID, err)
		http.Error(w, "Failed to reorder", http.StatusInternalServerError)
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

	if h.requireOwnedAnnotation(w, r, annotationID, session.Username) == nil {
		return
	}

	if err := h.DB.SoftDeleteAnnotation(ctx, annotationID); err != nil {
		log.Printf("annotations: delete %d: %v", annotationID, err)
		http.Error(w, "Failed to delete", http.StatusInternalServerError)
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

	if h.requireOwnedAnnotation(w, r, annotationID, session.Username) == nil {
		return
	}

	if err := h.DB.CompleteAnnotation(ctx, annotationID); err != nil {
		log.Printf("annotations: complete %d: %v", annotationID, err)
		http.Error(w, "Failed to complete", http.StatusInternalServerError)
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

	session, err := auth.GetSession(r)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	if h.requireOwnedAnnotation(w, r, annotationID, session.Username) == nil {
		return
	}

	tags, err := h.DB.GetTagsForAnnotation(ctx, annotationID)
	if err != nil {
		log.Printf("annotations: get tags for %d: %v", annotationID, err)
		http.Error(w, "Failed to get tags", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"tags": tags})
}

type AddTagRequest struct {
	TagName string `json:"tag_name"`
	// MigrationID is accepted for backward compatibility but ignored; the
	// tag's migration scope is derived server-side from the annotation's
	// sentence so a client can't attach tags to arbitrary migrations.
	MigrationID int `json:"migration_id"`
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

	var req AddTagRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}
	if req.TagName == "" {
		http.Error(w, "tag_name is required", http.StatusBadRequest)
		return
	}

	existing := h.requireOwnedAnnotation(w, r, annotationID, session.Username)
	if existing == nil {
		return
	}

	// Scope the tag to the migration the annotation's sentence belongs to,
	// never to a client-supplied migration id.
	migrationID, err := h.DB.GetMigrationIDForSentence(ctx, existing.SentenceID)
	if err != nil || migrationID == 0 {
		log.Printf("annotations: resolve migration for sentence %s: %v", existing.SentenceID, err)
		http.Error(w, "Failed to add tag", http.StatusInternalServerError)
		return
	}

	if err := h.DB.AddTagToAnnotation(ctx, annotationID, req.TagName, migrationID); err != nil {
		log.Printf("annotations: add tag to %d: %v", annotationID, err)
		http.Error(w, "Failed to add tag", http.StatusInternalServerError)
		return
	}

	// Return the post-add tag list so the client can update its in-memory
	// annotation cache without a follow-up GET. Frontend's tag-add code
	// reads `data.tags`.
	tags, err := h.DB.GetTagsForAnnotation(ctx, annotationID)
	if err != nil {
		log.Printf("annotations: load tags after add for %d: %v", annotationID, err)
		http.Error(w, "Failed to load tags after add", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]interface{}{"tags": tags})
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

	if h.requireOwnedAnnotation(w, r, annotationID, session.Username) == nil {
		return
	}

	if err := h.DB.RemoveTagFromAnnotation(ctx, annotationID, tagID); err != nil {
		log.Printf("annotations: remove tag %d from %d: %v", tagID, annotationID, err)
		http.Error(w, "Failed to remove tag", http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}
