package handlers

import (
	"encoding/json"
	"log"
	"net/http"
	"sort"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/slackwing/manuscript-studio/internal/auth"
	"github.com/slackwing/manuscript-studio/internal/config"
	"github.com/slackwing/manuscript-studio/internal/database"
	"github.com/slackwing/manuscript-studio/internal/models"
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
	CreatedAt     time.Time  `json:"created_at"`
	LastOpenedAt  *time.Time `json:"last_opened_at,omitempty"`
	ProcessedAt   *time.Time `json:"processed_at,omitempty"`
	SentenceCount int        `json:"sentence_count"`
	WordCount     int        `json:"word_count"`
}

type homeScratchpad struct {
	ScratchpadID int       `json:"scratchpad_id"`
	Title        string    `json:"title"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
	Sketch      string    `json:"sketch"`
	BlockCount   int       `json:"block_count"`
	Canonized    int       `json:"canonized_count"`
}

// A note card for the landing grid (NOTES_PLAN.md Phase 3): the note itself plus
// a short human context ("The Wildfire", a scratchpad title, or "").
type homeNote struct {
	NoteID       int       `json:"note_id"`
	Color        string    `json:"color"`
	Body         string    `json:"body"`
	Priority     string    `json:"priority"`
	TaskType     string    `json:"task_type"`
	Impact       string    `json:"impact"`
	Blocked      bool      `json:"blocked"`
	UpdatedAt    time.Time `json:"updated_at"`
	Context      string    `json:"context"`               // display label
	ManuscriptID *int      `json:"manuscript_id,omitempty"`
	ScratchpadID *int      `json:"scratchpad_id,omitempty"`
	SentenceID   string    `json:"sentence_id,omitempty"`
	Tags         []models.Tag `json:"tags,omitempty"`
	// Daily-tasks page only: points were awarded to this note today.
	DoneToday bool `json:"done_today,omitempty"`
}

// joinContext renders a note's context label from its manuscript and scratchpad,
// showing both when present ("The Wildfire · Journals: 202607"), or whichever
// one exists, or "".
func joinContext(manuscript, scratchpad string) string {
	switch {
	case manuscript != "" && scratchpad != "":
		return manuscript + " · " + scratchpad
	case manuscript != "":
		return manuscript
	default:
		return scratchpad
	}
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
		hm := homeManuscript{ManuscriptID: opt.ManuscriptID, Name: opt.Name, DisplayName: opt.DisplayName, CreatedAt: opt.CreatedAt}
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
			// wordcount_history enabled → the table (effective + linked
			// sketches, all users) is the source of truth; the live count
			// above stays as the fallback until the cron's first run.
			if h.Config.WordcountHistory.Enabled {
				if wr, err := h.DB.GetLatestWordcount(ctx, opt.ManuscriptID); err == nil && wr != nil {
					hm.WordCount = wr.Total()
				}
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
		hs := homeScratchpad{ScratchpadID: p.ScratchpadID, Title: p.Title, CreatedAt: p.CreatedAt, UpdatedAt: p.UpdatedAt}
		if preview, variationIDs, err := scratchpad.Summary(p.Doc, 140); err == nil {
			hs.Sketch, hs.BlockCount = preview, len(variationIDs)
			if canonized, err := h.DB.CountCanonizedAmong(ctx, variationIDs); err == nil {
				hs.Canonized = canonized
			}
		}
		scratchpads = append(scratchpads, hs)
	}

	// Manuscript display names come from config (displayNameFor), the single
	// source of truth the rest of the app uses — the DB display_name column is
	// often empty (e.g. The Wildfire), and the repo basename ("darkfeather") is
	// wrong. Map manuscript_id → the resolved name we already built above.
	manuscriptName := make(map[int]string, len(manuscripts))
	for _, m := range manuscripts {
		manuscriptName[m.ManuscriptID] = m.DisplayName
	}

	// Recent notes (NOTES_PLAN.md Phase 3). Best-effort: a failure here shows an
	// empty Notes section, not a broken page.
	notes := make([]homeNote, 0)
	if rows, err := h.DB.ListNotesForHome(ctx, session.Username, 60); err == nil {
		for _, n := range rows {
			hn := homeNote{
				NoteID: n.NoteID, Color: n.Color, Priority: n.Priority,
				TaskType: n.TaskType, Impact: n.Impact, Blocked: n.Blocked,
				UpdatedAt: n.UpdatedAt, ManuscriptID: n.ManuscriptID, ScratchpadID: n.ScratchpadID,
				SentenceID: n.SentenceID, Tags: n.Tags,
			}
			if n.Body != nil {
				hn.Body = *n.Body
			}
			// Context can carry BOTH a manuscript and a scratchpad — e.g. a note
			// on a manuscript-linked scratchpad shows "The Wildfire · Journals".
			// Prefer the manuscript's config name (single source of truth); fall
			// back to the DB-derived label the query produced.
			manuscript := n.Context
			if n.ManuscriptID != nil {
				if name, ok := manuscriptName[*n.ManuscriptID]; ok && name != "" {
					manuscript = name
				}
			}
			// A sketch note's context is the SKETCH itself, not whichever
			// pad happens to host it — its variations can span several.
			if n.SketchID != nil {
				hn.Context = joinContext(manuscript, "Sketch")
			} else {
				hn.Context = joinContext(manuscript, n.ScratchpadTitle)
			}
			notes = append(notes, hn)
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"manuscripts": manuscripts,
		"scratchpads": scratchpads,
		"notes":       notes,
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

// HandleDailyTasks: GET /api/daily-tasks?manuscript_id=N — the daily-tasks
// page's date-seeded pick of up to 16 of this manuscript's live TASK notes,
// drawn only from notes created before today (configured timezone) so the
// set is deterministic all day. done_today marks notes already awarded
// points today.
func (h *HomeHandlers) HandleDailyTasks(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	session, err := auth.GetSession(r)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	manuscriptID, err := strconv.Atoi(r.URL.Query().Get("manuscript_id"))
	if err != nil {
		http.Error(w, "manuscript_id required", http.StatusBadRequest)
		return
	}
	loc := h.Config.WordcountHistory.Location()
	now := time.Now().In(loc)
	dayStart := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, loc)
	seed := dayStart.Format("2006-01-02")
	rows, err := h.DB.ListDailyTaskNotes(ctx, session.Username, manuscriptID, seed, dayStart, 16)
	if err != nil {
		log.Printf("daily-tasks: list (manuscript %d): %v", manuscriptID, err)
		http.Error(w, "Failed to list daily tasks", http.StatusInternalServerError)
		return
	}
	name := manuscriptDisplayName(ctx, h.DB, h.Config, manuscriptID)
	notes := make([]homeNote, 0, len(rows))
	for _, n := range rows {
		hn := homeNote{
			NoteID: n.NoteID, Color: n.Color, Priority: n.Priority,
			TaskType: n.TaskType, Impact: n.Impact, Blocked: n.Blocked,
			UpdatedAt: n.UpdatedAt, ManuscriptID: n.ManuscriptID, ScratchpadID: n.ScratchpadID,
			SentenceID: n.SentenceID, Tags: n.Tags, DoneToday: n.DoneToday,
		}
		if n.Body != nil {
			hn.Body = *n.Body
		}
		manuscript := name
		if manuscript == "" {
			manuscript = n.Context
		}
		if n.SketchID != nil {
			hn.Context = joinContext(manuscript, "Sketch")
		} else {
			hn.Context = joinContext(manuscript, n.ScratchpadTitle)
		}
		notes = append(notes, hn)
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"date":            seed,
		"manuscript_name": name,
		"notes":           notes,
	})
}
