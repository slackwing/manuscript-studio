package handlers

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/slackwing/manuscript-studio/internal/database"
)

// MigrationHandlers contains migration-related handlers
type MigrationHandlers struct {
	DB *database.DB
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

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"migration": migration,
	})
}

// HandleGetManuscriptByMigration returns manuscript content for a specific migration
func (h *MigrationHandlers) HandleGetManuscriptByMigration(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	// Get migration_id from URL params
	migrationIDStr := chi.URLParam(r, "migration_id")
	migrationID, err := strconv.Atoi(migrationIDStr)
	if err != nil {
		http.Error(w, "Invalid migration_id", http.StatusBadRequest)
		return
	}

	// Get repo and file from query params
	repoPath := r.URL.Query().Get("repo")
	filePath := r.URL.Query().Get("file")

	if repoPath == "" || filePath == "" {
		http.Error(w, "repo and file parameters are required", http.StatusBadRequest)
		return
	}

	// Get migration details
	migration, err := h.DB.GetMigrationByID(ctx, migrationID)
	if err != nil {
		http.Error(w, "Migration not found", http.StatusNotFound)
		return
	}

	// Get sentences for this migration
	sentences, err := h.DB.GetSentencesByMigration(ctx, migrationID)
	if err != nil {
		http.Error(w, "Failed to get sentences", http.StatusInternalServerError)
		return
	}

	// TODO: Get actual manuscript content from git
	// For now, return placeholder
	manuscriptContent := "# Manuscript content would be loaded from git here"

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"commit_hash": migration.CommitHash,
		"manuscript":  manuscriptContent,
		"sentences":   sentences,
	})
}