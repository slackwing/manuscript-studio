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

// Task types (031/032): the first task dimension. 'reminder' = not a task;
// built-ins + user-added customs make a note a TASK. Each type carries a
// color — 'gray' means no behavior, a real note color means "picking this
// type recolors the note". Managed from the settings page.
type TaskTypeHandlers struct {
	DB           *database.DB
	SessionStore *auth.SessionStore
}

var taskTypeName = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,39}$`)

func validTaskTypeColor(c string) bool {
	switch c {
	case "gray", "yellow", "green", "blue", "purple", "red", "orange":
		return true
	}
	return false
}

// HandleList: GET /api/task-types — every type, built-ins first then
// customs, each alphabetical ('reminder' pinned first as the default).
func (h *TaskTypeHandlers) HandleList(w http.ResponseWriter, r *http.Request) {
	types, err := h.DB.ListTaskTypes(r.Context())
	if err != nil {
		log.Printf("task-types: list: %v", err)
		http.Error(w, "Failed to list task types", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"task_types": types})
}

// HandleCreate: POST /api/task-types {"names": ["write","muse",…]} — bulk
// add custom types (the settings page's space-separated slug field).
// Existing names are skipped silently, so the field is idempotent.
func (h *TaskTypeHandlers) HandleCreate(w http.ResponseWriter, r *http.Request) {
	if !auth.ValidateCSRFToken(r, h.SessionStore, r.Header.Get("X-CSRF-Token")) {
		http.Error(w, "Invalid CSRF token", http.StatusForbidden)
		return
	}
	var body struct {
		Names []string `json:"names"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || len(body.Names) == 0 {
		http.Error(w, "names required", http.StatusBadRequest)
		return
	}
	for _, n := range body.Names {
		if !taskTypeName.MatchString(n) {
			http.Error(w, "task type names are lowercase slugs (a-z, 0-9, -): "+n, http.StatusBadRequest)
			return
		}
	}
	if err := h.DB.AddTaskTypes(r.Context(), body.Names); err != nil {
		log.Printf("task-types: add %v: %v", body.Names, err)
		http.Error(w, "Failed to add task types", http.StatusInternalServerError)
		return
	}
	h.HandleList(w, r)
}

// HandleSetColor: PUT /api/task-types/{name}/color {"color": "green"}.
func (h *TaskTypeHandlers) HandleSetColor(w http.ResponseWriter, r *http.Request) {
	if !auth.ValidateCSRFToken(r, h.SessionStore, r.Header.Get("X-CSRF-Token")) {
		http.Error(w, "Invalid CSRF token", http.StatusForbidden)
		return
	}
	name := chi.URLParam(r, "name")
	var body struct {
		Color string `json:"color"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || !validTaskTypeColor(body.Color) {
		http.Error(w, "color must be gray or a note color", http.StatusBadRequest)
		return
	}
	ok, err := h.DB.SetTaskTypeColor(r.Context(), name, body.Color)
	if err != nil {
		log.Printf("task-types: color %s=%s: %v", name, body.Color, err)
		http.Error(w, "Failed to set color", http.StatusInternalServerError)
		return
	}
	if !ok {
		http.Error(w, "Not found", http.StatusNotFound)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
