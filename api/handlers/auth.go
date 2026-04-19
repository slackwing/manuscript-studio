package handlers

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/slackwing/manuscript-studio/internal/auth"
	"github.com/slackwing/manuscript-studio/internal/config"
	"github.com/slackwing/manuscript-studio/internal/database"
)

// AuthHandlers contains authentication-related handlers
type AuthHandlers struct {
	DB            *database.DB
	SessionStore  *auth.SessionStore
	IsProduction  bool
	Config        *config.Config
}

// LoginRequest represents login credentials
type LoginRequest struct {
	Username       string `json:"username"`
	Password       string `json:"password"`
	ManuscriptName string `json:"manuscript_name"`
}

// LoginResponse contains session info after successful login
type LoginResponse struct {
	Username       string `json:"username"`
	ManuscriptName string `json:"manuscript_name"`
	CSRFToken      string `json:"csrf_token"`
}

// dummyPasswordHash is a real bcrypt hash of an arbitrary string at the same
// cost factor as production hashes. It exists so VerifyPassword does the same
// amount of work whether or not the user exists, defeating timing-based
// username enumeration.
const dummyPasswordHash = "$2a$10$natLQrpv.hhOkSBcdpI/nOAIicjCeF4/0bGMQywZsEOiNgiSgDnP."

// HandleLogin authenticates a user and creates a session.
//
// Timing-safe: bcrypt always runs against either the user's real hash or a
// dummy hash, *before* any branching on whether the user exists. All failure
// modes (no such user, bad password, no manuscript access) return the same
// status code and body.
func (h *AuthHandlers) HandleLogin(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	var req LoginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	if req.Username == "" || req.Password == "" || req.ManuscriptName == "" {
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
	// Always run bcrypt — the wall-clock cost is what makes the operation
	// timing-safe, so we deliberately ignore the result here and re-evaluate
	// alongside other conditions below.
	passwordValid := auth.VerifyPassword(req.Password, hashToCompare)

	// Always check manuscript access — same reason. Use the requested name
	// (which may not match any real manuscript) when the user is missing, so
	// the DB does a comparable amount of work.
	hasAccess, err := h.DB.HasManuscriptAccess(ctx, req.Username, req.ManuscriptName)
	if err != nil {
		log.Printf("Error checking manuscript access: %v", err)
		http.Error(w, "Invalid credentials", http.StatusUnauthorized)
		return
	}

	if user == nil || !passwordValid || !hasAccess {
		http.Error(w, "Invalid credentials", http.StatusUnauthorized)
		return
	}

	// Create session
	token, err := h.SessionStore.Create(req.Username, req.ManuscriptName)
	if err != nil {
		http.Error(w, "Failed to create session", http.StatusInternalServerError)
		return
	}

	// Get session to retrieve CSRF token
	session, _ := h.SessionStore.Get(token)

	// Set session cookie
	http.SetCookie(w, &http.Cookie{
		Name:     "session_token",
		Value:    token,
		Path:     "/",
		MaxAge:   86400, // 24 hours
		HttpOnly: true,
		Secure:   h.IsProduction, // Only send over HTTPS in production
		SameSite: http.SameSiteStrictMode,
	})

	response := LoginResponse{
		Username:       user.Username,
		ManuscriptName: req.ManuscriptName,
		CSRFToken:      session.CSRFToken,
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

// HandleLogout destroys the current session
func (h *AuthHandlers) HandleLogout(w http.ResponseWriter, r *http.Request) {
	cookie, err := r.Cookie("session_token")
	if err == nil {
		h.SessionStore.Delete(cookie.Value)
	}

	// Clear cookie
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

// HandleGetUsers returns all users (for login dropdown)
func (h *AuthHandlers) HandleGetUsers(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	users, err := h.DB.GetAllUsers(ctx)
	if err != nil {
		http.Error(w, "Failed to get users", http.StatusInternalServerError)
		return
	}

	// Return simplified user info (no password hash)
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

// HandleGetSession returns current session info
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

	// Get accessible manuscripts for this user
	ctx := r.Context()
	manuscripts, err := h.DB.GetManuscriptAccessForUser(ctx, session.Username)
	if err != nil {
		http.Error(w, "Failed to get manuscript access", http.StatusInternalServerError)
		return
	}

	manuscriptNames := make([]string, len(manuscripts))
	for i, m := range manuscripts {
		manuscriptNames[i] = m.ManuscriptName
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"username":               session.Username,
		"manuscript_name":        session.ManuscriptName,
		"csrf_token":             session.CSRFToken,
		"accessible_manuscripts": manuscriptNames,
	})
}

// HandleGetManuscripts returns the list of configured manuscript names
// (for the login page dropdown). No auth required.
func (h *AuthHandlers) HandleGetManuscripts(w http.ResponseWriter, r *http.Request) {
	names := make([]string, 0, len(h.Config.Manuscripts))
	for _, m := range h.Config.Manuscripts {
		names = append(names, m.Name)
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"manuscripts": names,
	})
}