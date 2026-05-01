package handlers

import (
	"context"
	"encoding/json"
	"log"
	"net/http"

	"github.com/slackwing/manuscript-studio/internal/auth"
	"github.com/slackwing/manuscript-studio/internal/config"
	"github.com/slackwing/manuscript-studio/internal/database"
)

type AuthHandlers struct {
	DB            *database.DB
	SessionStore  *auth.SessionStore
	IsProduction  bool
	Config        *config.Config
}

type LoginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

// ManuscriptOption pairs the friendly name with its DB-keyed id so the
// frontend can both display and route to a manuscript.
type ManuscriptOption struct {
	Name         string `json:"name"`
	ManuscriptID int    `json:"manuscript_id"`
}

type LoginResponse struct {
	Username           string             `json:"username"`
	CSRFToken          string             `json:"csrf_token"`
	LastManuscriptName string             `json:"last_manuscript_name,omitempty"`
	Manuscripts        []ManuscriptOption `json:"manuscripts"`
}

// Real bcrypt hash at production cost factor. Used so VerifyPassword does
// equal work whether or not the user exists, defeating timing-based enumeration.
const dummyPasswordHash = "$2a$10$natLQrpv.hhOkSBcdpI/nOAIicjCeF4/0bGMQywZsEOiNgiSgDnP."

// HandleLogin authenticates a user and creates a session. Timing-safe: bcrypt
// always runs (real hash or dummy) before any branching, and every failure
// mode returns the same status and body.
func (h *AuthHandlers) HandleLogin(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	var req LoginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	if req.Username == "" || req.Password == "" {
		http.Error(w, "Missing required fields", http.StatusBadRequest)
		return
	}

	user, err := h.DB.GetUserByUsername(ctx, req.Username)
	if err != nil {
		log.Printf("Database error during login: %v", err)
		http.Error(w, "Invalid credentials", http.StatusUnauthorized)
		return
	}

	hashToCompare := dummyPasswordHash
	if user != nil {
		hashToCompare = user.PasswordHash
	}
	passwordValid := auth.VerifyPassword(req.Password, hashToCompare)
	if user == nil || !passwordValid {
		http.Error(w, "Invalid credentials", http.StatusUnauthorized)
		return
	}

	token, err := h.SessionStore.Create(req.Username)
	if err != nil {
		http.Error(w, "Failed to create session", http.StatusInternalServerError)
		return
	}

	session, _ := h.SessionStore.Get(token)

	http.SetCookie(w, &http.Cookie{
		Name:     "session_token",
		Value:    token,
		Path:     "/",
		MaxAge:   86400, // 24h
		HttpOnly: true,
		Secure:   h.IsProduction,
		SameSite: http.SameSiteStrictMode,
	})

	// Pre-compute the picker payload so the client can land on the right
	// manuscript without a follow-up round trip.
	options, err := h.userManuscriptOptions(ctx, user.Username)
	if err != nil {
		log.Printf("Error loading user manuscripts: %v", err)
		options = nil
	}
	last, err := h.DB.GetLastManuscriptName(ctx, user.Username)
	if err != nil {
		log.Printf("Error loading last manuscript: %v", err)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(LoginResponse{
		Username:           user.Username,
		CSRFToken:          session.CSRFToken,
		LastManuscriptName: last,
		Manuscripts:        options,
	})
}

// userManuscriptOptions resolves the user's access-list (names) into picker
// entries (name + manuscript_id). Entries without a DB row (config exists but
// the manuscript hasn't been bootstrapped yet) are skipped — the picker only
// shows manuscripts the user can actually open right now.
func (h *AuthHandlers) userManuscriptOptions(ctx context.Context, username string) ([]ManuscriptOption, error) {
	access, err := h.DB.GetManuscriptAccessForUser(ctx, username)
	if err != nil {
		return nil, err
	}
	out := make([]ManuscriptOption, 0, len(access))
	for _, ma := range access {
		mc, err := h.Config.GetManuscript(ma.ManuscriptName)
		if err != nil {
			// Config entry was removed; skip silently.
			continue
		}
		m, err := h.DB.GetManuscript(ctx, mc.Repository.CloneURL(), mc.Repository.Path)
		if err != nil || m == nil {
			// Not bootstrapped yet — skip.
			continue
		}
		out = append(out, ManuscriptOption{
			Name:         ma.ManuscriptName,
			ManuscriptID: m.ManuscriptID,
		})
	}
	return out, nil
}

func (h *AuthHandlers) HandleLogout(w http.ResponseWriter, r *http.Request) {
	cookie, err := r.Cookie("session_token")
	if err == nil {
		h.SessionStore.Delete(cookie.Value)
	}

	http.SetCookie(w, &http.Cookie{
		Name:     "session_token",
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   h.IsProduction,
	})

	w.WriteHeader(http.StatusNoContent)
}

// HandleGetUsers returns all users (for the login dropdown), omitting password hashes.
func (h *AuthHandlers) HandleGetUsers(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	users, err := h.DB.GetAllUsers(ctx)
	if err != nil {
		http.Error(w, "Failed to get users", http.StatusInternalServerError)
		return
	}

	type UserInfo struct {
		Username string `json:"username"`
	}

	userInfos := make([]UserInfo, len(users))
	for i, u := range users {
		userInfos[i] = UserInfo{Username: u.Username}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"users": userInfos,
	})
}

func (h *AuthHandlers) HandleGetSession(w http.ResponseWriter, r *http.Request) {
	cookie, err := r.Cookie("session_token")
	if err != nil {
		http.Error(w, "Not logged in", http.StatusUnauthorized)
		return
	}

	session, valid := h.SessionStore.Get(cookie.Value)
	if !valid {
		http.Error(w, "Invalid session", http.StatusUnauthorized)
		return
	}

	ctx := r.Context()
	options, err := h.userManuscriptOptions(ctx, session.Username)
	if err != nil {
		http.Error(w, "Failed to get manuscript access", http.StatusInternalServerError)
		return
	}

	last, err := h.DB.GetLastManuscriptName(ctx, session.Username)
	if err != nil {
		// Non-fatal: just leave it empty so the client picks first-accessible.
		last = ""
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"username":               session.Username,
		"csrf_token":             session.CSRFToken,
		"accessible_manuscripts": options,
		"last_manuscript_name":   last,
	})
}

// HandleSetLastManuscript records the user's most recently opened manuscript.
// Idempotent; silently ignores manuscripts the user can't access.
func (h *AuthHandlers) HandleSetLastManuscript(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

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

	var req struct {
		ManuscriptName string `json:"manuscript_name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}
	if req.ManuscriptName == "" {
		http.Error(w, "manuscript_name required", http.StatusBadRequest)
		return
	}

	hasAccess, err := h.DB.HasManuscriptAccess(ctx, session.Username, req.ManuscriptName)
	if err != nil {
		http.Error(w, "Failed to check access", http.StatusInternalServerError)
		return
	}
	if !hasAccess {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}

	if err := h.DB.SetLastManuscriptName(ctx, session.Username, req.ManuscriptName); err != nil {
		http.Error(w, "Failed to record last manuscript", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

