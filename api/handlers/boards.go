package handlers

// Boards (059, BOARDS_PLAN.md): a user's saved views of their notes. A
// board opens as a TAB (home.html?view=board&board_id=N) and shows, above
// its notes, the same rules editor the settings page uses for daily tasks,
// plus a manuscript picker (none picked = all).

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"github.com/slackwing/manuscript-studio/internal/auth"
	"github.com/slackwing/manuscript-studio/internal/config"
	"github.com/slackwing/manuscript-studio/internal/database"
)

type BoardHandlers struct {
	DB           *database.DB
	SessionStore *auth.SessionStore
	Config       *config.Config
}

type boardOut struct {
	database.Board
	NoteCount int                  `json:"note_count"`
	Rules     []database.DailyRule `json:"rules"`
}

// boardSummary: a board with its rules and how many notes it shows now.
func (h *BoardHandlers) boardSummary(r *http.Request, username string, b *database.Board) boardOut {
	o := boardOut{Board: *b, Rules: []database.DailyRule{}}
	if notes, err := h.DB.BoardNotes(r.Context(), username, b); err == nil {
		o.NoteCount = len(notes)
	}
	if rules, err := h.DB.ListBoardRules(r.Context(), username, b.BoardID); err == nil && rules != nil {
		o.Rules = rules
	}
	return o
}

type boardManuscript struct {
	ManuscriptID int    `json:"manuscript_id"`
	Name         string `json:"name"`
}

// homeNoteOf renders a database row as the landing/board card payload.
func homeNoteOf(n database.HomeNote, nameOf func(int) string) homeNote {
	hn := homeNote{
		NoteID: n.NoteID, Color: n.Color, Priority: n.Priority,
		TaskType: n.TaskType, Impact: n.Impact, Blocked: n.Blocked,
		UpdatedAt: n.UpdatedAt, ManuscriptID: n.ManuscriptID, ScratchpadID: n.ScratchpadID,
		SentenceID: n.SentenceID, Tags: n.Tags, CompletedAt: n.CompletedAt, PinnedAt: n.PinnedAt,
	}
	if n.DefaultBody != nil {
		hn.DefaultBody = *n.DefaultBody
	}
	if n.Body != nil {
		hn.Body = *n.Body
	}
	manuscript := n.Context
	if n.ManuscriptID != nil {
		if name := nameOf(*n.ManuscriptID); name != "" {
			manuscript = name
		}
	}
	if n.SketchID != nil {
		hn.Context = joinContext(manuscript, "Sketch")
	} else {
		hn.Context = joinContext(manuscript, n.ScratchpadTitle)
	}
	return hn
}

func (h *BoardHandlers) session(w http.ResponseWriter, r *http.Request, csrf bool) (string, bool) {
	s, err := auth.GetSession(r)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return "", false
	}
	if csrf && !auth.ValidateCSRFToken(r, h.SessionStore, r.Header.Get("X-CSRF-Token")) {
		http.Error(w, "Invalid CSRF token", http.StatusForbidden)
		return "", false
	}
	return s.Username, true
}

// own loads the viewer's board or answers 404.
func (h *BoardHandlers) own(w http.ResponseWriter, r *http.Request, username string) *database.Board {
	id, err := strconv.Atoi(chi.URLParam(r, "board_id"))
	if err != nil {
		http.Error(w, "Invalid board_id", http.StatusBadRequest)
		return nil
	}
	b, err := h.DB.GetBoard(r.Context(), username, id)
	if err != nil {
		log.Printf("boards: get %d: %v", id, err)
		http.Error(w, "Failed to load board", http.StatusInternalServerError)
		return nil
	}
	if b == nil {
		http.Error(w, "Not found", http.StatusNotFound)
		return nil
	}
	return b
}

func (h *BoardHandlers) nameOf(r *http.Request, username string) (func(int) string, []boardManuscript) {
	names := map[int]string{}
	var list []boardManuscript
	if opts, err := userManuscriptOptions(r.Context(), h.DB, h.Config, username); err == nil {
		for _, o := range opts {
			names[o.ManuscriptID] = o.DisplayName
			list = append(list, boardManuscript{ManuscriptID: o.ManuscriptID, Name: o.DisplayName})
		}
	}
	if list == nil {
		list = []boardManuscript{}
	}
	return func(id int) string { return names[id] }, list
}

// HandleList: GET /api/boards → {boards: [{…, note_count}]}
func (h *BoardHandlers) HandleList(w http.ResponseWriter, r *http.Request) {
	username, ok := h.session(w, r, false)
	if !ok {
		return
	}
	boards, err := h.DB.ListBoards(r.Context(), username)
	if err != nil {
		log.Printf("boards: list: %v", err)
		http.Error(w, "Failed to list boards", http.StatusInternalServerError)
		return
	}
	out := make([]boardOut, 0, len(boards))
	for i := range boards {
		out = append(out, h.boardSummary(r, username, &boards[i]))
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"boards": out})
}

type boardPatch struct {
	Name          *string `json:"name"`
	ManuscriptIDs []int   `json:"manuscript_ids"`
}

// HandleCreate: POST /api/boards {name?, manuscript_ids?} → the board
func (h *BoardHandlers) HandleCreate(w http.ResponseWriter, r *http.Request) {
	username, ok := h.session(w, r, true)
	if !ok {
		return
	}
	var req boardPatch
	if r.ContentLength != 0 {
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "Invalid body", http.StatusBadRequest)
			return
		}
	}
	name := "Board"
	if req.Name != nil && *req.Name != "" {
		name = *req.Name
	}
	if !h.manuscriptsAllowed(r, username, req.ManuscriptIDs) {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}
	b, err := h.DB.CreateBoard(r.Context(), username, name, req.ManuscriptIDs)
	if err != nil {
		log.Printf("boards: create: %v", err)
		http.Error(w, "Failed to create board", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(b)
}

// manuscriptsAllowed: every picked manuscript is one the viewer can access.
func (h *BoardHandlers) manuscriptsAllowed(r *http.Request, username string, ids []int) bool {
	if len(ids) == 0 {
		return true
	}
	nameOf, list := h.nameOf(r, username)
	_ = nameOf
	allowed := map[int]bool{}
	for _, m := range list {
		allowed[m.ManuscriptID] = true
	}
	for _, id := range ids {
		if !allowed[id] {
			return false
		}
	}
	return true
}

// HandleGet: GET /api/boards/{board_id} → {board, rules, notes, manuscripts}
func (h *BoardHandlers) HandleGet(w http.ResponseWriter, r *http.Request) {
	username, ok := h.session(w, r, false)
	if !ok {
		return
	}
	b := h.own(w, r, username)
	if b == nil {
		return
	}
	rules, err := h.DB.ListBoardRules(r.Context(), username, b.BoardID)
	if err != nil {
		log.Printf("boards: rules %d: %v", b.BoardID, err)
		rules = []database.DailyRule{}
	}
	rows, err := h.DB.BoardNotes(r.Context(), username, b)
	if err != nil {
		log.Printf("boards: notes %d: %v", b.BoardID, err)
		http.Error(w, "Failed to list the board's notes", http.StatusInternalServerError)
		return
	}
	nameOf, manuscripts := h.nameOf(r, username)
	notes := make([]homeNote, 0, len(rows))
	for _, n := range rows {
		notes = append(notes, homeNoteOf(n, nameOf))
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"board": b, "rules": rules, "notes": notes, "manuscripts": manuscripts,
	})
}

// HandleUpdate: PUT /api/boards/{board_id} {name?, manuscript_ids?} → the board
func (h *BoardHandlers) HandleUpdate(w http.ResponseWriter, r *http.Request) {
	username, ok := h.session(w, r, true)
	if !ok {
		return
	}
	b := h.own(w, r, username)
	if b == nil {
		return
	}
	var req boardPatch
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid body", http.StatusBadRequest)
		return
	}
	if req.Name != nil && *req.Name == "" {
		http.Error(w, "A board needs a name", http.StatusBadRequest)
		return
	}
	if !h.manuscriptsAllowed(r, username, req.ManuscriptIDs) {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}
	updated, err := h.DB.UpdateBoard(r.Context(), username, b.BoardID, req.Name, req.ManuscriptIDs)
	if err != nil {
		log.Printf("boards: update %d: %v", b.BoardID, err)
		http.Error(w, "Failed to update board", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(updated)
}

// HandleDelete: DELETE /api/boards/{board_id} (soft)
func (h *BoardHandlers) HandleDelete(w http.ResponseWriter, r *http.Request) {
	username, ok := h.session(w, r, true)
	if !ok {
		return
	}
	b := h.own(w, r, username)
	if b == nil {
		return
	}
	if _, err := h.DB.DeleteBoard(r.Context(), username, b.BoardID); err != nil {
		log.Printf("boards: delete %d: %v", b.BoardID, err)
		http.Error(w, "Failed to delete board", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// HandleListRules: GET /api/boards/{board_id}/rules → {rules}
func (h *BoardHandlers) HandleListRules(w http.ResponseWriter, r *http.Request) {
	username, ok := h.session(w, r, false)
	if !ok {
		return
	}
	b := h.own(w, r, username)
	if b == nil {
		return
	}
	rules, err := h.DB.ListBoardRules(r.Context(), username, b.BoardID)
	if err != nil {
		log.Printf("boards: rules %d: %v", b.BoardID, err)
		http.Error(w, "Failed to list rules", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"rules": rules})
}

// HandleCreateRule: POST /api/boards/{board_id}/rules {task_type?, priority?,
// impact?, color?, blocked?, max_per_day, tags} → {rules} (the same shape
// and validation as the daily rules; max_per_day -1 = unlimited).
func (h *BoardHandlers) HandleCreateRule(w http.ResponseWriter, r *http.Request) {
	username, ok := h.session(w, r, true)
	if !ok {
		return
	}
	b := h.own(w, r, username)
	if b == nil {
		return
	}
	var rule database.DailyRule
	if err := json.NewDecoder(r.Body).Decode(&rule); err != nil {
		http.Error(w, "Invalid body", http.StatusBadRequest)
		return
	}
	if rule.MaxPerDay < -1 || rule.MaxPerDay > 999 {
		http.Error(w, "max_per_day must be -1..999", http.StatusBadRequest)
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
	id := b.BoardID
	rule.BoardID = &id
	if err := h.DB.CreateDailyRule(r.Context(), username, rule); err != nil {
		log.Printf("boards: create rule on %d: %v", b.BoardID, err)
		http.Error(w, "Failed to create rule (unknown task type?)", http.StatusBadRequest)
		return
	}
	h.HandleListRules(w, r)
}

// HandleDeleteRule: DELETE /api/boards/{board_id}/rules/{rule_id}
func (h *BoardHandlers) HandleDeleteRule(w http.ResponseWriter, r *http.Request) {
	username, ok := h.session(w, r, true)
	if !ok {
		return
	}
	b := h.own(w, r, username)
	if b == nil {
		return
	}
	id, err := strconv.Atoi(chi.URLParam(r, "rule_id"))
	if err != nil {
		http.Error(w, "Invalid rule_id", http.StatusBadRequest)
		return
	}
	okDel, err := h.DB.DeleteBoardRule(r.Context(), username, b.BoardID, id)
	if err != nil {
		log.Printf("boards: delete rule %d on %d: %v", id, b.BoardID, err)
		http.Error(w, "Failed to delete rule", http.StatusInternalServerError)
		return
	}
	if !okDel {
		http.Error(w, "Not found", http.StatusNotFound)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
