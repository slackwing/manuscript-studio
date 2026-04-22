package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/slackwing/manuscript-studio/internal/auth"
	"github.com/slackwing/manuscript-studio/internal/config"
	"github.com/slackwing/manuscript-studio/internal/database"
	"github.com/slackwing/manuscript-studio/internal/migrations"
	"github.com/slackwing/manuscript-studio/internal/models"
)

type MigrationHandlers struct {
	DB     *database.DB
	Config *config.Config
}

// SentenceInfo is the {id, text, wordCount} shape the frontend expects.
type SentenceInfo struct {
	ID        string `json:"id"`
	Text      string `json:"text"`
	WordCount int    `json:"wordCount"`
}

// HandleGetMigrations returns all migrations for a manuscript.
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

// HandleGetLatestMigration returns the latest migration for a manuscript.
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

	migration, err := h.DB.GetLatestMigration(ctx, manuscriptID)
	if err != nil {
		http.Error(w, "Failed to get latest migration", http.StatusInternalServerError)
		return
	}
	if migration == nil {
		http.Error(w, "No migrations found for this manuscript", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(migration)
}

// HandleGetManuscriptByMigration returns manuscript content for a migration.
// Repo/file come from the manuscript row + config; client supplies no params.
func (h *MigrationHandlers) HandleGetManuscriptByMigration(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	migrationIDStr := chi.URLParam(r, "migration_id")
	migrationID, err := strconv.Atoi(migrationIDStr)
	if err != nil {
		http.Error(w, "Invalid migration_id", http.StatusBadRequest)
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

	manuscript, err := h.DB.GetManuscriptByID(ctx, migration.ManuscriptID)
	if err != nil || manuscript == nil {
		http.Error(w, "Manuscript not found", http.StatusInternalServerError)
		return
	}

	manuscriptConfig := h.findManuscriptConfig(manuscript.RepoPath, manuscript.FilePath)
	if manuscriptConfig == nil {
		http.Error(w, "Manuscript not configured in server", http.StatusInternalServerError)
		return
	}

	content, err := h.readGitContent(ctx, manuscriptConfig, migration.CommitHash)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to read manuscript content: %v", err), http.StatusInternalServerError)
		return
	}

	sentenceInfos := make([]SentenceInfo, len(sentences))
	for i, s := range sentences {
		sentenceInfos[i] = SentenceInfo{
			ID:        s.SentenceID,
			Text:      s.Text,
			WordCount: s.WordCount,
		}
	}

	// Ship annotations for the logged-in user alongside the content so rainbow
	// bars render on first paint without a follow-up fetch.
	session, err := auth.GetSession(r)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	annotations, err := h.DB.GetAnnotationsByCommit(ctx, migration.CommitHash, session.Username)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to get annotations: %v", err), http.StatusInternalServerError)
		return
	}
	if annotations == nil {
		annotations = []models.Annotation{}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"commit_hash": migration.CommitHash,
		"markdown":    content,
		"sentences":   sentenceInfos,
		"annotations": annotations,
	})
}

// SentenceHistoryEntry is one ancestor version of a sentence.
type SentenceHistoryEntry struct {
	Text       string `json:"text"`
	CommitsAgo int    `json:"commits_ago"`
}

// SentenceHistory pairs a current sentence with up to N ancestor versions
// (oldest last in History; History[0] = 1 commit ago).
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

	const historyCommitsBack = 3

	// Current commit's sentences are the chain heads.
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
		// Collect all unique IDs we need to fetch this hop.
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

// findManuscriptConfig matches by CloneURL() (the resolved URL git uses), which
// is what was stored when the manuscript row was created.
func (h *MigrationHandlers) findManuscriptConfig(repoURL, filePath string) *config.ManuscriptConfig {
	for i, m := range h.Config.Manuscripts {
		if m.Repository.CloneURL() == repoURL && m.Repository.Path == filePath {
			return &h.Config.Manuscripts[i]
		}
	}
	return nil
}

func (h *MigrationHandlers) readGitContent(ctx context.Context, m *config.ManuscriptConfig, commitHash string) (string, error) {
	if err := migrations.ValidateCommitRef(commitHash); err != nil {
		return "", err
	}
	gitRepo := &migrations.GitRepository{
		Path:      h.Config.RepoPath(m.Name),
		Branch:    m.Repository.Branch,
		RemoteURL: m.Repository.CloneURL(),
		FilePath:  m.Repository.Path,
		AuthToken: m.Repository.AuthToken,
	}
	return gitRepo.GetFileContent(ctx, commitHash)
}