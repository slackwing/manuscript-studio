package handlers

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/slackwing/manuscript-studio/internal/auth"
	"github.com/slackwing/manuscript-studio/internal/database"
)

// Note actions (settings page): an audit table of the user's last N note
// actions — points awarded, note deleted (soft), note completed — each with
// an undo: unaward (HARD-deletes the point event), restore, uncomplete.
type NoteActionHandlers struct {
	DB           *database.DB
	SessionStore *auth.SessionStore
}

// HandleList: GET /api/note-actions — the newest 20.
func (h *NoteActionHandlers) HandleList(w http.ResponseWriter, r *http.Request) {
	session, err := auth.GetSession(r)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	actions, err := h.DB.ListNoteActions(r.Context(), session.Username, 20)
	if err != nil {
		log.Printf("note-actions: list: %v", err)
		http.Error(w, "Failed to list note actions", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"actions": actions})
}

// HandleUnaward: DELETE /api/point-events/{event_id} — hard delete; the
// award never happened.
func (h *NoteActionHandlers) HandleUnaward(w http.ResponseWriter, r *http.Request) {
	session, err := auth.GetSession(r)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	if !auth.ValidateCSRFToken(r, h.SessionStore, r.Header.Get("X-CSRF-Token")) {
		http.Error(w, "Invalid CSRF token", http.StatusForbidden)
		return
	}
	id, err := strconv.Atoi(chi.URLParam(r, "event_id"))
	if err != nil {
		http.Error(w, "Invalid event id", http.StatusBadRequest)
		return
	}
	ok, err := h.DB.DeletePointEvent(r.Context(), id, session.Username)
	if err != nil {
		log.Printf("note-actions: unaward %d: %v", id, err)
		http.Error(w, "Failed to unaward points", http.StatusInternalServerError)
		return
	}
	if !ok {
		http.Error(w, "Not found", http.StatusNotFound)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *NoteActionHandlers) noteUndo(w http.ResponseWriter, r *http.Request,
	verb string, undo func(username string, noteID int) (bool, error)) {
	session, err := auth.GetSession(r)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	if !auth.ValidateCSRFToken(r, h.SessionStore, r.Header.Get("X-CSRF-Token")) {
		http.Error(w, "Invalid CSRF token", http.StatusForbidden)
		return
	}
	id, err := strconv.Atoi(chi.URLParam(r, "note_id"))
	if err != nil {
		http.Error(w, "Invalid note id", http.StatusBadRequest)
		return
	}
	ok, err := undo(session.Username, id)
	if err != nil {
		log.Printf("note-actions: %s %d: %v", verb, id, err)
		http.Error(w, "Failed to "+verb+" note", http.StatusInternalServerError)
		return
	}
	if !ok {
		http.Error(w, "Not found", http.StatusNotFound)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// HandleRestore: POST /api/notes/{note_id}/restore — undo a soft delete.
func (h *NoteActionHandlers) HandleRestore(w http.ResponseWriter, r *http.Request) {
	h.noteUndo(w, r, "restore", func(username string, noteID int) (bool, error) {
		return h.DB.RestoreNote(r.Context(), noteID, username)
	})
}

// HandleUncomplete: POST /api/notes/{note_id}/uncomplete — undo completion.
func (h *NoteActionHandlers) HandleUncomplete(w http.ResponseWriter, r *http.Request) {
	h.noteUndo(w, r, "uncomplete", func(username string, noteID int) (bool, error) {
		return h.DB.UncompleteNote(r.Context(), noteID, username)
	})
}
