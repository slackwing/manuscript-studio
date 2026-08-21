package handlers

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/slackwing/manuscript-studio/internal/auth"
	"github.com/slackwing/manuscript-studio/internal/config"
	"github.com/slackwing/manuscript-studio/internal/database"
	"github.com/slackwing/manuscript-studio/internal/models"
	"github.com/slackwing/manuscript-studio/internal/sentence"
)

type MigrationHandlers struct {
	DB     *database.DB
	Config *config.Config
}

type SentenceInfo struct {
	ID   string `json:"id"`
	Text string `json:"text"`
}

func (h *MigrationHandlers) HandleGetMigrations(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	manuscriptIDStr := r.URL.Query().Get("manuscript_id")
	if manuscriptIDStr == "" {
		http.Error(w, "manuscript_id is required", http.StatusBadRequest)
		return
	}

	manuscriptID, err := strconv.Atoi(manuscriptIDStr)
	if err != nil {
		http.Error(w, "Invalid manuscript_id", http.StatusBadRequest)
		return
	}
	if !requireManuscriptAccess(w, r, h.DB, h.Config, manuscriptID) {
		return
	}

	migrations, err := h.DB.GetMigrations(ctx, manuscriptID)
	if err != nil {
		http.Error(w, "Failed to get migrations", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"migrations": migrations,
	})
}

func (h *MigrationHandlers) HandleGetLatestMigration(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	manuscriptIDStr := r.URL.Query().Get("manuscript_id")
	if manuscriptIDStr == "" {
		http.Error(w, "manuscript_id is required", http.StatusBadRequest)
		return
	}

	manuscriptID, err := strconv.Atoi(manuscriptIDStr)
	if err != nil {
		http.Error(w, "Invalid manuscript_id", http.StatusBadRequest)
		return
	}
	if !requireManuscriptAccess(w, r, h.DB, h.Config, manuscriptID) {
		return
	}

	migration, err := h.DB.GetLatestMigration(ctx, manuscriptID)
	if err != nil {
		http.Error(w, "Failed to get latest migration", http.StatusInternalServerError)
		return
	}
	if migration == nil {
		http.Error(w, "No migrations found for this manuscript", http.StatusNotFound)
		return
	}

	// Word count rides along for the manuscript-chrome strip (HOME_PLAN).
	// With wordcount_history enabled the table (effective + linked
	// sketches) is the source; live count is the fallback pre-first-run.
	wordCount, _ := h.DB.GetMigrationWordCount(ctx, migration.MigrationID)
	if h.Config.WordcountHistory.Enabled {
		if wr, err := h.DB.GetLatestWordcount(ctx, migration.ManuscriptID); err == nil && wr != nil {
			wordCount = wr.Total()
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(struct {
		*models.Migration
		WordCount int `json:"word_count"`
	}{migration, wordCount})
}

// HandleGetManuscriptByMigration returns manuscript content for a migration.
// Repo/file come from the manuscript row + config; client supplies no params.
// Notes for the logged-in user ship inline so rainbow bars render on
// first paint without a follow-up fetch.
func (h *MigrationHandlers) HandleGetManuscriptByMigration(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	migrationIDStr := chi.URLParam(r, "migration_id")
	migrationID, err := strconv.Atoi(migrationIDStr)
	if err != nil {
		http.Error(w, "Invalid migration_id", http.StatusBadRequest)
		return
	}
	if _, ok := requireManuscriptAccessForMigration(w, r, h.DB, h.Config, migrationID); !ok {
		return
	}

	migration, err := h.DB.GetMigrationByID(ctx, migrationID)
	if err != nil || migration == nil {
		http.Error(w, "Migration not found", http.StatusNotFound)
		return
	}

	sentences, err := h.DB.GetSentencesByMigration(ctx, migrationID)
	if err != nil {
		http.Error(w, "Failed to get sentences", http.StatusInternalServerError)
		return
	}

	sentenceInfos := make([]SentenceInfo, len(sentences))
	for i, s := range sentences {
		sentenceInfos[i] = SentenceInfo{
			ID:   s.SentenceID,
			Text: s.Text,
		}
	}

	session, err := auth.GetSession(r)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	// v3 multi-user notes: everyone's notes ride along when the caller may
	// see them (hidden flags are viewer-relative).
	var notes []models.Note
	if seeOthers, aerr := userHasAction(ctx, h.DB, session.Username, migration.ManuscriptID, "see-others-notes"); aerr == nil && seeOthers {
		notes, err = h.DB.GetAllNotesByCommit(ctx, migration.CommitHash, session.Username)
	} else {
		notes, err = h.DB.GetNotesByCommit(ctx, migration.CommitHash, session.Username)
	}
	if err != nil {
		log.Printf("migrations: get notes for commit %s: %v", migration.CommitHash, err)
		http.Error(w, "Failed to get notes", http.StatusInternalServerError)
		return
	}
	if notes == nil {
		notes = []models.Note{}
	}
	// Fill the manuscript label so the note's manuscript chip shows its name in
	// the margin (every manuscript note displays its manuscript — read-only).
	fillNoteManuscriptNames(ctx, h.DB, h.Config, notes)

	// Book-wide settings from &meta commands, for the renderer.
	ids := make([]string, len(sentences))
	textByID := make(map[string]string, len(sentences))
	for i, s := range sentences {
		ids[i] = s.SentenceID
		textByID[s.SentenceID] = s.Text
	}
	settings := sentence.ExtractSettings(ids, textByID)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"commit_hash": migration.CommitHash,
		"sentences":   sentenceInfos,
		"notes": notes,
		"settings":    settings.Values,
	})
}

type SentenceHistoryEntry struct {
	Text       string `json:"text"`
	CommitsAgo int    `json:"commits_ago"`
}

// History[0] = 1 commit ago, oldest last.
type SentenceHistory struct {
	SentenceID string                 `json:"sentence_id"`
	History    []SentenceHistoryEntry `json:"history"`
}

// HandleGetSentenceHistory returns up to historyCommitsBack ancestor text
// versions for every sentence in the given migration. Walks
// previous_sentence_id; missing links cap the chain early.
func (h *MigrationHandlers) HandleGetSentenceHistory(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	migrationIDStr := chi.URLParam(r, "migration_id")
	migrationID, err := strconv.Atoi(migrationIDStr)
	if err != nil {
		http.Error(w, "Invalid migration_id", http.StatusBadRequest)
		return
	}
	if _, ok := requireManuscriptAccessForMigration(w, r, h.DB, h.Config, migrationID); !ok {
		return
	}

	const historyCommitsBack = 3

	currentSentences, err := h.DB.GetSentencesByMigration(ctx, migrationID)
	if err != nil {
		http.Error(w, "Failed to load sentences", http.StatusInternalServerError)
		return
	}

	// Walk one hop at a time, batched. cursor[currentSentenceID] = the next
	// ancestor's sentence_id to fetch (or nil when the chain ends).
	cursor := make(map[string]*string, len(currentSentences))
	histories := make(map[string][]SentenceHistoryEntry, len(currentSentences))
	for _, s := range currentSentences {
		cursor[s.SentenceID] = s.PreviousSentenceID
		histories[s.SentenceID] = nil
	}

	for hop := 1; hop <= historyCommitsBack; hop++ {
		needed := make(map[string]bool)
		for _, prev := range cursor {
			if prev != nil {
				needed[*prev] = true
			}
		}
		if len(needed) == 0 {
			break
		}
		ids := make([]string, 0, len(needed))
		for id := range needed {
			ids = append(ids, id)
		}
		fetched, err := h.DB.GetSentenceTextsByIDs(ctx, ids)
		if err != nil {
			http.Error(w, "Failed to walk sentence history", http.StatusInternalServerError)
			return
		}

		for currentID, prev := range cursor {
			if prev == nil {
				continue
			}
			row, ok := fetched[*prev]
			if !ok {
				cursor[currentID] = nil
				continue
			}
			histories[currentID] = append(histories[currentID], SentenceHistoryEntry{
				Text:       row.Text,
				CommitsAgo: hop,
			})
			cursor[currentID] = row.PreviousID
		}
	}

	out := make([]SentenceHistory, len(currentSentences))
	for i, s := range currentSentences {
		out[i] = SentenceHistory{
			SentenceID: s.SentenceID,
			History:    histories[s.SentenceID],
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"sentences": out,
	})
}

// HandleGetOutline returns the document outline (Part -> Chapter -> Anchor
// tree) derived from the migration's block commands, for the left-margin
// navigator. See TEX_COMMANDS_PLAN.md §5.
func (h *MigrationHandlers) HandleGetOutline(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	migrationIDStr := chi.URLParam(r, "migration_id")
	migrationID, err := strconv.Atoi(migrationIDStr)
	if err != nil {
		http.Error(w, "Invalid migration_id", http.StatusBadRequest)
		return
	}
	if _, ok := requireManuscriptAccessForMigration(w, r, h.DB, h.Config, migrationID); !ok {
		return
	}

	sentences, err := h.DB.GetSentencesByMigration(ctx, migrationID)
	if err != nil {
		log.Printf("outline: get sentences for migration %d: %v", migrationID, err)
		http.Error(w, "Failed to load sentences", http.StatusInternalServerError)
		return
	}

	ids := make([]string, len(sentences))
	textByID := make(map[string]string, len(sentences))
	for i, s := range sentences {
		ids[i] = s.SentenceID
		textByID[s.SentenceID] = s.Text
	}

	outline := sentence.BuildOutline(ids, textByID)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(outline)
}

// HandleGetWordcountHistory returns a manuscript's daily wordcount rows —
// data for the wordcount-over-time graph. Rows exist only while the
// wordcount_history feature is enabled and its cron has run; an empty list
// is a normal answer, not an error.
func (h *MigrationHandlers) HandleGetWordcountHistory(w http.ResponseWriter, r *http.Request) {
	manuscriptID, err := strconv.Atoi(chi.URLParam(r, "manuscript_id"))
	if err != nil {
		http.Error(w, "Invalid manuscript_id", http.StatusBadRequest)
		return
	}
	if !requireManuscriptAccess(w, r, h.DB, h.Config, manuscriptID) {
		return
	}
	rows, err := h.DB.ListWordcountHistory(r.Context(), manuscriptID)
	if err != nil {
		http.Error(w, "Failed to load wordcount history", http.StatusInternalServerError)
		return
	}
	// The stats pane's one fetch: history rows PLUS the metadata its header
	// and extrapolations need (birthday, word goal).
	m, err := h.DB.GetManuscriptByID(r.Context(), manuscriptID)
	if err != nil || m == nil {
		http.Error(w, "Failed to load manuscript", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(struct {
		Enabled  bool                    `json:"enabled"`
		Rows     []database.WordcountRow `json:"rows"`
		Birthday *string                 `json:"birthday"`
		WordGoal int                     `json:"word_goal"`
	}{h.Config.WordcountHistory.Enabled, rows, dateString(m.Birthday), m.WordGoal})
}

// dateString formats a DATE column for the API as plain YYYY-MM-DD — a
// timestamp here would invite timezone-shift bugs in the browser.
func dateString(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := t.Format("2006-01-02")
	return &s
}

// HandleGetManuscriptMeta returns the manuscript row (settings modal:
// display name, storage mode, birthday, word goal, name).
func (h *MigrationHandlers) HandleGetManuscriptMeta(w http.ResponseWriter, r *http.Request) {
	manuscriptID, err := strconv.Atoi(chi.URLParam(r, "manuscript_id"))
	if err != nil {
		http.Error(w, "Invalid manuscript_id", http.StatusBadRequest)
		return
	}
	if !requireManuscriptAccess(w, r, h.DB, h.Config, manuscriptID) {
		return
	}
	m, err := h.DB.GetManuscriptByID(r.Context(), manuscriptID)
	if err != nil || m == nil {
		http.Error(w, "Not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(m)
}

// HandleUpdateManuscriptMeta partially updates stats-pane metadata:
// {"birthday": "YYYY-MM-DD"} and/or {"word_goal": N}. Omitted fields are
// left unchanged. Responds with the updated metadata.
func (h *MigrationHandlers) HandleUpdateManuscriptMeta(w http.ResponseWriter, r *http.Request) {
	manuscriptID, err := strconv.Atoi(chi.URLParam(r, "manuscript_id"))
	if err != nil {
		http.Error(w, "Invalid manuscript_id", http.StatusBadRequest)
		return
	}
	if !requireAction(w, r, h.DB, manuscriptID, "manage-manuscript") {
		return
	}
	var body struct {
		Birthday    *string `json:"birthday"`
		WordGoal    *int    `json:"word_goal"`
		DisplayName *string `json:"display_name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "Invalid JSON body", http.StatusBadRequest)
		return
	}
	if body.Birthday == nil && body.WordGoal == nil && body.DisplayName == nil {
		http.Error(w, "Nothing to update", http.StatusBadRequest)
		return
	}
	if body.DisplayName != nil {
		trimmed := strings.TrimSpace(*body.DisplayName)
		if trimmed == "" {
			http.Error(w, "display_name cannot be empty", http.StatusBadRequest)
			return
		}
		body.DisplayName = &trimmed
	}
	var birthday *time.Time
	if body.Birthday != nil {
		t, err := time.Parse("2006-01-02", *body.Birthday)
		if err != nil {
			http.Error(w, "birthday must be YYYY-MM-DD", http.StatusBadRequest)
			return
		}
		birthday = &t
	}
	if body.WordGoal != nil && *body.WordGoal < 1 {
		http.Error(w, "word_goal must be positive", http.StatusBadRequest)
		return
	}
	m, err := h.DB.UpdateManuscriptMeta(r.Context(), manuscriptID, birthday, body.WordGoal, body.DisplayName)
	if err != nil {
		log.Printf("update manuscript meta %d: %v", manuscriptID, err)
		http.Error(w, "Failed to update manuscript", http.StatusInternalServerError)
		return
	}
	if m == nil {
		http.Error(w, "Not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(struct {
		Birthday *string `json:"birthday"`
		WordGoal int     `json:"word_goal"`
	}{dateString(m.Birthday), m.WordGoal})
}
