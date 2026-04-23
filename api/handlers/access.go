package handlers

import (
	"context"
	"fmt"
	"net/http"

	"github.com/slackwing/manuscript-studio/internal/auth"
	"github.com/slackwing/manuscript-studio/internal/config"
	"github.com/slackwing/manuscript-studio/internal/database"
)

// resolveManuscriptName looks up the configured manuscript name for a given
// manuscript_id. The manuscript table stores (repo_path, file_path), which is
// what the migration processor created the row with — so we match those back
// against the live config to recover the friendly name used by
// `manuscript_access`. Returns ("", nil) when the id exists but isn't in the
// running config (admin removed it from yaml without dropping the row), and
// ("", err) on DB error.
func resolveManuscriptName(ctx context.Context, db *database.DB, cfg *config.Config, manuscriptID int) (string, error) {
	m, err := db.GetManuscriptByID(ctx, manuscriptID)
	if err != nil {
		return "", err
	}
	if m == nil {
		return "", nil
	}
	for _, mc := range cfg.Manuscripts {
		if mc.Repository.CloneURL() == m.RepoPath && mc.Repository.Path == m.FilePath {
			return mc.Name, nil
		}
	}
	return "", nil
}

// requireManuscriptAccess is the standard guard for any per-manuscript
// endpoint. It writes the appropriate HTTP error and returns false on deny.
// Callers should `return` immediately when it returns false.
//
//	if !requireManuscriptAccess(w, r, h.DB, h.Config, manuscriptID) { return }
func requireManuscriptAccess(w http.ResponseWriter, r *http.Request,
	db *database.DB, cfg *config.Config, manuscriptID int,
) bool {
	session, err := auth.GetSession(r)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return false
	}
	name, err := resolveManuscriptName(r.Context(), db, cfg, manuscriptID)
	if err != nil {
		http.Error(w, "Failed to resolve manuscript", http.StatusInternalServerError)
		return false
	}
	if name == "" {
		// Either the row doesn't exist or it's not in the running config.
		// Both look the same to clients (404) so we don't leak existence.
		http.Error(w, "Manuscript not found", http.StatusNotFound)
		return false
	}
	ok, err := db.HasManuscriptAccess(r.Context(), session.Username, name)
	if err != nil {
		http.Error(w, "Failed to check manuscript access", http.StatusInternalServerError)
		return false
	}
	if !ok {
		http.Error(w, "Manuscript not found", http.StatusNotFound)
		return false
	}
	return true
}

// requireManuscriptAccessForMigration is the same check, but starts from a
// migration_id. Loads the migration to find its manuscript_id, then defers
// to requireManuscriptAccess. Returns the looked-up manuscriptID on success
// so callers don't double-fetch.
func requireManuscriptAccessForMigration(w http.ResponseWriter, r *http.Request,
	db *database.DB, cfg *config.Config, migrationID int,
) (manuscriptID int, ok bool) {
	migration, err := db.GetMigrationByID(r.Context(), migrationID)
	if err != nil {
		http.Error(w, "Failed to load migration", http.StatusInternalServerError)
		return 0, false
	}
	if migration == nil {
		http.Error(w, "Migration not found", http.StatusNotFound)
		return 0, false
	}
	if !requireManuscriptAccess(w, r, db, cfg, migration.ManuscriptID) {
		return 0, false
	}
	return migration.ManuscriptID, true
}

// requireManuscriptAccessForSentence is the same check, starting from a
// sentence_id. Sentences belong to migrations belong to manuscripts.
func requireManuscriptAccessForSentence(w http.ResponseWriter, r *http.Request,
	db *database.DB, cfg *config.Config, sentenceID string,
) bool {
	migrationID, err := db.GetMigrationIDForSentence(r.Context(), sentenceID)
	if err != nil {
		http.Error(w, "Failed to load sentence", http.StatusInternalServerError)
		return false
	}
	if migrationID == 0 {
		http.Error(w, "Sentence not found", http.StatusNotFound)
		return false
	}
	_, ok := requireManuscriptAccessForMigration(w, r, db, cfg, migrationID)
	return ok
}

// requireManuscriptAccessForAnnotation is the same check, starting from an
// annotation_id. Annotations belong to sentences belong to migrations belong
// to manuscripts.
func requireManuscriptAccessForAnnotation(w http.ResponseWriter, r *http.Request,
	db *database.DB, cfg *config.Config, annotationID int,
) bool {
	a, err := db.GetAnnotationByID(r.Context(), annotationID)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to load annotation: %v", err), http.StatusInternalServerError)
		return false
	}
	if a == nil {
		http.Error(w, "Annotation not found", http.StatusNotFound)
		return false
	}
	return requireManuscriptAccessForSentence(w, r, db, cfg, a.SentenceID)
}
