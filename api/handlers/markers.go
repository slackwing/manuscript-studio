package handlers

import (
	"encoding/json"
	"log"
	"net/http"
	"regexp"

	"github.com/go-chi/chi/v5"
	"github.com/slackwing/manuscript-studio/internal/auth"
	"github.com/slackwing/manuscript-studio/internal/database"
)

// Marker symbols (settings "Markers" section): per-user slug → shape map
// so &marker#weird can wear a triangle instead of the default diamond.
// The shape catalog is the frontend's (web/js/marker-symbols.js); keys
// are validated here so the renderer never sees an unknown shape.
type MarkerHandlers struct {
	DB           *database.DB
	SessionStore *auth.SessionStore
}

var markerSlugRe = regexp.MustCompile(`^[a-z0-9-]{1,64}$`)

// markerSymbols mirrors web/js/marker-symbols.js SHAPES — keep in lockstep.
var markerSymbols = map[string]bool{
	"diamond": true, "triangle-down": true, "triangle-up": true,
	"circle": true, "square": true,
	"spade": true, "heart": true, "club": true,
}

// HandleList: GET /api/marker-symbols → {"symbols": {slug: shape},
// "display": bool}. display defaults OFF — a new user's markers stay
// invisible until they opt in (settings "Markers" toggle).
func (h *MarkerHandlers) HandleList(w http.ResponseWriter, r *http.Request) {
	session, err := auth.GetSession(r)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	symbols, err := h.DB.ListMarkerSymbols(r.Context(), session.Username)
	if err != nil {
		log.Printf("markers: list: %v", err)
		http.Error(w, "Failed to list marker symbols", http.StatusInternalServerError)
		return
	}
	display, err := h.DB.GetUserPref(r.Context(), session.Username, "marker_display")
	if err != nil {
		log.Printf("markers: display pref: %v", err)
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"symbols": symbols, "display": display == "on",
	})
}

// HandleSetDisplay: PUT /api/marker-display {"on": bool}.
func (h *MarkerHandlers) HandleSetDisplay(w http.ResponseWriter, r *http.Request) {
	session, err := auth.GetSession(r)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	var body struct {
		On bool `json:"on"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "Bad body", http.StatusBadRequest)
		return
	}
	val := "" // unset = off (the default)
	if body.On {
		val = "on"
	}
	if err := h.DB.SetUserPref(r.Context(), session.Username, "marker_display", val); err != nil {
		log.Printf("markers: set display: %v", err)
		http.Error(w, "Failed to save", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// HandleSet: PUT /api/marker-symbols/{slug} {"symbol": "triangle-down"}.
func (h *MarkerHandlers) HandleSet(w http.ResponseWriter, r *http.Request) {
	session, err := auth.GetSession(r)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	slug := chi.URLParam(r, "slug")
	if !markerSlugRe.MatchString(slug) {
		http.Error(w, "Bad slug", http.StatusBadRequest)
		return
	}
	var body struct {
		Symbol string `json:"symbol"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || !markerSymbols[body.Symbol] {
		http.Error(w, "Bad symbol", http.StatusBadRequest)
		return
	}
	if err := h.DB.UpsertMarkerSymbol(r.Context(), session.Username, slug, body.Symbol); err != nil {
		log.Printf("markers: set %s: %v", slug, err)
		http.Error(w, "Failed to save marker symbol", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// HandleDelete: DELETE /api/marker-symbols/{slug} — back to the diamond.
func (h *MarkerHandlers) HandleDelete(w http.ResponseWriter, r *http.Request) {
	session, err := auth.GetSession(r)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	slug := chi.URLParam(r, "slug")
	if !markerSlugRe.MatchString(slug) {
		http.Error(w, "Bad slug", http.StatusBadRequest)
		return
	}
	if _, err := h.DB.DeleteMarkerSymbol(r.Context(), session.Username, slug); err != nil {
		log.Printf("markers: delete %s: %v", slug, err)
		http.Error(w, "Failed to delete marker symbol", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
