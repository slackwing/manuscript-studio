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

// Variations (VARIATIONS_PLAN.md, as clarified): snippet groups + flat sibling
// variation content rows. Everything here is user-owned (snippet.user_id);
// mutations need CSRF.
type VariationHandlers struct {
	DB           *database.DB
	SessionStore *auth.SessionStore
	Config       *config.Config
}

func (h *VariationHandlers) requireSession(w http.ResponseWriter, r *http.Request) (*auth.Session, bool) {
	session, err := auth.GetSession(r)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return nil, false
	}
	return session, true
}

func (h *VariationHandlers) requireCSRF(w http.ResponseWriter, r *http.Request) bool {
	if !auth.ValidateCSRFToken(r, h.SessionStore, r.Header.Get("X-CSRF-Token")) {
		http.Error(w, "Invalid CSRF token", http.StatusForbidden)
		return false
	}
	return true
}

// writeVariationError maps the database sentinel errors onto HTTP statuses.
func writeVariationError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, database.ErrNotOwner):
		http.Error(w, "Not found", http.StatusNotFound)
	case errors.Is(err, database.ErrVariationFrozen),
		errors.Is(err, database.ErrVariationSuperseded),
		errors.Is(err, database.ErrVariationCanon),
		errors.Is(err, database.ErrOrdinalCap),
		errors.Is(err, database.ErrLinkedElsewhere),
		errors.Is(err, database.ErrAlreadyCanonized),
		errors.Is(err, database.ErrSnippetCanonized),
		errors.Is(err, database.ErrVariationNoLetter):
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
// {mode:"new", scratchpad_id} → fresh group + variation A homed in that scratchpad.
// {mode:"variation", source_variation_id, scratchpad_id} → next-letter sibling variation,
// text copied from the source, homed in that scratchpad. (No lineage, no source
// freezing.)
func (h *VariationHandlers) HandleCreateSnippet(w http.ResponseWriter, r *http.Request) {
	session, ok := h.requireSession(w, r)
	if !ok || !h.requireCSRF(w, r) {
		return
	}
	var req struct {
		Mode           string `json:"mode"`
		SourceVariationID int    `json:"source_variation_id"`
		ScratchpadID   int    `json:"scratchpad_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid body", http.StatusBadRequest)
		return
	}
	var ctxOut *database.VariationContext
	var err error
	switch req.Mode {
	case "new", "":
		ctxOut, err = h.DB.CreateSnippet(r.Context(), session.Username, optScratchpadID(req.ScratchpadID))
	case "variation", "sketch": // "sketch" kept for any in-flight old client
		if req.SourceVariationID <= 0 {
			http.Error(w, "source_variation_id required", http.StatusBadRequest)
			return
		}
		ctxOut, err = h.DB.CreateVariationFrom(r.Context(), session.Username, req.SourceVariationID, optScratchpadID(req.ScratchpadID))
	default:
		http.Error(w, "mode must be new or variation", http.StatusBadRequest)
		return
	}
	if err != nil {
		writeVariationError(w, err)
		return
	}
	// Live default: a snippet created in a manuscript-linked scratchpad inherits
	// the manuscript, mirroring notes (Phase C). Only NEW snippets; a "variation"
	// sibling reuses an existing snippet, so it already carries the group's link.
	if req.Mode == "new" || req.Mode == "" {
		h.inheritScratchpadManuscript(r, session.Username, req.ScratchpadID, ctxOut)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(ctxOut)
}

// inheritScratchpadManuscript links a just-created snippet to its scratchpad's
// linked manuscript (if any), so it's browsable without hand-linking — the same
// live-default behavior notes have. Best-effort: a failure leaves the snippet
// unlinked rather than failing the create. Updates ctxOut so the response (and
// thus the just-mounted widget) shows the link immediately.
func (h *VariationHandlers) inheritScratchpadManuscript(r *http.Request, username string, scratchpadID int, ctxOut *database.VariationContext) {
	if scratchpadID <= 0 || ctxOut == nil {
		return
	}
	mid, err := h.DB.GetScratchpadLinkedManuscript(r.Context(), scratchpadID)
	if err != nil || mid == nil {
		return
	}
	name := manuscriptDisplayName(r.Context(), h.DB, h.Config, *mid)
	if err := h.DB.LinkSnippet(r.Context(), username, ctxOut.Snippet.SnippetID, *mid, name); err != nil {
		return
	}
	ctxOut.Snippet.LinkedManuscriptID = *mid
	ctxOut.Snippet.LinkedManuscriptName = name
}

// HandleListVariations: GET /api/variations?q=… — the Based-on picker (lettered
// variations only, most recently updated first).
func (h *VariationHandlers) HandleListVariations(w http.ResponseWriter, r *http.Request) {
	session, ok := h.requireSession(w, r)
	if !ok {
		return
	}
	rows, err := h.DB.ListVariationsForPicker(r.Context(), session.Username, r.URL.Query().Get("q"))
	if err != nil {
		http.Error(w, "Failed to list variations", http.StatusInternalServerError)
		return
	}
	for i := range rows {
		if rows[i].LinkedManuscriptID != 0 {
			rows[i].LinkedManuscriptName = h.manuscriptDisplayName(r, rows[i].LinkedManuscriptID)
		}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"variations": rows})
}

// HandleListDeletedVariations: GET /api/variations/deleted?q= — soft-deleted
// variations for the Restore… picker, newest deletion first.
func (h *VariationHandlers) HandleListDeletedVariations(w http.ResponseWriter, r *http.Request) {
	session, ok := h.requireSession(w, r)
	if !ok {
		return
	}
	rows, err := h.DB.ListDeletedVariations(r.Context(), session.Username, r.URL.Query().Get("q"))
	if err != nil {
		http.Error(w, "Failed to list deleted variations", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"variations": rows})
}

// HandleDeleteVariation: DELETE /api/variations/{id} — soft-delete (sets deleted_at).
func (h *VariationHandlers) HandleDeleteVariation(w http.ResponseWriter, r *http.Request) {
	session, ok := h.requireSession(w, r)
	if !ok || !h.requireCSRF(w, r) {
		return
	}
	id, ok := h.variationID(w, r)
	if !ok {
		return
	}
	if err := h.DB.SoftDeleteVariation(r.Context(), session.Username, id); err != nil {
		writeVariationError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// HandleRestoreVariation: POST /api/variations/{id}/restore — clears deleted_at,
// returns the restored variation context (the widget payload).
func (h *VariationHandlers) HandleRestoreVariation(w http.ResponseWriter, r *http.Request) {
	session, ok := h.requireSession(w, r)
	if !ok || !h.requireCSRF(w, r) {
		return
	}
	id, ok := h.variationID(w, r)
	if !ok {
		return
	}
	if err := h.DB.RestoreVariation(r.Context(), session.Username, id); err != nil {
		writeVariationError(w, err)
		return
	}
	h.writeVariationContext(w, r, session.Username, id)
}

func (h *VariationHandlers) variationID(w http.ResponseWriter, r *http.Request) (int, bool) {
	id, err := strconv.Atoi(chi.URLParam(r, "variation_id"))
	if err != nil || id <= 0 {
		http.Error(w, "Invalid variation_id", http.StatusBadRequest)
		return 0, false
	}
	return id, true
}

// writeVariationContext loads + emits a variation's widget payload, re-resolving the
// linked manuscript name fresh (never trust the stored snippet column, so a
// stale value self-heals and later renames propagate).
func (h *VariationHandlers) writeVariationContext(w http.ResponseWriter, r *http.Request, userID string, id int) {
	out, err := h.DB.GetVariationContext(r.Context(), userID, id)
	if err != nil {
		writeVariationError(w, err)
		return
	}
	if out.Snippet.LinkedManuscriptID != 0 {
		out.Snippet.LinkedManuscriptName = h.manuscriptDisplayName(r, out.Snippet.LinkedManuscriptID)
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(out)
}

// HandleGetVariation: GET /api/variations/{id} — the widget payload (variation + group
// + siblings + canon snapshot).
func (h *VariationHandlers) HandleGetVariation(w http.ResponseWriter, r *http.Request) {
	session, ok := h.requireSession(w, r)
	if !ok {
		return
	}
	id, ok := h.variationID(w, r)
	if !ok {
		return
	}
	h.writeVariationContext(w, r, session.Username, id)
}

// HandleGetVariationHome: GET /api/variations/{id}/home — the variation's home
// scratchpad id (for "navigate to source"). {scratchpad_id: N} (0 if none).
func (h *VariationHandlers) HandleGetVariationHome(w http.ResponseWriter, r *http.Request) {
	session, ok := h.requireSession(w, r)
	if !ok {
		return
	}
	id, ok := h.variationID(w, r)
	if !ok {
		return
	}
	spID, err := h.DB.VariationHomeScratchpad(r.Context(), session.Username, id)
	if err != nil {
		writeVariationError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]int{"scratchpad_id": spID})
}

// HandleUpdateVariation: PUT /api/variations/{id} {text} — autosave. 409 while frozen.
func (h *VariationHandlers) HandleUpdateVariation(w http.ResponseWriter, r *http.Request) {
	session, ok := h.requireSession(w, r)
	if !ok || !h.requireCSRF(w, r) {
		return
	}
	id, ok := h.variationID(w, r)
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
	if err := h.DB.UpdateVariationText(r.Context(), session.Username, id, req.Text); err != nil {
		writeVariationError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// HandleSetVariationState: PUT /api/variations/{id}/state {state}. One lifecycle
// column (draft | frozen | superseded), so frozen and superseded are mutually
// exclusive — setting either cancels the other.
func (h *VariationHandlers) HandleSetVariationState(w http.ResponseWriter, r *http.Request) {
	session, ok := h.requireSession(w, r)
	if !ok || !h.requireCSRF(w, r) {
		return
	}
	id, ok := h.variationID(w, r)
	if !ok {
		return
	}
	var req struct {
		State string `json:"state"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid body", http.StatusBadRequest)
		return
	}
	if req.State != "draft" && req.State != "frozen" && req.State != "superseded" {
		http.Error(w, "state must be draft, frozen or superseded", http.StatusBadRequest)
		return
	}
	if err := h.DB.SetVariationState(r.Context(), session.Username, id, req.State); err != nil {
		writeVariationError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// HandleFreezeAllVariations: POST /api/snippets/{snippet_id}/freeze-all — freeze
// every lettered variation in a group (canonize's "Freeze all variations?").
func (h *VariationHandlers) HandleFreezeAllVariations(w http.ResponseWriter, r *http.Request) {
	session, ok := h.requireSession(w, r)
	if !ok || !h.requireCSRF(w, r) {
		return
	}
	snippetID := chi.URLParam(r, "snippet_id")
	if err := h.DB.FreezeAllVariations(r.Context(), session.Username, snippetID); err != nil {
		writeVariationError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// HandleLinkSnippet: PUT /api/snippets/{snippet_id}/link {manuscript_id}.
func (h *VariationHandlers) HandleLinkSnippet(w http.ResponseWriter, r *http.Request) {
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
		writeVariationError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"manuscript_id": req.ManuscriptID, "manuscript_name": name})
}

// HandleCanonizeVariation: POST /api/variations/{id}/canonize {manuscript_id}.
func (h *VariationHandlers) HandleCanonizeVariation(w http.ResponseWriter, r *http.Request) {
	session, ok := h.requireSession(w, r)
	if !ok || !h.requireCSRF(w, r) {
		return
	}
	id, ok := h.variationID(w, r)
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
	out, err := h.DB.CanonizeVariation(r.Context(), session.Username, id, req.ManuscriptID,
		h.manuscriptDisplayName(r, req.ManuscriptID))
	if err != nil {
		writeVariationError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(out)
}

func (h *VariationHandlers) manuscriptDisplayName(r *http.Request, manuscriptID int) string {
	return manuscriptDisplayName(r.Context(), h.DB, h.Config, manuscriptID)
}

// manuscriptDisplayName resolves a manuscript's human name the way the whole app
// does: the DB display_name if set, else the config NAME (title-cased), never
// the repo basename (the-wildfire lives in slackwing/darkfeather, so
// filepath.Base would wrongly show "darkfeather.git"). Shared by every handler
// that surfaces a manuscript label (variation link, note link, landing context).
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
