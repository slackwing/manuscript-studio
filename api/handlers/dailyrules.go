package handlers

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/slackwing/manuscript-studio/internal/auth"
	"github.com/slackwing/manuscript-studio/internal/database"
)

// Daily-task rules (035): settings-managed caps on what the daily page
// shows — each rule ANDs its selectors (nil = any) and carries max_per_day.
type DailyRuleHandlers struct {
	DB           *database.DB
	SessionStore *auth.SessionStore
}

func validRulePriority(p string) bool {
	switch p {
	case "can", "would", "should", "must":
		return true
	}
	return false
}

func validRuleImpact(i string) bool {
	switch i {
	case "n/a", "sentence", "chapter", "novel", "recurring":
		return true
	}
	return false
}

func validRuleColor(c string) bool {
	switch c {
	case "yellow", "green", "blue", "purple", "red", "orange":
		return true
	}
	return false
}

// HandleList: GET /api/daily-rules
func (h *DailyRuleHandlers) HandleList(w http.ResponseWriter, r *http.Request) {
	session, err := auth.GetSession(r)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	rules, err := h.DB.ListDailyRules(r.Context(), session.Username)
	if err != nil {
		log.Printf("daily-rules: list: %v", err)
		http.Error(w, "Failed to list rules", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"rules": rules})
}

// HandleCreate: POST /api/daily-rules {task_type?, priority?, impact?,
// color?, blocked?, max_per_day, tags: []}
func (h *DailyRuleHandlers) HandleCreate(w http.ResponseWriter, r *http.Request) {
	session, err := auth.GetSession(r)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	if !auth.ValidateCSRFToken(r, h.SessionStore, r.Header.Get("X-CSRF-Token")) {
		http.Error(w, "Invalid CSRF token", http.StatusForbidden)
		return
	}
	var rule database.DailyRule
	if err := json.NewDecoder(r.Body).Decode(&rule); err != nil {
		http.Error(w, "Invalid body", http.StatusBadRequest)
		return
	}
	if rule.MaxPerDay < -1 || rule.MaxPerDay > 16 {
		http.Error(w, "max_per_day must be -1..16", http.StatusBadRequest)
		return
	}
	if rule.Priority != nil && !validRulePriority(*rule.Priority) {
		http.Error(w, "invalid priority", http.StatusBadRequest)
		return
	}
	if rule.Impact != nil && !validRuleImpact(*rule.Impact) {
		http.Error(w, "invalid impact", http.StatusBadRequest)
		return
	}
	if rule.Color != nil && !validRuleColor(*rule.Color) {
		http.Error(w, "invalid color", http.StatusBadRequest)
		return
	}
	if rule.TaskType == nil && rule.Priority == nil && rule.Impact == nil &&
		rule.Color == nil && rule.Blocked == nil && len(rule.Tags) == 0 {
		http.Error(w, "a rule needs at least one selector", http.StatusBadRequest)
		return
	}
	if err := h.DB.CreateDailyRule(r.Context(), session.Username, rule); err != nil {
		log.Printf("daily-rules: create: %v", err)
		http.Error(w, "Failed to create rule (unknown task type?)", http.StatusBadRequest)
		return
	}
	h.HandleList(w, r)
}

// HandleDelete: DELETE /api/daily-rules/{rule_id}
func (h *DailyRuleHandlers) HandleDelete(w http.ResponseWriter, r *http.Request) {
	session, err := auth.GetSession(r)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	if !auth.ValidateCSRFToken(r, h.SessionStore, r.Header.Get("X-CSRF-Token")) {
		http.Error(w, "Invalid CSRF token", http.StatusForbidden)
		return
	}
	id, err := strconv.Atoi(chi.URLParam(r, "rule_id"))
	if err != nil {
		http.Error(w, "Invalid rule id", http.StatusBadRequest)
		return
	}
	ok, err := h.DB.DeleteDailyRule(r.Context(), session.Username, id)
	if err != nil {
		log.Printf("daily-rules: delete %d: %v", id, err)
		http.Error(w, "Failed to delete rule", http.StatusInternalServerError)
		return
	}
	if !ok {
		http.Error(w, "Not found", http.StatusNotFound)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
