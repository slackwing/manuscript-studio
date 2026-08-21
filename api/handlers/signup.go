package handlers

// Invite-only sign-up (2026-08-21): POST /api/signup with a live invite
// code creates the account and logs it straight in. Email is stored,
// nothing sends mail yet. Codes are minted by the operator via
// POST /api/admin/invites (system token) or debug/mint_invite.sh.

import (
	"crypto/subtle"
	"encoding/json"
	"log"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/slackwing/manuscript-studio/internal/auth"
	"github.com/slackwing/manuscript-studio/internal/config"
	"github.com/slackwing/manuscript-studio/internal/database"
)

type SignupHandlers struct {
	DB           *database.DB
	SessionStore *auth.SessionStore
	Config       *config.Config
	IsProduction bool
}

var (
	usernamePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{1,31}$`)
	emailPattern    = regexp.MustCompile(`^[^\s@]+@[^\s@]+\.[^\s@]+$`)
)

func (h *SignupHandlers) HandleSignup(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var req struct {
		Username   string `json:"username"`
		Password   string `json:"password"`
		Email      string `json:"email"`
		InviteCode string `json:"invite_code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}
	req.Username = strings.ToLower(strings.TrimSpace(req.Username))
	req.Email = strings.TrimSpace(req.Email)
	req.InviteCode = strings.TrimSpace(req.InviteCode)

	switch {
	case !usernamePattern.MatchString(req.Username):
		http.Error(w, "Username: 2-32 chars, lowercase letters/digits/-/_", http.StatusBadRequest)
		return
	case !emailPattern.MatchString(req.Email):
		http.Error(w, "A valid email is required", http.StatusBadRequest)
		return
	case req.InviteCode == "":
		http.Error(w, "An invite code is required", http.StatusBadRequest)
		return
	}
	if err := auth.ValidatePassword(req.Password); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	hash, err := auth.HashPassword(req.Password)
	if err != nil {
		http.Error(w, "Failed to create account", http.StatusInternalServerError)
		return
	}
	err = h.DB.CreateUserWithInvite(ctx, req.Username, hash, req.Email, req.InviteCode)
	switch {
	case err == database.ErrUsernameTaken:
		http.Error(w, "Username is taken", http.StatusConflict)
		return
	case err == database.ErrInviteInvalid:
		http.Error(w, "Invalid invite code", http.StatusForbidden)
		return
	case err != nil:
		log.Printf("signup %q: %v", req.Username, err)
		http.Error(w, "Failed to create account", http.StatusInternalServerError)
		return
	}

	// Straight into a session — same cookie shape as login.
	token, err := h.SessionStore.Create(req.Username)
	if err != nil {
		http.Error(w, "Account created — please log in", http.StatusCreated)
		return
	}
	session, _ := h.SessionStore.Get(token)
	http.SetCookie(w, &http.Cookie{
		Name:     "session_token",
		Value:    token,
		Path:     "/",
		MaxAge:   86400,
		HttpOnly: true,
		Secure:   h.IsProduction,
		SameSite: http.SameSiteStrictMode,
	})
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{
		"username":   req.Username,
		"csrf_token": session.CSRFToken,
	})
}

// HandleMintInvite (system token): {"days":365?, "note":"ronnie"?} → a
// fresh single-use code.
func (h *SignupHandlers) HandleMintInvite(w http.ResponseWriter, r *http.Request) {
	if !h.checkSystemToken(r) {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}
	var req struct {
		Days int    `json:"days"`
		Note string `json:"note"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	if req.Days <= 0 {
		req.Days = 365
	}
	code, expires, err := h.DB.MintInvite(r.Context(), time.Duration(req.Days)*24*time.Hour, req.Note)
	if err != nil {
		log.Printf("mint invite: %v", err)
		http.Error(w, "Failed to mint invite", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{
		"code":       code,
		"expires_at": expires.Format(time.RFC3339),
	})
}

// HandleSearchUsers (authed): ?q=<prefix> → usernames, for the
// access-management autocomplete.
func (h *SignupHandlers) HandleSearchUsers(w http.ResponseWriter, r *http.Request) {
	if _, err := auth.GetSession(r); err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"users":[]}`))
		return
	}
	users, err := h.DB.SearchUsers(r.Context(), q, 8)
	if err != nil {
		http.Error(w, "Search failed", http.StatusInternalServerError)
		return
	}
	if users == nil {
		users = []string{}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string][]string{"users": users})
}

func (h *SignupHandlers) checkSystemToken(r *http.Request) bool {
	if h.Config.Auth.SystemToken == "" {
		return false
	}
	expected := "Bearer " + h.Config.Auth.SystemToken
	return subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte(expected)) == 1
}
