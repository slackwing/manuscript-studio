package handlers

// Role-grant + People endpoints (PERMISSIONS_PLAN.md v3 §§1,6).
//
//   GET    api/roles                              the embedded roles.json
//   GET    api/manuscripts/{id}/people            members + viewer's order
//   PUT    api/manuscripts/{id}/people-order      viewer's drag order
//   POST   api/manuscripts/{id}/roles             {username, role} grant
//   DELETE api/manuscripts/{id}/roles             {username, role} revoke
//
// Grant/revoke are gated per-role via the derived manage-role-<role>
// action; revoking the last admin 409s (ErrLastAdmin).

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"sort"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/slackwing/manuscript-studio/internal/auth"
	"github.com/slackwing/manuscript-studio/internal/config"
	"github.com/slackwing/manuscript-studio/internal/database"
	"github.com/slackwing/manuscript-studio/internal/perm"
)

type RoleHandlers struct {
	DB           *database.DB
	SessionStore *auth.SessionStore
	Config       *config.Config
}

// HandleGetRolesJSON serves the embedded roles.json verbatim (any session).
func (h *RoleHandlers) HandleGetRolesJSON(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Write(perm.RolesJSON())
}

// bestRoleRank: a member's most senior role (People default sort).
func bestRoleRank(roles []string) int {
	best := 1 << 30
	for _, r := range roles {
		if s := perm.Seniority(r); s < best {
			best = s
		}
	}
	return best
}

// HandleGetPeople returns the access list + the VIEWER's display order.
// Default order: role seniority desc, then account age (older first) —
// exactly the People-tab spec; a saved drag order overrides. Also reports
// which roles the viewer may manage, so the UI renders only real options.
func (h *RoleHandlers) HandleGetPeople(w http.ResponseWriter, r *http.Request) {
	manuscriptID, err := strconv.Atoi(chi.URLParam(r, "manuscript_id"))
	if err != nil {
		http.Error(w, "Invalid manuscript_id", http.StatusBadRequest)
		return
	}
	if !requireManuscriptAccess(w, r, h.DB, h.Config, manuscriptID) {
		return
	}
	session, _ := auth.GetSession(r)

	members, err := h.DB.ListRoleMembers(r.Context(), manuscriptID)
	if err != nil {
		log.Printf("people: list members: %v", err)
		http.Error(w, "Failed to list people", http.StatusInternalServerError)
		return
	}
	sort.SliceStable(members, func(i, j int) bool {
		ri, rj := bestRoleRank(members[i].Roles), bestRoleRank(members[j].Roles)
		if ri != rj {
			return ri < rj
		}
		return members[i].UserCreatedAt.Before(members[j].UserCreatedAt)
	})
	defaultOrder := make([]string, len(members))
	for i, m := range members {
		defaultOrder[i] = m.Username
	}

	saved, err := h.DB.GetPeopleOrder(r.Context(), session.Username, manuscriptID)
	if err != nil {
		log.Printf("people: saved order: %v", err)
	}
	// Merge: saved entries first (that still exist), then any new members
	// in default position — a fresh grant shouldn't vanish from the tab.
	order := defaultOrder
	if len(saved) > 0 {
		seen := make(map[string]bool)
		merged := make([]string, 0, len(defaultOrder))
		valid := make(map[string]bool, len(defaultOrder))
		for _, u := range defaultOrder {
			valid[u] = true
		}
		for _, u := range saved {
			if valid[u] && !seen[u] {
				merged = append(merged, u)
				seen[u] = true
			}
		}
		for _, u := range defaultOrder {
			if !seen[u] {
				merged = append(merged, u)
			}
		}
		order = merged
	}

	viewerRoles, err := h.DB.GetRolesForUser(r.Context(), session.Username, manuscriptID)
	if err != nil {
		http.Error(w, "Failed to load roles", http.StatusInternalServerError)
		return
	}
	manageable := []string{}
	for _, role := range perm.AllRoles() {
		if perm.Can(viewerRoles, perm.ManageRoleAction(role)) {
			manageable = append(manageable, role)
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"members":          members,
		"order":            order,
		"manageable_roles": manageable,
		"all_roles":        perm.AllRoles(),
	})
}

// HandlePutPeopleOrder saves the viewer's drag order.
func (h *RoleHandlers) HandlePutPeopleOrder(w http.ResponseWriter, r *http.Request) {
	manuscriptID, err := strconv.Atoi(chi.URLParam(r, "manuscript_id"))
	if err != nil {
		http.Error(w, "Invalid manuscript_id", http.StatusBadRequest)
		return
	}
	if !requireManuscriptAccess(w, r, h.DB, h.Config, manuscriptID) {
		return
	}
	session, _ := auth.GetSession(r)
	if !auth.ValidateCSRFToken(r, h.SessionStore, r.Header.Get("X-CSRF-Token")) {
		http.Error(w, "Invalid CSRF token", http.StatusForbidden)
		return
	}
	var body struct {
		Order []string `json:"order"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || len(body.Order) == 0 {
		http.Error(w, "order is required", http.StatusBadRequest)
		return
	}
	if err := h.DB.SetPeopleOrder(r.Context(), session.Username, manuscriptID, body.Order); err != nil {
		log.Printf("people: save order: %v", err)
		http.Error(w, "Failed to save order", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type roleChangeRequest struct {
	Username string `json:"username"`
	Role     string `json:"role"`
}

func (h *RoleHandlers) roleChangePrelude(w http.ResponseWriter, r *http.Request) (manuscriptID int, req roleChangeRequest, ok bool) {
	manuscriptID, err := strconv.Atoi(chi.URLParam(r, "manuscript_id"))
	if err != nil {
		http.Error(w, "Invalid manuscript_id", http.StatusBadRequest)
		return 0, req, false
	}
	if !auth.ValidateCSRFToken(r, h.SessionStore, r.Header.Get("X-CSRF-Token")) {
		http.Error(w, "Invalid CSRF token", http.StatusForbidden)
		return 0, req, false
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Username == "" || req.Role == "" {
		http.Error(w, "username and role are required", http.StatusBadRequest)
		return 0, req, false
	}
	if !perm.ValidRole(req.Role) {
		http.Error(w, "unknown role", http.StatusBadRequest)
		return 0, req, false
	}
	// The generalized scheme: granting/revoking role X needs manage-role-X.
	if !requireAction(w, r, h.DB, manuscriptID, perm.ManageRoleAction(req.Role)) {
		return 0, req, false
	}
	return manuscriptID, req, true
}

// HandleGrantRole grants a role (idempotent). The target user must exist.
func (h *RoleHandlers) HandleGrantRole(w http.ResponseWriter, r *http.Request) {
	manuscriptID, req, ok := h.roleChangePrelude(w, r)
	if !ok {
		return
	}
	user, err := h.DB.GetUserByUsername(r.Context(), req.Username)
	if err != nil {
		http.Error(w, "Failed to look up user", http.StatusInternalServerError)
		return
	}
	if user == nil {
		http.Error(w, "No such user", http.StatusNotFound)
		return
	}
	if err := h.DB.GrantRole(r.Context(), req.Username, manuscriptID, req.Role); err != nil {
		log.Printf("roles: grant %s/%s on %d: %v", req.Username, req.Role, manuscriptID, err)
		http.Error(w, "Failed to grant role", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(req)
}

// HandleRevokeRole revokes a role; the last admin is protected (409).
func (h *RoleHandlers) HandleRevokeRole(w http.ResponseWriter, r *http.Request) {
	manuscriptID, req, ok := h.roleChangePrelude(w, r)
	if !ok {
		return
	}
	err := h.DB.RevokeRole(r.Context(), req.Username, manuscriptID, req.Role)
	if errors.Is(err, database.ErrLastAdmin) {
		http.Error(w, "Cannot remove the last admin of a manuscript", http.StatusConflict)
		return
	}
	if err != nil {
		log.Printf("roles: revoke %s/%s on %d: %v", req.Username, req.Role, manuscriptID, err)
		http.Error(w, "Failed to revoke role", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
