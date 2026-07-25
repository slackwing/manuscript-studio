package handlers

import (
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/slackwing/manuscript-studio/internal/auth"
	"github.com/slackwing/manuscript-studio/internal/config"
	"github.com/slackwing/manuscript-studio/internal/database"
	"github.com/slackwing/manuscript-studio/internal/scratchpad"
)

// Home landing-page data (HOME_PLAN.md): one payload that feeds both the
// card sections and the top-bar search index.
type HomeHandlers struct {
	DB           *database.DB
	SessionStore *auth.SessionStore
	Config       *config.Config
}

type homeManuscript struct {
	ManuscriptID  int        `json:"manuscript_id"`
	Name          string     `json:"name"`
	DisplayName   string     `json:"display_name"`
	LastOpenedAt  *time.Time `json:"last_opened_at,omitempty"`
	ProcessedAt   *time.Time `json:"processed_at,omitempty"`
	SentenceCount int        `json:"sentence_count"`
	WordCount     int        `json:"word_count"`
}

type homeScratchpad struct {
	ScratchpadID int       `json:"scratchpad_id"`
	Title        string    `json:"title"`
	UpdatedAt    time.Time `json:"updated_at"`
	Snippet      string    `json:"snippet"`
	BlockCount   int       `json:"block_count"`
	Canonized    int       `json:"canonized_count"`
}

func (h *HomeHandlers) HandleHome(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	session, err := auth.GetSession(r)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	options, err := userManuscriptOptions(ctx, h.DB, h.Config, session.Username)
	if err != nil {
		http.Error(w, "Failed to list manuscripts", http.StatusInternalServerError)
		return
	}
	opened, err := h.DB.GetManuscriptOpenedMap(ctx, session.Username)
	if err != nil {
		opened = map[int]time.Time{} // recency is an enhancement, not a gate
	}
	manuscripts := make([]homeManuscript, 0, len(options))
	for _, opt := range options {
		hm := homeManuscript{ManuscriptID: opt.ManuscriptID, Name: opt.Name, DisplayName: opt.DisplayName}
		if t, ok := opened[opt.ManuscriptID]; ok {
			tt := t
			hm.LastOpenedAt = &tt
		}
		if mig, err := h.DB.GetLatestMigration(ctx, opt.ManuscriptID); err == nil && mig != nil {
			pt := mig.ProcessedAt
			hm.ProcessedAt = &pt
			hm.SentenceCount = mig.SentenceCount
			if wc, err := h.DB.GetMigrationWordCount(ctx, mig.MigrationID); err == nil {
				hm.WordCount = wc
			}
		}
		manuscripts = append(manuscripts, hm)
	}
	// Last-opened first (nulls last), then latest activity.
	sort.SliceStable(manuscripts, func(i, j int) bool {
		a, b := manuscripts[i], manuscripts[j]
		switch {
		case a.LastOpenedAt != nil && b.LastOpenedAt != nil:
			return a.LastOpenedAt.After(*b.LastOpenedAt)
		case a.LastOpenedAt != nil:
			return true
		case b.LastOpenedAt != nil:
			return false
		case a.ProcessedAt != nil && b.ProcessedAt != nil:
			return a.ProcessedAt.After(*b.ProcessedAt)
		default:
			return a.ProcessedAt != nil
		}
	})

	pads, err := h.DB.ListScratchpadsWithDocs(ctx, session.Username)
	if err != nil {
		http.Error(w, "Failed to list scratchpads", http.StatusInternalServerError)
		return
	}
	scratchpads := make([]homeScratchpad, 0, len(pads))
	for _, p := range pads {
		hs := homeScratchpad{ScratchpadID: p.ScratchpadID, Title: p.Title, UpdatedAt: p.UpdatedAt}
		if snippet, blocks, canonized, err := scratchpad.Summary(p.Doc, 140); err == nil {
			hs.Snippet, hs.BlockCount, hs.Canonized = snippet, blocks, canonized
		}
		scratchpads = append(scratchpads, hs)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"manuscripts": manuscripts,
		"scratchpads": scratchpads,
	})
}

// HandleManuscriptOpened stamps per-user recency; fire-and-forget from the
// book page on load.
func (h *HomeHandlers) HandleManuscriptOpened(w http.ResponseWriter, r *http.Request) {
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
	manuscriptID, err := strconv.Atoi(chi.URLParam(r, "manuscript_id"))
	if err != nil {
		http.Error(w, "Invalid manuscript_id", http.StatusBadRequest)
		return
	}
	if !requireManuscriptAccess(w, r, h.DB, h.Config, manuscriptID) {
		return
	}
	if err := h.DB.UpsertManuscriptOpened(r.Context(), session.Username, manuscriptID); err != nil {
		http.Error(w, "Failed to stamp", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
