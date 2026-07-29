package handlers

import (
	"context"
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

type NoteHandlers struct {
	DB           *database.DB
	SessionStore *auth.SessionStore
	Config       *config.Config
}

type CreateNoteRequest struct {
	SentenceID   string  `json:"sentence_id"`
	ScratchpadID *int    `json:"scratchpad_id"` // set → a scratchpad note (no sentence)
	Color        string  `json:"color"`
	Body         *string `json:"body"`
	Priority     string  `json:"priority"`
	Flagged      bool    `json:"flagged"`
}

type UpdateNoteRequest struct {
	Color    *string `json:"color,omitempty"`
	Body     *string `json:"body,omitempty"`
	Priority *string `json:"priority,omitempty"`
	Flagged  *bool   `json:"flagged,omitempty"`
}

type ReorderNoteRequest struct {
	SentenceID string `json:"sentence_id"`
	NewIndex   int    `json:"new_index"`
}

// requireOwnedNote loads an note and enforces the full guard
// chain for per-note endpoints: the row must exist, belong to the
// session user, and live in a manuscript the user still has access to.
// Writes the HTTP error and returns nil on any failure; callers should
// `return` immediately on nil.
func (h *NoteHandlers) requireOwnedNote(w http.ResponseWriter, r *http.Request,
	noteID int, username string,
) *models.Note {
	existing, err := h.DB.GetNoteByID(r.Context(), noteID)
	if err != nil {
		log.Printf("notes: load %d: %v", noteID, err)
		http.Error(w, "Failed to get note", http.StatusInternalServerError)
		return nil
	}
	if existing == nil {
		http.Error(w, "Note not found", http.StatusNotFound)
		return nil
	}
	if existing.UserID != username {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return nil
	}
	// Sentence notes additionally require manuscript access. A scratchpad/free
	// note (no sentence) is gated by user ownership alone (checked above).
	if existing.SentenceID != "" {
		if !requireManuscriptAccessForSentence(w, r, h.DB, h.Config, existing.SentenceID) {
			return nil
		}
	}
	return existing
}

func (h *NoteHandlers) HandleGetNotesByCommit(w http.ResponseWriter, r *http.Request) {
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

	notes, err := h.DB.GetNotesByCommit(ctx, commitHash, session.Username)
	if err != nil {
		log.Printf("notes: list by commit %s: %v", commitHash, err)
		http.Error(w, "Failed to get notes", http.StatusInternalServerError)
		return
	}
	h.fillManuscriptNames(ctx, notes)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"notes": notes,
	})
}

// fillManuscriptNames resolves the manuscript label for a slice of notes,
// caching per manuscript_id so a page of same-manuscript notes hits config once.
func (h *NoteHandlers) fillManuscriptNames(ctx context.Context, notes []models.Note) {
	cache := map[int]string{}
	for i := range notes {
		if notes[i].ManuscriptID == nil {
			continue
		}
		mid := *notes[i].ManuscriptID
		name, ok := cache[mid]
		if !ok {
			name = manuscriptDisplayName(ctx, h.DB, h.Config, mid)
			cache[mid] = name
		}
		notes[i].ManuscriptName = name
	}
}

func (h *NoteHandlers) HandleGetNotesBySentence(w http.ResponseWriter, r *http.Request) {
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

	notes, err := h.DB.GetNotesBySentence(ctx, sentenceID, session.Username)
	if err != nil {
		log.Printf("notes: list by sentence %s: %v", sentenceID, err)
		http.Error(w, "Failed to get notes", http.StatusInternalServerError)
		return
	}
	h.fillManuscriptNames(ctx, notes)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"notes": notes,
	})
}

// HandleGetNoteByID returns a single owned note (with tags) — the client note
// cache reads this so the atomic noteRef widget + float source truth from the DB
// (NOTES_PLAN.md Phase 2 rework: color lives on the note, not in the doc).
func (h *NoteHandlers) HandleGetNoteByID(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	noteID, err := strconv.Atoi(chi.URLParam(r, "note_id"))
	if err != nil {
		http.Error(w, "Invalid note_id", http.StatusBadRequest)
		return
	}
	session, err := auth.GetSession(r)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	note := h.requireOwnedNote(w, r, noteID, session.Username)
	if note == nil {
		return
	}
	if tags, err := h.DB.GetTagsForNote(ctx, noteID); err == nil {
		note.Tags = tags
	}
	h.fillManuscriptName(ctx, note)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(note)
}

// fillManuscriptName resolves a linked note's manuscript label from config (the
// single source of truth), so the note chip shows a name in every view without
// a denormalized column that could drift.
func (h *NoteHandlers) fillManuscriptName(ctx context.Context, note *models.Note) {
	if note == nil || note.ManuscriptID == nil {
		return
	}
	note.ManuscriptName = manuscriptDisplayName(ctx, h.DB, h.Config, *note.ManuscriptID)
}

// HandleLinkNoteManuscript links (manuscript_id != 0) or unlinks (0) a note to a
// manuscript. This is what puts a note into "all my Wildfire notes" — the note
// chip in every view calls it. Mirrors the snippet linker: user must own the
// note and have access to the target manuscript.
func (h *NoteHandlers) HandleLinkNoteManuscript(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	noteID, err := strconv.Atoi(chi.URLParam(r, "note_id"))
	if err != nil {
		http.Error(w, "Invalid note_id", http.StatusBadRequest)
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
		ManuscriptID int `json:"manuscript_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	note := h.requireOwnedNote(w, r, noteID, session.Username)
	if note == nil {
		return
	}

	var manuscriptID *int
	if req.ManuscriptID != 0 {
		// Linking: the user must have access to the target manuscript.
		if !requireManuscriptAccess(w, r, h.DB, h.Config, req.ManuscriptID) {
			return
		}
		mid := req.ManuscriptID
		manuscriptID = &mid
	}

	if err := h.DB.SetNoteManuscript(ctx, noteID, manuscriptID); err != nil {
		log.Printf("notes: link %d → manuscript %v: %v", noteID, manuscriptID, err)
		http.Error(w, "Failed to link note", http.StatusInternalServerError)
		return
	}

	note.ManuscriptID = manuscriptID
	h.fillManuscriptName(ctx, note)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"manuscript_id":   req.ManuscriptID,
		"manuscript_name": note.ManuscriptName,
	})
}

func (h *NoteHandlers) HandleCreateNote(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	var req CreateNoteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}
	if req.Color == "" {
		http.Error(w, "Missing required field: color", http.StatusBadRequest)
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

	// --- Scratchpad note: no sentence, no version row. Ownership is on the
	//     scratchpad. (NOTES_PLAN.md Phase 2.) ---
	if req.ScratchpadID != nil {
		s, err := h.DB.GetScratchpad(ctx, *req.ScratchpadID)
		if err != nil {
			http.Error(w, "Failed to load scratchpad", http.StatusInternalServerError)
			return
		}
		if s == nil || s.UserID != session.Username {
			http.Error(w, "Not found", http.StatusNotFound) // don't leak existence
			return
		}
		note := &models.Note{
			UserID:   session.Username,
			Color:    req.Color,
			Body:     req.Body,
			Priority: priority,
			Flagged:  req.Flagged,
			// Live default: a note created in a manuscript-linked pad inherits the
			// manuscript (Phase C), so it's browsable without hand-linking. Not
			// retroactive — only affects notes created while the pad is linked.
			ManuscriptID: s.LinkedManuscriptID,
		}
		if err := h.DB.CreateScratchpadNote(ctx, note, *req.ScratchpadID); err != nil {
			log.Printf("notes: create on scratchpad %d: %v", *req.ScratchpadID, err)
			http.Error(w, "Failed to create note", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(map[string]interface{}{"note_id": note.NoteID})
		return
	}

	// --- Sentence note (today's path) ---
	if req.SentenceID == "" {
		http.Error(w, "Missing required fields: color, and one of sentence_id / scratchpad_id", http.StatusBadRequest)
		return
	}
	if !requireManuscriptAccessForSentence(w, r, h.DB, h.Config, req.SentenceID) {
		return
	}

	note := &models.Note{
		SentenceID: req.SentenceID,
		UserID:     session.Username,
		Color:      req.Color,
		Body:       req.Body,
		Priority:   priority,
		Flagged:    req.Flagged,
	}

	version := &models.NoteVersion{
		MigrationConfidence: nil,
	}

	if err := h.DB.CreateNote(ctx, note, version); err != nil {
		log.Printf("notes: create on sentence %s: %v", req.SentenceID, err)
		http.Error(w, "Failed to create note", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"note_id": note.NoteID,
		"version": version.Version,
	})
}

// HandleUpdateNote mutates the head row and appends a new version.
func (h *NoteHandlers) HandleUpdateNote(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	noteIDStr := chi.URLParam(r, "note_id")
	noteID, err := strconv.Atoi(noteIDStr)
	if err != nil {
		http.Error(w, "Invalid note_id", http.StatusBadRequest)
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

	existing := h.requireOwnedNote(w, r, noteID, session.Username)
	if existing == nil {
		return
	}

	var req UpdateNoteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	if req.Color != nil {
		existing.Color = *req.Color
	}
	if req.Body != nil {
		existing.Body = req.Body
	}
	if req.Priority != nil {
		existing.Priority = *req.Priority
	}
	if req.Flagged != nil {
		existing.Flagged = *req.Flagged
	}

	// A scratchpad note has no version history (no sentence origin) — update it
	// directly. Sentence notes append a version row (audit + migration lineage).
	if existing.ScratchpadID != nil {
		if err := h.DB.UpdateScratchpadNote(ctx, noteID, req.Color, req.Body, req.Priority, req.Flagged); err != nil {
			log.Printf("notes: update scratchpad note %d: %v", noteID, err)
			http.Error(w, "Failed to update note", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(existing)
		return
	}

	version := &models.NoteVersion{
		MigrationConfidence: nil,
	}

	if err := h.DB.UpdateNote(ctx, noteID, existing, version); err != nil {
		log.Printf("notes: update %d: %v", noteID, err)
		http.Error(w, "Failed to update note", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(existing)
}

func (h *NoteHandlers) HandleReorderNote(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	noteIDStr := chi.URLParam(r, "note_id")
	noteID, err := strconv.Atoi(noteIDStr)
	if err != nil {
		http.Error(w, "Invalid note_id", http.StatusBadRequest)
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

	if h.requireOwnedNote(w, r, noteID, session.Username) == nil {
		return
	}

	var req ReorderNoteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	if err := h.DB.ReorderNote(ctx, noteID, req.SentenceID, req.NewIndex); err != nil {
		log.Printf("notes: reorder %d: %v", noteID, err)
		http.Error(w, "Failed to reorder", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"message": "Note reordered successfully"})
}

func (h *NoteHandlers) HandleDeleteNote(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	noteIDStr := chi.URLParam(r, "note_id")
	noteID, err := strconv.Atoi(noteIDStr)
	if err != nil {
		http.Error(w, "Invalid note_id", http.StatusBadRequest)
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

	if h.requireOwnedNote(w, r, noteID, session.Username) == nil {
		return
	}

	if err := h.DB.SoftDeleteNote(ctx, noteID); err != nil {
		log.Printf("notes: delete %d: %v", noteID, err)
		http.Error(w, "Failed to delete", http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

func (h *NoteHandlers) HandleCompleteNote(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	noteIDStr := chi.URLParam(r, "note_id")
	noteID, err := strconv.Atoi(noteIDStr)
	if err != nil {
		http.Error(w, "Invalid note_id", http.StatusBadRequest)
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

	if h.requireOwnedNote(w, r, noteID, session.Username) == nil {
		return
	}

	if err := h.DB.CompleteNote(ctx, noteID); err != nil {
		log.Printf("notes: complete %d: %v", noteID, err)
		http.Error(w, "Failed to complete", http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

func (h *NoteHandlers) HandleGetTagsForNote(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	noteIDStr := chi.URLParam(r, "note_id")
	noteID, err := strconv.Atoi(noteIDStr)
	if err != nil {
		http.Error(w, "Invalid note_id", http.StatusBadRequest)
		return
	}

	session, err := auth.GetSession(r)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	if h.requireOwnedNote(w, r, noteID, session.Username) == nil {
		return
	}

	tags, err := h.DB.GetTagsForNote(ctx, noteID)
	if err != nil {
		log.Printf("notes: get tags for %d: %v", noteID, err)
		http.Error(w, "Failed to get tags", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"tags": tags})
}

type AddTagRequest struct {
	TagName string `json:"tag_name"`
}

// HandleAddTagToNote creates the tag if needed and links it.
func (h *NoteHandlers) HandleAddTagToNote(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	noteIDStr := chi.URLParam(r, "note_id")
	noteID, err := strconv.Atoi(noteIDStr)
	if err != nil {
		http.Error(w, "Invalid note_id", http.StatusBadRequest)
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

	if h.requireOwnedNote(w, r, noteID, session.Username) == nil {
		return
	}

	// Tags are user-wide (migration 020): scoped to the note's owner, not to a
	// manuscript version. This is what lets scratchpad / free notes (which have
	// no sentence, hence no migration) be tagged at all.
	if err := h.DB.AddTagToNote(ctx, noteID, req.TagName, session.Username); err != nil {
		log.Printf("notes: add tag to %d: %v", noteID, err)
		http.Error(w, "Failed to add tag", http.StatusInternalServerError)
		return
	}

	// Return the post-add tag list so the client can update its in-memory
	// note cache without a follow-up GET. Frontend's tag-add code
	// reads `data.tags`.
	tags, err := h.DB.GetTagsForNote(ctx, noteID)
	if err != nil {
		log.Printf("notes: load tags after add for %d: %v", noteID, err)
		http.Error(w, "Failed to load tags after add", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]interface{}{"tags": tags})
}

func (h *NoteHandlers) HandleRemoveTagFromNote(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	noteIDStr := chi.URLParam(r, "note_id")
	noteID, err := strconv.Atoi(noteIDStr)
	if err != nil {
		http.Error(w, "Invalid note_id", http.StatusBadRequest)
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

	if h.requireOwnedNote(w, r, noteID, session.Username) == nil {
		return
	}

	if err := h.DB.RemoveTagFromNote(ctx, noteID, tagID); err != nil {
		log.Printf("notes: remove tag %d from %d: %v", tagID, noteID, err)
		http.Error(w, "Failed to remove tag", http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}
