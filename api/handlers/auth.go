package handlers

import (
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
	Username       string `json:"username"`
	Password       string `json:"password"`
	ManuscriptName string `json:"manuscript_name"`
}

type LoginResponse struct {
	Username       string `json:"username"`
	ManuscriptName string `json:"manuscript_name"`
	CSRFToken      string `json:"csrf_token"`
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
	// Bcrypt and access check both run unconditionally; results are combined
	// below. The wall-clock cost is what makes the login timing-safe.
	passwordValid := auth.VerifyPassword(req.Password, hashToCompare)

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

	token, err := h.SessionStore.Create(req.Username, req.ManuscriptName)
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

	response := LoginResponse{
		Username:       user.Username,
		ManuscriptName: req.ManuscriptName,
		CSRFToken:      session.CSRFToken,
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
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

// HandleGetManuscripts returns configured manuscript names (login dropdown). Unauthenticated.
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