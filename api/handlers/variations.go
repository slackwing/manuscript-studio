package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"path/filepath"
	"strconv"

	"github.com/go-chi/chi/v5"
	"strings"

	"github.com/slackwing/manuscript-studio/internal/auth"
	"github.com/slackwing/manuscript-studio/internal/config"
	"github.com/slackwing/manuscript-studio/internal/database"
	"github.com/slackwing/manuscript-studio/internal/sentence"
)

// Variations (VARIATIONS_PLAN.md, as clarified): sketch groups + flat sibling
// variation content rows. Everything here is user-owned (sketch.user_id);
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
		errors.Is(err, database.ErrSketchCanonized),
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

// HandleCreateSketch: POST /api/sketches
// {mode:"new", scratchpad_id} → fresh group + variation A homed in that scratchpad.
// {mode:"variation", source_variation_id, scratchpad_id} → next-letter sibling variation,
// text copied from the source, homed in that scratchpad. (No lineage, no source
// freezing.)
func (h *VariationHandlers) HandleCreateSketch(w http.ResponseWriter, r *http.Request) {
	session, ok := h.requireSession(w, r)
	if !ok || !h.requireCSRF(w, r) {
		return
	}
	var req struct {
		Mode           string `json:"mode"`
		SourceVariationID int    `json:"source_variation_id"`
		SketchID       string `json:"sketch_id"`
		Text           string `json:"text"`
		ManuscriptID   int    `json:"manuscript_id"`
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
		ctxOut, err = h.DB.CreateSketch(r.Context(), session.Username, optScratchpadID(req.ScratchpadID))
	case "variation", "sketch": // "sketch" kept for any in-flight old client
		if req.SourceVariationID <= 0 {
			http.Error(w, "source_variation_id required", http.StatusBadRequest)
			return
		}
		ctxOut, err = h.DB.CreateVariationFrom(r.Context(), session.Username, req.SourceVariationID, optScratchpadID(req.ScratchpadID))
	case "from-selection": // rework existing manuscript text: A=frozen original, B=copy; placed from birth
		if req.ManuscriptID <= 0 || req.ScratchpadID <= 0 || req.Text == "" {
			http.Error(w, "manuscript_id, scratchpad_id and text required", http.StatusBadRequest)
			return
		}
		if !requireManuscriptAccess(w, r, h.DB, h.Config, req.ManuscriptID) {
			return
		}
		ctxOut, err = h.DB.CreatePlacedSketchFromSelection(r.Context(), session.Username, req.ManuscriptID,
			h.manuscriptDisplayName(r, req.ManuscriptID), req.Text, req.ScratchpadID)
	case "text": // next-letter variation seeded with raw text ("sketch from placed text")
		if req.SketchID == "" {
			http.Error(w, "sketch_id required", http.StatusBadRequest)
			return
		}
		ctxOut, err = h.DB.CreateVariationFromText(r.Context(), session.Username, req.SketchID, req.Text, optScratchpadID(req.ScratchpadID))
	default:
		http.Error(w, "mode must be new or variation", http.StatusBadRequest)
		return
	}
	if err != nil {
		writeVariationError(w, err)
		return
	}
	// Live default: a sketch created in a manuscript-linked scratchpad inherits
	// the manuscript, mirroring notes (Phase C). Only NEW sketches; a "variation"
	// sibling reuses an existing sketch, so it already carries the group's link.
	if req.Mode == "new" || req.Mode == "" {
		h.inheritScratchpadManuscript(r, session.Username, req.ScratchpadID, ctxOut)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(ctxOut)
}

// inheritScratchpadManuscript links a just-created sketch to its scratchpad's
// linked manuscript (if any), so it's browsable without hand-linking — the same
// live-default behavior notes have. Best-effort: a failure leaves the sketch
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
	if err := h.DB.LinkSketch(r.Context(), username, ctxOut.Sketch.SketchID, *mid, name); err != nil {
		return
	}
	ctxOut.Sketch.LinkedManuscriptID = *mid
	ctxOut.Sketch.LinkedManuscriptName = name
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
// linked manuscript name fresh (never trust the stored sketch column, so a
// stale value self-heals and later renames propagate).
func (h *VariationHandlers) writeVariationContext(w http.ResponseWriter, r *http.Request, userID string, id int) {
	out, err := h.DB.GetVariationContext(r.Context(), userID, id)
	if err != nil {
		writeVariationError(w, err)
		return
	}
	if out.Sketch.LinkedManuscriptID != 0 {
		out.Sketch.LinkedManuscriptName = h.manuscriptDisplayName(r, out.Sketch.LinkedManuscriptID)
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

// HandleFreezeAllVariations: POST /api/sketches/{sketch_id}/freeze-all — freeze
// every lettered variation in a group (canonize's "Freeze all variations?").
func (h *VariationHandlers) HandleFreezeAllVariations(w http.ResponseWriter, r *http.Request) {
	session, ok := h.requireSession(w, r)
	if !ok || !h.requireCSRF(w, r) {
		return
	}
	sketchID := chi.URLParam(r, "sketch_id")
	if err := h.DB.FreezeAllVariations(r.Context(), session.Username, sketchID); err != nil {
		writeVariationError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// HandleLinkSketch: PUT /api/sketches/{sketch_id}/link {manuscript_id}.
func (h *VariationHandlers) HandleLinkSketch(w http.ResponseWriter, r *http.Request) {
	session, ok := h.requireSession(w, r)
	if !ok || !h.requireCSRF(w, r) {
		return
	}
	sketchID := chi.URLParam(r, "sketch_id")
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
	if err := h.DB.LinkSketch(r.Context(), session.Username, sketchID, req.ManuscriptID, name); err != nil {
		writeVariationError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"manuscript_id": req.ManuscriptID, "manuscript_name": name})
}

// HandlePlacePlan: POST /api/sketches/{sketch_id}/place-plan
// {manuscript_id, text} — the smart per-sentence placement plan. Aligns the
// region's EFFECTIVE sentences (committed + this user's suggestions) against
// the new text with the migration pipeline's marker-aware segmentation, and
// returns one suggestion per changed sentence (unchanged omitted, removed as
// "", additions attached in order). Replaces the old whole-text-on-opener +
// blanket-delete plan that made region reviews unreadable and left delete
// artifacts behind (2026-08-16). Layouts the planner can't handle (inline
// legacy anchors) return a non-ok status and the client falls back.
func (h *VariationHandlers) HandlePlacePlan(w http.ResponseWriter, r *http.Request) {
	session, ok := h.requireSession(w, r)
	if !ok || !h.requireCSRF(w, r) {
		return
	}
	sketchID := chi.URLParam(r, "sketch_id")
	var req struct {
		ManuscriptID int    `json:"manuscript_id"`
		Text         string `json:"text"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ManuscriptID <= 0 || strings.TrimSpace(req.Text) == "" {
		http.Error(w, "manuscript_id and text required", http.StatusBadRequest)
		return
	}
	if !requireManuscriptAccess(w, r, h.DB, h.Config, req.ManuscriptID) {
		return
	}
	ctx := r.Context()
	mig, err := h.DB.GetLatestMigration(ctx, req.ManuscriptID)
	if err != nil || mig == nil {
		http.Error(w, "No migration for manuscript", http.StatusNotFound)
		return
	}
	sentences, err := h.DB.GetSentencesByMigration(ctx, mig.MigrationID)
	if err != nil {
		http.Error(w, "Failed to load sentences", http.StatusInternalServerError)
		return
	}
	sugs, err := h.DB.GetSuggestionsForMigration(ctx, mig.MigrationID, session.Username)
	if err != nil {
		http.Error(w, "Failed to load suggestions", http.StatusInternalServerError)
		return
	}
	sugMap := make(map[string]string, len(sugs))
	for _, s := range sugs {
		sugMap[s.SentenceID] = s.Text
	}
	eff := func(i int) string {
		if t, has := sugMap[sentences[i].SentenceID]; has {
			return t
		}
		return sentences[i].Text
	}
	// Locate the region anchors in effective text. An opener/end may be a
	// WHOLE sentence (block form — anchors on their own lines, the
	// post-push shape) or ride INLINE inside a prose sentence: a
	// mid-paragraph region start ("&sketch#x{} prose…", 2026-08-22 inline
	// starts) or a pre-push composed suggestion carrying prose + "\n&end".
	isAnchor := func(text string, wantEnd bool) bool {
		trimmed := strings.TrimSpace(text)
		cmd, ok := sentence.ParseCommand(trimmed)
		if !ok || cmd.Raw != trimmed || cmd.Slug != sketchID {
			return false
		}
		if wantEnd {
			return cmd.Kind == sentence.CmdEnd
		}
		return cmd.Kind == sentence.CmdAnchor || cmd.Kind == sentence.CmdSnippet
	}
	// joinOf normalizes the whitespace between a region command and its
	// neighboring prose — the join must survive re-placement byte-shape
	// intact (an inline " " start stays inline; an own-line "\n"/"\n\t"
	// stays its own line).
	joinOf := func(ws string) string {
		switch {
		case strings.Contains(ws, "\n\t"):
			return "\n\t"
		case strings.Contains(ws, "\n\n"):
			return "\n\n"
		case strings.Contains(ws, "\n"):
			return "\n"
		default:
			return " "
		}
	}
	// leadingOpener: text begins with this region's opener command followed
	// by more content → (rest-after-opener, opener raw, original join, true).
	leadingOpener := func(text string) (string, string, string, bool) {
		trimmed := strings.TrimSpace(text)
		cmd, ok := sentence.ParseCommand(trimmed)
		if !ok || cmd.Slug != sketchID || (cmd.Kind != sentence.CmdAnchor && cmd.Kind != sentence.CmdSnippet) {
			return "", "", "", false
		}
		if len(trimmed) <= len(cmd.Raw) {
			return "", "", "", false
		}
		after := trimmed[len(cmd.Raw):]
		rest := strings.TrimLeft(after, " \t\n")
		join := joinOf(after[:len(after)-len(rest)])
		if join != " " {
			// Newline-joined composed forms (pre-push from-selection
			// suggestions) keep falling back to the client's replacePlan,
			// which attaches the new text tight after the opener — the
			// shape this endpoint's matcher does not guarantee.
			return "", "", "", false
		}
		return rest, cmd.Raw, join, true
	}
	openIdx, endIdx := -1, -1
	openInline := false
	openCmdRaw, openRest, openJoin := "", "", " "
	for i := range sentences {
		text := eff(i)
		if openIdx < 0 {
			if isAnchor(text, false) {
				openIdx = i
				continue
			}
			if rest, raw, join, ok := leadingOpener(text); ok {
				openIdx, openInline, openCmdRaw, openRest, openJoin = i, true, raw, rest, join
			}
			continue
		}
		if isAnchor(text, true) {
			endIdx = i
			break
		}
	}
	respond := func(status string, plan []sentence.PlaceEdit) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"status": status, "plan": plan})
	}
	if openIdx < 0 || endIdx < 0 {
		respond("unsupported-layout", nil)
		return
	}
	var interior []sentence.PlaceOld
	if openInline && openRest != "" {
		interior = append(interior, sentence.PlaceOld{ID: sentences[openIdx].SentenceID, Text: openRest})
	}
	for i := openIdx + 1; i < endIdx; i++ {
		interior = append(interior, sentence.PlaceOld{ID: sentences[i].SentenceID, Text: eff(i)})
	}
	if len(interior) == 0 {
		respond("unsupported-layout", nil)
		return
	}
	plan := sentence.PlacePlan(interior, req.Text)
	// Re-attach an inline opener to its planned text: the region command is
	// structure, not content — a plan must never eat it.
	if openInline {
		openID := sentences[openIdx].SentenceID
		for k := range plan {
			if plan[k].SentenceID == openID {
				t := strings.TrimSpace(plan[k].Text)
				if t == "" {
					plan[k].Text = openCmdRaw
				} else {
					plan[k].Text = openCmdRaw + openJoin + t
				}
			}
		}
	}
	respond("ok", plan)
}

// HandleSketchHome: GET /api/sketches/{sketch_id}/home — where the GROUP
// lives (the margin sketch-glyph's navigation target).
func (h *VariationHandlers) HandleSketchHome(w http.ResponseWriter, r *http.Request) {
	session, ok := h.requireSession(w, r)
	if !ok {
		return
	}
	sketchID := chi.URLParam(r, "sketch_id")
	spid, ordinal, err := h.DB.SketchHome(r.Context(), session.Username, sketchID)
	if err != nil {
		writeVariationError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]int{"scratchpad_id": spid, "ordinal": ordinal})
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
	if m.Name != "" {
		return displayNameFor("", m.Name)
	}
	return displayNameFor("", filepath.Base(m.FilePath))
}
