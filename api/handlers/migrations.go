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

// MigrationHandlers contains migration-related handlers
type MigrationHandlers struct {
	DB     *database.DB
	Config *config.Config
}

// SentenceInfo is the sentence shape the frontend expects.
// Faithful to 14.writesys/api/main.go: {id, text, wordCount}.
type SentenceInfo struct {
	ID        string `json:"id"`
	Text      string `json:"text"`
	WordCount int    `json:"wordCount"`
}

// HandleGetMigrations returns all migrations for a manuscript
func (h *MigrationHandlers) HandleGetMigrations(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	// Get manuscript_id from query params
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

// HandleGetLatestMigration returns the latest migration for a manuscript
func (h *MigrationHandlers) HandleGetLatestMigration(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	// Get manuscript_id from query params
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

// HandleGetManuscriptByMigration returns manuscript content for a specific migration.
// Reads repo/file from the manuscript row + config; no client-supplied params needed.
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

	// Get manuscript row to find which repo/file this migration came from
	manuscript, err := h.DB.GetManuscriptByID(ctx, migration.ManuscriptID)
	if err != nil || manuscript == nil {
		http.Error(w, "Manuscript not found", http.StatusInternalServerError)
		return
	}

	// Match manuscript repo URL to a configured manuscript (for name → clone path)
	manuscriptConfig := h.findManuscriptConfig(manuscript.RepoPath, manuscript.FilePath)
	if manuscriptConfig == nil {
		http.Error(w, "Manuscript not configured in server", http.StatusInternalServerError)
		return
	}

	// Read file content at the migration's commit from the local clone
	content, err := h.readGitContent(ctx, manuscriptConfig, migration.CommitHash)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to read manuscript content: %v", err), http.StatusInternalServerError)
		return
	}

	// Convert DB sentences to the frontend's expected shape: {id, text, wordCount}.
	sentenceInfos := make([]SentenceInfo, len(sentences))
	for i, s := range sentences {
		sentenceInfos[i] = SentenceInfo{
			ID:        s.SentenceID,
			Text:      s.Text,
			WordCount: s.WordCount,
		}
	}

	// Fetch annotations for this commit for the logged-in user so rainbow bars
	// can render on initial page load (faithful to 14.writesys).
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

// findManuscriptConfig returns the ManuscriptConfig matching the stored manuscript row.
func (h *MigrationHandlers) findManuscriptConfig(repoURL, filePath string) *config.ManuscriptConfig {
	for i, m := range h.Config.Manuscripts {
		if m.Repository.URL == repoURL && m.Repository.Path == filePath {
			return &h.Config.Manuscripts[i]
		}
	}
	return nil
}

// readGitContent reads the manuscript file contents at a specific commit from the local clone.
func (h *MigrationHandlers) readGitContent(ctx context.Context, m *config.ManuscriptConfig, commitHash string) (string, error) {
	gitRepo := migrations.NewGitRepository(
		fmt.Sprintf("%s/%s", reposDir(), m.Name),
		m.Repository.Branch,
		m.Repository.URL,
		m.Repository.Path,
		m.Repository.AuthToken,
	)
	return gitRepo.GetFileContent(ctx, commitHash)
}