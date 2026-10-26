package handlers

// Admin endpoints for personal API tokens (README "API tokens"), gated by
// the system token like the rest of /api/admin:
//
//	POST   /api/admin/api-tokens            {username, name, scopes, expires_at?}
//	GET    /api/admin/api-tokens?username=  (no secrets)
//	DELETE /api/admin/api-tokens/{token_id} (revoke)

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/slackwing/manuscript-studio/internal/auth"
)

type mintedAPIToken struct {
	auth.APIToken
	Token string `json:"token"` // the secret — in this response only
}

// HandleCreateAPIToken mints a token. The response carries the token
// itself; nothing else ever will.
func (h *AdminHandlers) HandleCreateAPIToken(w http.ResponseWriter, r *http.Request) {
	if !h.checkSystemToken(r) {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}
	var req struct {
		Username  string     `json:"username"`
		Name      string     `json:"name"`
		Scopes    []string   `json:"scopes"`
		ExpiresAt *time.Time `json:"expires_at"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Username == "" || req.Name == "" {
		http.Error(w, "username and name are required", http.StatusBadRequest)
		return
	}
	if len(req.Name) > 100 {
		http.Error(w, "name is at most 100 characters", http.StatusBadRequest)
		return
	}
	if len(req.Scopes) == 0 {
		http.Error(w, "scopes are required", http.StatusBadRequest)
		return
	}
	for _, s := range req.Scopes {
		if !auth.KnownScopes[s] {
			http.Error(w, "unknown scope "+s, http.StatusBadRequest)
			return
		}
	}
	if req.ExpiresAt != nil && !req.ExpiresAt.After(time.Now()) {
		http.Error(w, "expires_at must be in the future", http.StatusBadRequest)
		return
	}

	t, token, err := h.APITokens.Create(r.Context(), req.Username, req.Name, req.Scopes, req.ExpiresAt)
	if errors.Is(err, auth.ErrUnknownUser) {
		http.Error(w, "User not found", http.StatusNotFound)
		return
	}
	if err != nil {
		log.Printf("api-tokens: create for %s: %v", req.Username, err)
		http.Error(w, "Failed to create token", http.StatusInternalServerError)
		return
	}
	log.Printf("api-tokens: minted %s (%q, %v) for %s", t.Prefix, t.Name, t.Scopes, t.Username)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(mintedAPIToken{APIToken: *t, Token: token})
}

// HandleListAPITokens lists tokens (a user's, with ?username=), without
// their secrets.
func (h *AdminHandlers) HandleListAPITokens(w http.ResponseWriter, r *http.Request) {
	if !h.checkSystemToken(r) {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}
	tokens, err := h.APITokens.List(r.Context(), r.URL.Query().Get("username"))
	if err != nil {
		log.Printf("api-tokens: list: %v", err)
		http.Error(w, "Failed to list tokens", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"tokens": tokens})
}

// HandleRevokeAPIToken stops a token working (the row stays, for the audit).
func (h *AdminHandlers) HandleRevokeAPIToken(w http.ResponseWriter, r *http.Request) {
	if !h.checkSystemToken(r) {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}
	id, err := strconv.Atoi(chi.URLParam(r, "token_id"))
	if err != nil {
		http.Error(w, "Invalid token_id", http.StatusBadRequest)
		return
	}
	ok, err := h.APITokens.Revoke(r.Context(), id)
	if err != nil {
		log.Printf("api-tokens: revoke %d: %v", id, err)
		http.Error(w, "Failed to revoke token", http.StatusInternalServerError)
		return
	}
	if !ok {
		http.Error(w, "No such live token", http.StatusNotFound)
		return
	}
	log.Printf("api-tokens: revoked token %d", id)
	w.WriteHeader(http.StatusNoContent)
}
