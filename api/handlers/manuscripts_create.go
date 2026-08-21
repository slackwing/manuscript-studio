package handlers

// POST /api/manuscripts — in-app manuscript creation (Phase 1,
// MANUSCRIPT_LIFECYCLE_PLAN §2). v1 supports storage='local' only; github
// mode arrives with Phase 4 (repo picker + git_repo_access grants).

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/slackwing/manuscript-studio/internal/auth"
	"github.com/slackwing/manuscript-studio/internal/config"
	"github.com/slackwing/manuscript-studio/internal/database"
	"github.com/slackwing/manuscript-studio/internal/models"
)

type ManuscriptCreateHandlers struct {
	DB           *database.DB
	SessionStore *auth.SessionStore
	Config       *config.Config
	Admin        *AdminHandlers // migration queue for the bootstrap
}

// The seeded file: `# <Title>` — never empty, so docx import (which files a
// composed suggestion) always has a committed sentence to anchor to (§6).
func seedContent(displayName string) []byte {
	return []byte("# " + displayName + "\n")
}

var slugCleanup = regexp.MustCompile(`[^a-z0-9]+`)

// slugify: "The Wildfire" → "the-wildfire". Empty result is the caller's
// problem (validated against ValidateLocalName).
func slugify(s string) string {
	s = strings.ToLower(s)
	s = slugCleanup.ReplaceAllString(s, "-")
	return strings.Trim(s, "-")
}

func (h *ManuscriptCreateHandlers) HandleCreateManuscript(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	session, err := auth.GetSession(r)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	if !auth.ValidateCSRFToken(r, h.SessionStore, r.Header.Get("X-CSRF-Token")) {
		http.Error(w, "Invalid CSRF token", http.StatusForbidden)
		return
	}

	var body struct {
		DisplayName string  `json:"display_name"`
		Name        string  `json:"name"`
		Storage     string  `json:"storage"`
		Birthday    *string `json:"birthday"`
		WordGoal    *int    `json:"word_goal"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}
	body.DisplayName = strings.TrimSpace(body.DisplayName)
	if body.DisplayName == "" {
		http.Error(w, "display_name is required", http.StatusBadRequest)
		return
	}
	if body.Storage != "" && body.Storage != models.StorageLocal {
		http.Error(w, "only storage \"local\" is supported (github-mode creation is not built yet)", http.StatusBadRequest)
		return
	}
	name := strings.TrimSpace(body.Name)
	if name == "" {
		name = slugify(body.DisplayName)
	}
	if err := h.Config.ValidateLocalName(name); err != nil {
		http.Error(w, "invalid name: "+err.Error(), http.StatusBadRequest)
		return
	}
	var birthday *time.Time
	if body.Birthday != nil && *body.Birthday != "" {
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

	row, err := h.DB.CreateLocalManuscript(ctx, name, "book.manuscript", body.DisplayName)
	if errors.Is(err, database.ErrDuplicateManuscriptName) {
		http.Error(w, fmt.Sprintf("a manuscript named %q already exists", name), http.StatusConflict)
		return
	}
	if err != nil {
		log.Printf("create manuscript: %v", err)
		http.Error(w, "Failed to create manuscript", http.StatusInternalServerError)
		return
	}

	// Row exists; now the git side. Any failure past here rolls the row back
	// so a retry isn't blocked by a half-created name.
	fail := func(step string, err error) {
		log.Printf("create manuscript %q: %s: %v", name, step, err)
		if dErr := h.DB.DeleteManuscriptRow(ctx, row.ManuscriptID); dErr != nil {
			log.Printf("create manuscript %q: rollback failed: %v", name, dErr)
		}
		http.Error(w, "Failed to create manuscript", http.StatusInternalServerError)
	}

	gitRepo, err := gitRepoForManuscript(h.Config, row)
	if err != nil {
		fail("resolve", err)
		return
	}
	if err := gitRepo.InitLocal(ctx); err != nil {
		fail("init", err)
		return
	}
	seedSHA, err := gitRepo.CommitSeedFile(ctx, seedContent(body.DisplayName), "Initial manuscript", serverGitAuthor, serverGitEmail)
	if err != nil {
		fail("seed", err)
		return
	}

	if birthday != nil || body.WordGoal != nil {
		if row, err = h.DB.UpdateManuscriptMeta(ctx, row.ManuscriptID, birthday, body.WordGoal, nil); err != nil {
			fail("meta", err)
			return
		}
	}

	// The creator gets access (admin role once PERMISSIONS_PLAN Phase 3
	// lands; a manuscript_access grant until then).
	if err := h.DB.GrantManuscriptAccess(ctx, session.Username, name); err != nil {
		fail("grant", err)
		return
	}

	migrationID, err := h.Admin.enqueueMigration(ctx, row, seedSHA)
	if err != nil && !errors.Is(err, database.ErrMigrationInProgress) {
		// Repo + row + grant all exist — don't roll back a working
		// manuscript over a bootstrap that can be retried via sync.
		log.Printf("create manuscript %q: bootstrap enqueue: %v", name, err)
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"manuscript":   row,
		"migration_id": migrationID,
		"commit_sha":   seedSHA,
	})
}
