package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"path/filepath"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/slackwing/manuscript-studio/internal/auth"
	"github.com/slackwing/manuscript-studio/internal/config"
	"github.com/slackwing/manuscript-studio/internal/database"
)

// Sketches (VARIATIONS_PLAN.md, as clarified): snippet groups + flat sibling
// sketch content rows. Everything here is user-owned (snippet.user_id);
// mutations need CSRF.
type SketchHandlers struct {
	DB           *database.DB
	SessionStore *auth.SessionStore
	Config       *config.Config
}

func (h *SketchHandlers) requireSession(w http.ResponseWriter, r *http.Request) (*auth.Session, bool) {
	session, err := auth.GetSession(r)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return nil, false
	}
	return session, true
}

func (h *SketchHandlers) requireCSRF(w http.ResponseWriter, r *http.Request) bool {
	if !auth.ValidateCSRFToken(r, h.SessionStore, r.Header.Get("X-CSRF-Token")) {
		http.Error(w, "Invalid CSRF token", http.StatusForbidden)
		return false
	}
	return true
}

// writeSketchError maps the database sentinel errors onto HTTP statuses.
func writeSketchError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, database.ErrNotOwner):
		http.Error(w, "Not found", http.StatusNotFound)
	case errors.Is(err, database.ErrSketchFrozen),
		errors.Is(err, database.ErrSketchCanon),
		errors.Is(err, database.ErrOrdinalCap),
		errors.Is(err, database.ErrLinkedElsewhere),
		errors.Is(err, database.ErrAlreadyCanonized),
		errors.Is(err, database.ErrSnippetCanonized),
		errors.Is(err, database.ErrSketchNoLetter):
		http.Error(w, err.Error(), http.StatusConflict)
	default:
		http.Error(w, "Internal error", http.StatusInternalServerError)
	}
}

// optScratchpadID reads an optional scratchpad_id from a request body value
// (0/absent → nil, meaning "no home yet").
func optScratchpadID(v int) *int {
	if v <= 0 {
		return nil
	}
	return &v
}

// HandleCreateSnippet: POST /api/snippets
// {mode:"new", scratchpad_id} → fresh group + sketch A homed in that scratchpad.
// {mode:"sketch", source_sketch_id, scratchpad_id} → next-letter sibling sketch,
// text copied from the source, homed in that scratchpad. (No lineage, no source
// freezing.)
func (h *SketchHandlers) HandleCreateSnippet(w http.ResponseWriter, r *http.Request) {
	session, ok := h.requireSession(w, r)
	if !ok || !h.requireCSRF(w, r) {
		return
	}
	var req struct {
		Mode           string `json:"mode"`
		SourceSketchID int    `json:"source_sketch_id"`
		ScratchpadID   int    `json:"scratchpad_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid body", http.StatusBadRequest)
		return
	}
	var ctxOut *database.SketchContext
	var err error
	switch req.Mode {
	case "new", "":
		ctxOut, err = h.DB.CreateSnippet(r.Context(), session.Username, optScratchpadID(req.ScratchpadID))
	case "sketch", "variation": // "variation" kept for any in-flight old client
		if req.SourceSketchID <= 0 {
			http.Error(w, "source_sketch_id required", http.StatusBadRequest)
			return
		}
		ctxOut, err = h.DB.CreateSketchFrom(r.Context(), session.Username, req.SourceSketchID, optScratchpadID(req.ScratchpadID))
	default:
		http.Error(w, "mode must be new or sketch", http.StatusBadRequest)
		return
	}
	if err != nil {
		writeSketchError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(ctxOut)
}

// HandleListSketches: GET /api/sketches?q=… — the Based-on picker (lettered
// sketches only, most recently updated first).
func (h *SketchHandlers) HandleListSketches(w http.ResponseWriter, r *http.Request) {
	session, ok := h.requireSession(w, r)
	if !ok {
		return
	}
	rows, err := h.DB.ListSketchesForPicker(r.Context(), session.Username, r.URL.Query().Get("q"))
	if err != nil {
		http.Error(w, "Failed to list sketches", http.StatusInternalServerError)
		return
	}
	for i := range rows {
		if rows[i].LinkedManuscriptID != 0 {
			rows[i].LinkedManuscriptName = h.manuscriptDisplayName(r, rows[i].LinkedManuscriptID)
		}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"sketches": rows})
}

// HandleListDeletedSketches: GET /api/sketches/deleted?q= — soft-deleted
// sketches for the Restore… picker, newest deletion first.
func (h *SketchHandlers) HandleListDeletedSketches(w http.ResponseWriter, r *http.Request) {
	session, ok := h.requireSession(w, r)
	if !ok {
		return
	}
	rows, err := h.DB.ListDeletedSketches(r.Context(), session.Username, r.URL.Query().Get("q"))
	if err != nil {
		http.Error(w, "Failed to list deleted sketches", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"sketches": rows})
}

// HandleDeleteSketch: DELETE /api/sketches/{id} — soft-delete (sets deleted_at).
func (h *SketchHandlers) HandleDeleteSketch(w http.ResponseWriter, r *http.Request) {
	session, ok := h.requireSession(w, r)
	if !ok || !h.requireCSRF(w, r) {
		return
	}
	id, ok := h.sketchID(w, r)
	if !ok {
		return
	}
	if err := h.DB.SoftDeleteSketch(r.Context(), session.Username, id); err != nil {
		writeSketchError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// HandleRestoreSketch: POST /api/sketches/{id}/restore — clears deleted_at,
// returns the restored sketch context (the widget payload).
func (h *SketchHandlers) HandleRestoreSketch(w http.ResponseWriter, r *http.Request) {
	session, ok := h.requireSession(w, r)
	if !ok || !h.requireCSRF(w, r) {
		return
	}
	id, ok := h.sketchID(w, r)
	if !ok {
		return
	}
	if err := h.DB.RestoreSketch(r.Context(), session.Username, id); err != nil {
		writeSketchError(w, err)
		return
	}
	h.writeSketchContext(w, r, session.Username, id)
}

func (h *SketchHandlers) sketchID(w http.ResponseWriter, r *http.Request) (int, bool) {
	id, err := strconv.Atoi(chi.URLParam(r, "sketch_id"))
	if err != nil || id <= 0 {
		http.Error(w, "Invalid sketch_id", http.StatusBadRequest)
		return 0, false
	}
	return id, true
}

// writeSketchContext loads + emits a sketch's widget payload, re-resolving the
// linked manuscript name fresh (never trust the stored snippet column, so a
// stale value self-heals and later renames propagate).
func (h *SketchHandlers) writeSketchContext(w http.ResponseWriter, r *http.Request, userID string, id int) {
	out, err := h.DB.GetSketchContext(r.Context(), userID, id)
	if err != nil {
		writeSketchError(w, err)
		return
	}
	if out.Snippet.LinkedManuscriptID != 0 {
		out.Snippet.LinkedManuscriptName = h.manuscriptDisplayName(r, out.Snippet.LinkedManuscriptID)
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(out)
}

// HandleGetSketch: GET /api/sketches/{id} — the widget payload (sketch + group
// + siblings + canon snapshot).
func (h *SketchHandlers) HandleGetSketch(w http.ResponseWriter, r *http.Request) {
	session, ok := h.requireSession(w, r)
	if !ok {
		return
	}
	id, ok := h.sketchID(w, r)
	if !ok {
		return
	}
	h.writeSketchContext(w, r, session.Username, id)
}

// HandleGetSketchHome: GET /api/sketches/{id}/home — the sketch's home
// scratchpad id (for "navigate to source"). {scratchpad_id: N} (0 if none).
func (h *SketchHandlers) HandleGetSketchHome(w http.ResponseWriter, r *http.Request) {
	session, ok := h.requireSession(w, r)
	if !ok {
		return
	}
	id, ok := h.sketchID(w, r)
	if !ok {
		return
	}
	spID, err := h.DB.SketchHomeScratchpad(r.Context(), session.Username, id)
	if err != nil {
		writeSketchError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]int{"scratchpad_id": spID})
}

// HandleUpdateSketch: PUT /api/sketches/{id} {text} — autosave. 409 while frozen.
func (h *SketchHandlers) HandleUpdateSketch(w http.ResponseWriter, r *http.Request) {
	session, ok := h.requireSession(w, r)
	if !ok || !h.requireCSRF(w, r) {
		return
	}
	id, ok := h.sketchID(w, r)
	if !ok {
		return
	}
	var req struct {
		Text string `json:"text"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid body", http.StatusBadRequest)
		return
	}
	if err := h.DB.UpdateSketchText(r.Context(), session.Username, id, req.Text); err != nil {
		writeSketchError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// HandleFreezeSketch: POST /api/sketches/{id}/freeze {frozen}.
func (h *SketchHandlers) HandleFreezeSketch(w http.ResponseWriter, r *http.Request) {
	session, ok := h.requireSession(w, r)
	if !ok || !h.requireCSRF(w, r) {
		return
	}
	id, ok := h.sketchID(w, r)
	if !ok {
		return
	}
	var req struct {
		Frozen bool `json:"frozen"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid body", http.StatusBadRequest)
		return
	}
	if err := h.DB.SetSketchFrozen(r.Context(), session.Username, id, req.Frozen); err != nil {
		writeSketchError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// HandleFreezeAllSketches: POST /api/snippets/{snippet_id}/freeze-all — freeze
// every lettered sketch in a group (canonize's "Freeze all sketches?").
func (h *SketchHandlers) HandleFreezeAllSketches(w http.ResponseWriter, r *http.Request) {
	session, ok := h.requireSession(w, r)
	if !ok || !h.requireCSRF(w, r) {
		return
	}
	snippetID := chi.URLParam(r, "snippet_id")
	if err := h.DB.FreezeAllSketches(r.Context(), session.Username, snippetID); err != nil {
		writeSketchError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// HandleLinkSnippet: PUT /api/snippets/{snippet_id}/link {manuscript_id}.
func (h *SketchHandlers) HandleLinkSnippet(w http.ResponseWriter, r *http.Request) {
	session, ok := h.requireSession(w, r)
	if !ok || !h.requireCSRF(w, r) {
		return
	}
	snippetID := chi.URLParam(r, "snippet_id")
	var req struct {
		ManuscriptID int `json:"manuscript_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid body", http.StatusBadRequest)
		return
	}
	name := ""
	if req.ManuscriptID != 0 {
		if !requireManuscriptAccess(w, r, h.DB, h.Config, req.ManuscriptID) {
			return
		}
		name = h.manuscriptDisplayName(r, req.ManuscriptID)
	}
	if err := h.DB.LinkSnippet(r.Context(), session.Username, snippetID, req.ManuscriptID, name); err != nil {
		writeSketchError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"manuscript_id": req.ManuscriptID, "manuscript_name": name})
}

// HandleCanonizeSketch: POST /api/sketches/{id}/canonize {manuscript_id}.
func (h *SketchHandlers) HandleCanonizeSketch(w http.ResponseWriter, r *http.Request) {
	session, ok := h.requireSession(w, r)
	if !ok || !h.requireCSRF(w, r) {
		return
	}
	id, ok := h.sketchID(w, r)
	if !ok {
		return
	}
	var req struct {
		ManuscriptID int `json:"manuscript_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ManuscriptID <= 0 {
		http.Error(w, "manuscript_id required", http.StatusBadRequest)
		return
	}
	if !requireManuscriptAccess(w, r, h.DB, h.Config, req.ManuscriptID) {
		return
	}
	out, err := h.DB.CanonizeSketch(r.Context(), session.Username, id, req.ManuscriptID,
		h.manuscriptDisplayName(r, req.ManuscriptID))
	if err != nil {
		writeSketchError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(out)
}

func (h *SketchHandlers) manuscriptDisplayName(r *http.Request, manuscriptID int) string {
	return manuscriptDisplayName(r.Context(), h.DB, h.Config, manuscriptID)
}

// manuscriptDisplayName resolves a manuscript's human name the way the whole app
// does: the DB display_name if set, else the config NAME (title-cased), never
// the repo basename (the-wildfire lives in slackwing/darkfeather, so
// filepath.Base would wrongly show "darkfeather.git"). Shared by every handler
// that surfaces a manuscript label (sketch link, note link, landing context).
func manuscriptDisplayName(ctx context.Context, db *database.DB, cfg *config.Config, manuscriptID int) string {
	m, err := db.GetManuscriptByID(ctx, manuscriptID)
	if err != nil || m == nil {
		return ""
	}
	if m.DisplayName != "" {
		return m.DisplayName
	}
	for i := range cfg.Manuscripts {
		mc := &cfg.Manuscripts[i]
		if mc.Repository.CloneURL() == m.RepoPath && mc.Repository.Path == m.FilePath {
			return displayNameFor("", mc.Name)
		}
	}
	return displayNameFor("", filepath.Base(m.FilePath))
}
