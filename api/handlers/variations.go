package handlers

import (
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

// Variations (VARIATIONS_PLAN.md): snippet groups + variation content rows.
// Everything here is user-owned (snippet.user_id); mutations need CSRF.
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

// HandleCreateSnippet: POST /api/snippets
// {mode:"new"} → fresh group + variation A.
// {mode:"variation", source_variation_id, freeze_source} → next letter,
// text copied from the source, parent recorded.
func (h *VariationHandlers) HandleCreateSnippet(w http.ResponseWriter, r *http.Request) {
	session, ok := h.requireSession(w, r)
	if !ok || !h.requireCSRF(w, r) {
		return
	}
	var req struct {
		Mode              string `json:"mode"`
		SourceVariationID int    `json:"source_variation_id"`
		FreezeSource      bool   `json:"freeze_source"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid body", http.StatusBadRequest)
		return
	}
	var ctxOut *database.VariationContext
	var err error
	switch req.Mode {
	case "new", "":
		ctxOut, err = h.DB.CreateSnippet(r.Context(), session.Username)
	case "variation":
		if req.SourceVariationID <= 0 {
			http.Error(w, "source_variation_id required", http.StatusBadRequest)
			return
		}
		ctxOut, err = h.DB.CreateVariationFrom(r.Context(), session.Username, req.SourceVariationID, req.FreezeSource)
	default:
		http.Error(w, "mode must be new or variation", http.StatusBadRequest)
		return
	}
	if err != nil {
		writeVariationError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(ctxOut)
}

// HandleListVariations: GET /api/variations?q=… — the Based-on picker
// (lettered variations only, most recently updated first).
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
	// Re-resolve linked names fresh (see manuscriptDisplayName) so stale stored
	// values don't leak through the picker either.
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

// HandleDeleteVariation: DELETE /api/variations/{id} — soft-delete (sets
// deleted_at). The widget is removed client-side; Restore… brings it back.
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

// HandleRestoreVariation: POST /api/variations/{id}/restore — clears
// deleted_at. Returns the restored variation context (the widget payload).
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
	out, err := h.DB.GetVariationContext(r.Context(), session.Username, id)
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

func (h *VariationHandlers) variationID(w http.ResponseWriter, r *http.Request) (int, bool) {
	id, err := strconv.Atoi(chi.URLParam(r, "variation_id"))
	if err != nil || id <= 0 {
		http.Error(w, "Invalid variation_id", http.StatusBadRequest)
		return 0, false
	}
	return id, true
}

// HandleGetVariation: GET /api/variations/{id} — the widget payload
// (variation + group + parent/children refs + canon snapshot).
func (h *VariationHandlers) HandleGetVariation(w http.ResponseWriter, r *http.Request) {
	session, ok := h.requireSession(w, r)
	if !ok {
		return
	}
	id, ok := h.variationID(w, r)
	if !ok {
		return
	}
	out, err := h.DB.GetVariationContext(r.Context(), session.Username, id)
	if err != nil {
		writeVariationError(w, err)
		return
	}
	// Re-resolve the linked manuscript name fresh (never trust the stored
	// snippet column): a stale value — e.g. an old "darkfeather.git" from the
	// repo-basename bug — self-heals, and later renames propagate.
	if out.Snippet.LinkedManuscriptID != 0 {
		out.Snippet.LinkedManuscriptName = h.manuscriptDisplayName(r, out.Snippet.LinkedManuscriptID)
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(out)
}

// HandleUpdateVariation: PUT /api/variations/{id} {text} — autosave.
// 409 while frozen (the widget shows the snowflake as the reason).
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

// HandleFreezeVariation: POST /api/variations/{id}/freeze {frozen}.
func (h *VariationHandlers) HandleFreezeVariation(w http.ResponseWriter, r *http.Request) {
	session, ok := h.requireSession(w, r)
	if !ok || !h.requireCSRF(w, r) {
		return
	}
	id, ok := h.variationID(w, r)
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
	if err := h.DB.SetVariationFrozen(r.Context(), session.Username, id, req.Frozen); err != nil {
		writeVariationError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// HandleLinkSnippet: PUT /api/snippets/{snippet_id}/link {manuscript_id}.
// 0 unlinks. The display name resolves server-side. Permanent once canon.
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

// HandleCanonizeVariation: POST /api/variations/{id}/canonize
// {manuscript_id} — step 2 of canonize; the suggestion wrapping the text in
// &snippet#<snippet-id>{label} … &end#<snippet-id> is step 1, client-side
// via the ordinary suggestion PUT (stale-migration guard and all).
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
	m, err := h.DB.GetManuscriptByID(r.Context(), manuscriptID)
	if err != nil || m == nil {
		return ""
	}
	if m.DisplayName != "" {
		return m.DisplayName
	}
	// Fall back to the manuscript's config NAME (title-cased), NOT the repo
	// basename — a manuscript may live in a repo whose name differs entirely
	// (e.g. the-wildfire lives in slackwing/darkfeather, so filepath.Base would
	// wrongly show "darkfeather.git"). Match the DB row back to its config
	// entry by repo_path + file_path.
	for i := range h.Config.Manuscripts {
		mc := &h.Config.Manuscripts[i]
		if mc.Repository.CloneURL() == m.RepoPath && mc.Repository.Path == m.FilePath {
			return displayNameFor("", mc.Name)
		}
	}
	// No config match — use the manuscript's own name if we can derive one,
	// else the file's base name (never the repo's).
	return displayNameFor("", filepath.Base(m.FilePath))
}
