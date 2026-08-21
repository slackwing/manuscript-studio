package handlers

import (
	"context"
	"net/http"

	"github.com/slackwing/manuscript-studio/internal/auth"
	"github.com/slackwing/manuscript-studio/internal/config"
	"github.com/slackwing/manuscript-studio/internal/database"
	"github.com/slackwing/manuscript-studio/internal/perm"
)

// resolveManuscriptName returns the manuscript's name for a given
// manuscript_id — since 037 the row carries it directly (startup
// reconciliation backfills legacy rows from config). Returns ("", nil) when
// the id doesn't exist or the row was never reconciled (name NULL), and
// ("", err) on DB error. cfg is unused but kept in the signature so the
// callers' uniform (db, cfg) plumbing stays untouched.
func resolveManuscriptName(ctx context.Context, db *database.DB, _ *config.Config, manuscriptID int) (string, error) {
	m, err := db.GetManuscriptByID(ctx, manuscriptID)
	if err != nil {
		return "", err
	}
	if m == nil {
		return "", nil
	}
	return m.Name, nil
}

// requireManuscriptAccess is the standard guard for any per-manuscript
// endpoint: ANY role row on the manuscript (v3 — replaced the old
// manuscript_access lookup). It writes the appropriate HTTP error and
// returns false on deny. Callers should `return` immediately on false.
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
	ok, err := db.HasAnyRole(r.Context(), session.Username, manuscriptID)
	if err != nil {
		http.Error(w, "Failed to check manuscript access", http.StatusInternalServerError)
		return false
	}
	if !ok {
		// No-role and no-such-manuscript look the same to clients (404) so
		// we don't leak existence.
		http.Error(w, "Manuscript not found", http.StatusNotFound)
		return false
	}
	return true
}

// requireAction gates a per-manuscript endpoint on a specific v3 action
// (internal/perm). Runs the any-role visibility check implicitly: a user
// with no role at all gets the same 404 as a missing manuscript; a user
// with roles but without the action gets 403.
func requireAction(w http.ResponseWriter, r *http.Request,
	db *database.DB, manuscriptID int, action string,
) bool {
	session, err := auth.GetSession(r)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return false
	}
	roles, err := db.GetRolesForUser(r.Context(), session.Username, manuscriptID)
	if err != nil {
		http.Error(w, "Failed to check permissions", http.StatusInternalServerError)
		return false
	}
	if len(roles) == 0 {
		http.Error(w, "Manuscript not found", http.StatusNotFound)
		return false
	}
	if !perm.Can(roles, action) {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return false
	}
	return true
}

// userHasAction is the non-writing variant for branching (e.g. "include
// others' rows only when the caller can see them").
func userHasAction(ctx context.Context, db *database.DB, username string, manuscriptID int, action string) (bool, error) {
	roles, err := db.GetRolesForUser(ctx, username, manuscriptID)
	if err != nil {
		return false, err
	}
	return perm.Can(roles, action), nil
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
