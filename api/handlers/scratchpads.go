package handlers

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/slackwing/manuscript-studio/internal/auth"
	"github.com/slackwing/manuscript-studio/internal/config"
	"github.com/slackwing/manuscript-studio/internal/database"
	"github.com/slackwing/manuscript-studio/internal/models"
)

// Scratchpads (SCRATCHPAD_PLAN.md): DB-only, USER-owned working material —
// not manuscript-scoped. Every route requires the session user to own the
// scratchpad; mutations require the CSRF token.
type ScratchpadHandlers struct {
	DB           *database.DB
	SessionStore *auth.SessionStore
	Config       *config.Config
}

// maxScratchpadDocBytes caps an autosave payload; maxScratchpadImageBytes
// caps one uploaded image (plan §4).
const (
	maxScratchpadDocBytes   = 4 << 20  // 4MB of PM JSON is an enormous scratchpad
	maxScratchpadImageBytes = 10 << 20 // 10MB
)

var allowedImageTypes = map[string]bool{
	"image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true,
}

func (h *ScratchpadHandlers) requireSession(w http.ResponseWriter, r *http.Request) (*auth.Session, bool) {
	session, err := auth.GetSession(r)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return nil, false
	}
	return session, true
}

func (h *ScratchpadHandlers) requireCSRF(w http.ResponseWriter, r *http.Request) bool {
	csrfToken := r.Header.Get("X-CSRF-Token")
	if !auth.ValidateCSRFToken(r, h.SessionStore, csrfToken) {
		http.Error(w, "Invalid CSRF token", http.StatusForbidden)
		return false
	}
	return true
}

// requireOwnedScratchpad loads the scratchpad and verifies ownership.
// Missing and not-owned are both 404 (don't leak existence).
func (h *ScratchpadHandlers) requireOwnedScratchpad(w http.ResponseWriter, r *http.Request, username string) (*models.Scratchpad, bool) {
	id, err := strconv.Atoi(chi.URLParam(r, "scratchpad_id"))
	if err != nil {
		http.Error(w, "Invalid scratchpad_id", http.StatusBadRequest)
		return nil, false
	}
	s, err := h.DB.GetScratchpad(r.Context(), id)
	if err != nil {
		http.Error(w, "Failed to load scratchpad", http.StatusInternalServerError)
		return nil, false
	}
	if s == nil || s.UserID != username {
		http.Error(w, "Not found", http.StatusNotFound)
		return nil, false
	}
	return s, true
}

func (h *ScratchpadHandlers) HandleList(w http.ResponseWriter, r *http.Request) {
	session, ok := h.requireSession(w, r)
	if !ok {
		return
	}
	pads, err := h.DB.ListScratchpads(r.Context(), session.Username)
	if err != nil {
		http.Error(w, "Failed to list scratchpads", http.StatusInternalServerError)
		return
	}
	if pads == nil {
		pads = []models.Scratchpad{}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"scratchpads": pads})
}

func (h *ScratchpadHandlers) HandleCreate(w http.ResponseWriter, r *http.Request) {
	session, ok := h.requireSession(w, r)
	if !ok || !h.requireCSRF(w, r) {
		return
	}
	var req struct {
		Title string `json:"title"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req) // empty body → Untitled
	s, err := h.DB.CreateScratchpad(r.Context(), session.Username, req.Title)
	if err != nil {
		http.Error(w, "Failed to create scratchpad", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(s)
}

func (h *ScratchpadHandlers) HandleGet(w http.ResponseWriter, r *http.Request) {
	session, ok := h.requireSession(w, r)
	if !ok {
		return
	}
	s, ok := h.requireOwnedScratchpad(w, r, session.Username)
	if !ok {
		return
	}
	h.fillLinkedManuscriptName(r, s)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"scratchpad": s})
}

// fillLinkedManuscriptName resolves the pad's linked-manuscript label from
// config at response time (single source of truth; no stored name to drift).
func (h *ScratchpadHandlers) fillLinkedManuscriptName(r *http.Request, s *models.Scratchpad) {
	if s == nil || s.LinkedManuscriptID == nil {
		return
	}
	s.LinkedManuscriptName = manuscriptDisplayName(r.Context(), h.DB, h.Config, *s.LinkedManuscriptID)
}

// HandleLinkScratchpad sets (manuscript_id != 0) or clears (0) a scratchpad's
// manuscript default. New notes/snippets created in the pad afterward inherit
// it (live default, not retroactive). Mirrors the note/snippet linkers: owns
// the pad + has access to the target manuscript.
func (h *ScratchpadHandlers) HandleLinkScratchpad(w http.ResponseWriter, r *http.Request) {
	session, ok := h.requireSession(w, r)
	if !ok || !h.requireCSRF(w, r) {
		return
	}
	s, ok := h.requireOwnedScratchpad(w, r, session.Username)
	if !ok {
		return
	}
	var req struct {
		ManuscriptID int `json:"manuscript_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid body", http.StatusBadRequest)
		return
	}

	var manuscriptID *int
	if req.ManuscriptID != 0 {
		if !requireManuscriptAccess(w, r, h.DB, h.Config, req.ManuscriptID) {
			return
		}
		mid := req.ManuscriptID
		manuscriptID = &mid
	}

	if err := h.DB.LinkScratchpad(r.Context(), s.ScratchpadID, manuscriptID); err != nil {
		http.Error(w, "Failed to link scratchpad", http.StatusInternalServerError)
		return
	}

	name := ""
	if manuscriptID != nil {
		name = manuscriptDisplayName(r.Context(), h.DB, h.Config, *manuscriptID)
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"linked_manuscript_id":   req.ManuscriptID,
		"linked_manuscript_name": name,
	})
}

func (h *ScratchpadHandlers) HandleUpdate(w http.ResponseWriter, r *http.Request) {
	session, ok := h.requireSession(w, r)
	if !ok || !h.requireCSRF(w, r) {
		return
	}
	s, ok := h.requireOwnedScratchpad(w, r, session.Username)
	if !ok {
		return
	}
	var req struct {
		Title string          `json:"title"`
		Doc   json.RawMessage `json:"doc"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, maxScratchpadDocBytes)).Decode(&req); err != nil {
		http.Error(w, "Invalid body", http.StatusBadRequest)
		return
	}
	if len(req.Doc) == 0 {
		http.Error(w, "doc is required", http.StatusBadRequest)
		return
	}
	// The doc must at least be valid JSON with a doc type; PM enforces the
	// real schema client-side, and the block extractor re-parses on save.
	var probe struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(req.Doc, &probe); err != nil || probe.Type != "doc" {
		http.Error(w, "doc must be a ProseMirror doc", http.StatusBadRequest)
		return
	}
	title := req.Title
	if title == "" {
		title = s.Title
	}
	if err := h.DB.UpdateScratchpad(r.Context(), s.ScratchpadID, title, req.Doc); err != nil {
		http.Error(w, "Failed to save scratchpad", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *ScratchpadHandlers) HandleDelete(w http.ResponseWriter, r *http.Request) {
	session, ok := h.requireSession(w, r)
	if !ok || !h.requireCSRF(w, r) {
		return
	}
	s, ok := h.requireOwnedScratchpad(w, r, session.Username)
	if !ok {
		return
	}
	if err := h.DB.SoftDeleteScratchpad(r.Context(), s.ScratchpadID); err != nil {
		http.Error(w, "Failed to delete scratchpad", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// HandleOpened stamps landing-page recency (modal open, fire-and-forget).
func (h *ScratchpadHandlers) HandleOpened(w http.ResponseWriter, r *http.Request) {
	session, ok := h.requireSession(w, r)
	if !ok || !h.requireCSRF(w, r) {
		return
	}
	s, ok := h.requireOwnedScratchpad(w, r, session.Username)
	if !ok {
		return
	}
	if err := h.DB.TouchScratchpadOpened(r.Context(), s.ScratchpadID); err != nil {
		http.Error(w, "Failed to stamp", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *ScratchpadHandlers) HandleUploadImage(w http.ResponseWriter, r *http.Request) {
	session, ok := h.requireSession(w, r)
	if !ok || !h.requireCSRF(w, r) {
		return
	}
	if err := r.ParseMultipartForm(maxScratchpadImageBytes); err != nil {
		http.Error(w, "Invalid multipart form", http.StatusBadRequest)
		return
	}
	file, header, err := r.FormFile("image")
	if err != nil {
		http.Error(w, "image file is required", http.StatusBadRequest)
		return
	}
	defer file.Close()
	contentType := header.Header.Get("Content-Type")
	if !allowedImageTypes[contentType] {
		http.Error(w, "Unsupported image type (png/jpeg/gif/webp)", http.StatusBadRequest)
		return
	}
	data, err := io.ReadAll(io.LimitReader(file, maxScratchpadImageBytes+1))
	if err != nil || len(data) == 0 {
		http.Error(w, "Failed to read image", http.StatusBadRequest)
		return
	}
	if len(data) > maxScratchpadImageBytes {
		http.Error(w, "Image too large (10MB max)", http.StatusRequestEntityTooLarge)
		return
	}
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		http.Error(w, "Failed to generate id", http.StatusInternalServerError)
		return
	}
	imageID := hex.EncodeToString(buf)
	if err := h.DB.CreateScratchpadImage(r.Context(), session.Username, imageID, contentType, data); err != nil {
		http.Error(w, "Failed to store image", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{"image_id": imageID})
}

// HandleGetImage serves image bytes to their owner. Immutable content →
// aggressive private caching.
func (h *ScratchpadHandlers) HandleGetImage(w http.ResponseWriter, r *http.Request) {
	session, ok := h.requireSession(w, r)
	if !ok {
		return
	}
	imageID := chi.URLParam(r, "image_id")
	userID, contentType, data, err := h.DB.GetScratchpadImage(r.Context(), imageID)
	if err != nil {
		http.Error(w, "Failed to load image", http.StatusInternalServerError)
		return
	}
	if userID == "" || userID != session.Username {
		http.Error(w, "Not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	w.Write(data)
}
