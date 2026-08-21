package api

import (
	"bytes"
	"context"
	"html"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/slackwing/manuscript-studio/api/handlers"
	"github.com/slackwing/manuscript-studio/internal/auth"
	"github.com/slackwing/manuscript-studio/internal/config"
	"github.com/slackwing/manuscript-studio/internal/database"
	"github.com/slackwing/manuscript-studio/internal/logctx"
	"github.com/slackwing/manuscript-studio/internal/migrations"
	"github.com/slackwing/manuscript-studio/internal/ratelimit"
)

type Server struct {
	config             *config.Config
	db                 *pgxpool.Pool
	dbWrapper          *database.DB
	router             chi.Router
	sessionStore       *auth.SessionStore
	authHandlers       *handlers.AuthHandlers
	migrationHandlers  *handlers.MigrationHandlers
	noteHandlers *handlers.NoteHandlers
	suggestionHandlers *handlers.SuggestionHandlers
	scratchpadHandlers *handlers.ScratchpadHandlers
	variationHandlers    *handlers.VariationHandlers
	taskTypeHandlers     *handlers.TaskTypeHandlers
	noteActionHandlers   *handlers.NoteActionHandlers
	dailyRuleHandlers    *handlers.DailyRuleHandlers
	homeHandlers       *handlers.HomeHandlers
	adminHandlers      *handlers.AdminHandlers

	manuscriptCreateHandlers *handlers.ManuscriptCreateHandlers
	roleHandlers             *handlers.RoleHandlers
}

func NewServer(cfg *config.Config, db *pgxpool.Pool) *Server {
	dbWrapper := &database.DB{Pool: db}
	sessionStore := auth.NewSessionStore(db)

	s := &Server{
		config:       cfg,
		db:           db,
		dbWrapper:    dbWrapper,
		sessionStore: sessionStore,
		authHandlers: &handlers.AuthHandlers{
			DB:           dbWrapper,
			SessionStore: sessionStore,
			IsProduction: cfg.Server.Env == "production",
			Config:       cfg,
		},
		migrationHandlers: &handlers.MigrationHandlers{
			DB:     dbWrapper,
			Config: cfg,
		},
		noteHandlers: &handlers.NoteHandlers{
			DB:           dbWrapper,
			SessionStore: sessionStore,
			Config:       cfg,
		},
		suggestionHandlers: &handlers.SuggestionHandlers{
			DB:           dbWrapper,
			SessionStore: sessionStore,
			Config:       cfg,
		},
		scratchpadHandlers: &handlers.ScratchpadHandlers{
			DB:           dbWrapper,
			SessionStore: sessionStore,
			Config:       cfg,
		},
		variationHandlers: &handlers.VariationHandlers{
			DB:           dbWrapper,
			SessionStore: sessionStore,
			Config:       cfg,
		},
		taskTypeHandlers: &handlers.TaskTypeHandlers{
			DB:           dbWrapper,
			SessionStore: sessionStore,
		},
		noteActionHandlers: &handlers.NoteActionHandlers{
			DB:           dbWrapper,
			SessionStore: sessionStore,
			Config:       cfg,
		},
		dailyRuleHandlers: &handlers.DailyRuleHandlers{
			DB:           dbWrapper,
			SessionStore: sessionStore,
		},
		homeHandlers: &handlers.HomeHandlers{
			DB:           dbWrapper,
			SessionStore: sessionStore,
			Config:       cfg,
		},
		adminHandlers: &handlers.AdminHandlers{
			DB:        dbWrapper,
			Config:    cfg,
			Processor: migrations.NewProcessor(db),
		},
	}
	// The local-mode commit path (suggestions → commit → migrate) reuses the
	// admin handlers' migration queue, as does manuscript creation's
	// bootstrap.
	s.suggestionHandlers.Admin = s.adminHandlers
	s.manuscriptCreateHandlers = &handlers.ManuscriptCreateHandlers{
		DB:           dbWrapper,
		SessionStore: sessionStore,
		Config:       cfg,
		Admin:        s.adminHandlers,
	}
	s.roleHandlers = &handlers.RoleHandlers{
		DB:           dbWrapper,
		SessionStore: sessionStore,
		Config:       cfg,
	}
	s.setupRouter()
	return s
}

func (s *Server) Router() http.Handler {
	return s.router
}

// ResegmentOnSegmenterChange re-migrates manuscripts whose latest migration
// was produced by an older segmenter. Run once at startup, after the DB is
// reachable. Since 037 it is preceded by the registry reconciliation: the
// repos-dir layout migration (flat → git/remote|local) and the upsert of
// legacy config manuscripts into the manuscript table — both idempotent.
func (s *Server) ResegmentOnSegmenterChange(ctx context.Context) {
	handlers.MigrateReposLayout(s.config)
	s.adminHandlers.ReconcileRegistry(ctx)
	s.adminHandlers.ResegmentOnSegmenterChange(ctx)
}

// RunWordcountCron drives the optional wordcount-history feature: one run
// at startup (covers downtime — the day's row appears as soon as the server
// is back), then every configured interval. Rows are keyed by day in the
// configured timezone, so intra-day runs overwrite today's row in place.
// No-op unless wordcount_history.enabled.
func (s *Server) RunWordcountCron(ctx context.Context) {
	if !s.config.WordcountHistory.Enabled {
		return
	}
	interval := time.Duration(s.config.WordcountHistory.IntervalMinutes) * time.Minute
	loc := s.config.WordcountHistory.Location()
	run := func() {
		rows, err := s.dbWrapper.ComputeWordcountHistory(ctx, loc)
		if err != nil {
			log.Printf("wordcount cron failed: %v", err)
			return
		}
		log.Printf("wordcount cron: computed %d manuscript(s)", len(rows))
	}
	run()
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			run()
		}
	}
}

func (s *Server) setupRouter() {
	r := chi.NewRouter()

	// Order matters: RequestID generates the id used by everything after;
	// logctx attaches a per-request slog.Logger available via logctx.LoggerFrom.
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(logctx.Middleware)
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)

	// Cap request bodies so a runaway upload can't OOM the process. Two
	// routes legitimately carry more than the 1MiB default: scratchpad
	// image uploads (10MB files) and scratchpad doc autosaves (4MB JSON).
	// This runs before base-path stripping, so match by suffix/segment.
	const maxRequestBody = 1 << 20 // 1 MiB
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			limit := int64(maxRequestBody)
			if req.Method == http.MethodPost && strings.HasSuffix(req.URL.Path, "/api/scratchpad-images") {
				limit = 11 << 20
			} else if req.Method == http.MethodPut && strings.Contains(req.URL.Path, "/api/scratchpads/") {
				limit = 5 << 20
			}
			req.Body = http.MaxBytesReader(w, req.Body, limit)
			next.ServeHTTP(w, req)
		})
	})

	// HSTS is prod-only; dev runs over plain http://localhost.
	if s.config.Server.Env == "production" {
		r.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				w.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
				next.ServeHTTP(w, req)
			})
		})
	}

	// Strip base_path so internal routes stay root-relative. Must rewrite both
	// req.URL.Path and chi's RoutePath, and handle the exact-match case.
	basePath := s.config.Server.BasePath
	if basePath != "" {
		r.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				p := req.URL.Path
				if p == basePath || strings.HasPrefix(p, basePath+"/") {
					stripped := strings.TrimPrefix(p, basePath)
					if stripped == "" {
						stripped = "/"
					}
					req.URL.Path = stripped
					if rctx := chi.RouteContext(req.Context()); rctx != nil {
						rctx.RoutePath = stripped
					}
				}
				next.ServeHTTP(w, req)
			})
		})
	}

	// Durable request log (payload_log.go): every request, bodies included,
	// into the host-mounted logs dir — placed AFTER the base-path strip so
	// logged paths are root-relative.
	if dir := resolvePayloadLogDir(); dir != "" {
		r.Use(payloadLogMiddleware(dir))
	}

	// /health: legacy alias for /readyz.
	r.Get("/livez", s.livezHandler)
	r.Get("/readyz", s.readyzHandler)
	r.Get("/health", s.readyzHandler)

	r.Route("/api", func(r chi.Router) {
		r.Post("/login", s.authHandlers.HandleLogin)

		r.Group(func(r chi.Router) {
			r.Use(auth.Middleware(s.sessionStore))
			r.Post("/logout", s.authHandlers.HandleLogout)
			r.Get("/session", s.authHandlers.HandleGetSession)
			r.Post("/session/last-manuscript", s.authHandlers.HandleSetLastManuscript)

			r.Get("/migrations", s.migrationHandlers.HandleGetMigrations)
			r.Get("/migrations/latest", s.migrationHandlers.HandleGetLatestMigration)
			r.Get("/migrations/{migration_id}/manuscript", s.migrationHandlers.HandleGetManuscriptByMigration)
			r.Get("/migrations/{migration_id}/history", s.migrationHandlers.HandleGetSentenceHistory)
			r.Get("/migrations/{migration_id}/suggestions", s.suggestionHandlers.HandleGetSuggestionsForMigration)
			r.Get("/migrations/{migration_id}/outline", s.migrationHandlers.HandleGetOutline)
			r.Get("/manuscripts/{manuscript_id}/wordcount-history", s.migrationHandlers.HandleGetWordcountHistory)
			r.Post("/manuscripts", s.manuscriptCreateHandlers.HandleCreateManuscript)
			r.Get("/manuscripts/{manuscript_id}/meta", s.migrationHandlers.HandleGetManuscriptMeta)
			r.Patch("/manuscripts/{manuscript_id}/meta", s.migrationHandlers.HandleUpdateManuscriptMeta)
			r.Get("/roles", s.roleHandlers.HandleGetRolesJSON)
			r.Get("/manuscripts/{manuscript_id}/people", s.roleHandlers.HandleGetPeople)
			r.Put("/manuscripts/{manuscript_id}/people-order", s.roleHandlers.HandlePutPeopleOrder)
			r.Post("/manuscripts/{manuscript_id}/roles", s.roleHandlers.HandleGrantRole)
			r.Delete("/manuscripts/{manuscript_id}/roles", s.roleHandlers.HandleRevokeRole)
			r.Put("/sentences/{sentence_id}/suggestion", s.suggestionHandlers.HandlePutSuggestion)
			r.Delete("/sentences/{sentence_id}/suggestion", s.suggestionHandlers.HandleDeleteSuggestion)
			r.Post("/sentences/{sentence_id}/suggestion/review", s.suggestionHandlers.HandleReviewSuggestion)
			r.Post("/migrations/{migration_id}/accept-own-uncontested", s.suggestionHandlers.HandleAcceptOwnUncontested)
			r.Post("/manuscripts/{manuscript_id}/migrations/{migration_id}/push-suggestions", s.suggestionHandlers.HandlePushSuggestions)
			r.Get("/manuscripts/{manuscript_id}/migrations/{migration_id}/push-state", s.suggestionHandlers.HandleGetPushState)

			// Landing page data + per-user manuscript recency (HOME_PLAN.md).
			r.Get("/home", s.homeHandlers.HandleHome)
			r.Get("/daily-tasks", s.homeHandlers.HandleDailyTasks)
			r.Get("/points-daily", s.homeHandlers.HandleDailyPoints)
			r.Get("/daily-rules", s.dailyRuleHandlers.HandleList)
			r.Post("/daily-rules", s.dailyRuleHandlers.HandleCreate)
			r.Delete("/daily-rules/{rule_id}", s.dailyRuleHandlers.HandleDelete)
			r.Post("/manuscripts/{manuscript_id}/opened", s.homeHandlers.HandleManuscriptOpened)

			// Scratchpads (SCRATCHPAD_PLAN.md): user-owned, not
			// manuscript-scoped. Canonize step 2 lives here; step 1 is the
			// ordinary suggestion PUT.
			r.Get("/scratchpads", s.scratchpadHandlers.HandleList)
			r.Post("/scratchpads", s.scratchpadHandlers.HandleCreate)
			r.Get("/scratchpads/{scratchpad_id}", s.scratchpadHandlers.HandleGet)
			r.Put("/scratchpads/{scratchpad_id}", s.scratchpadHandlers.HandleUpdate)
			r.Put("/scratchpads/{scratchpad_id}/link", s.scratchpadHandlers.HandleLinkScratchpad)
			r.Delete("/scratchpads/{scratchpad_id}", s.scratchpadHandlers.HandleDelete)
			r.Post("/scratchpads/{scratchpad_id}/opened", s.scratchpadHandlers.HandleOpened)
			// Sketches/variations (VARIATIONS_PLAN.md): content lives in
			// rows, the doc carries placements; canonize step 2 is here.
			r.Post("/sketches", s.variationHandlers.HandleCreateSketch)
			r.Put("/sketches/{sketch_id}/link", s.variationHandlers.HandleLinkSketch)
			r.Post("/sketches/{sketch_id}/freeze-all", s.variationHandlers.HandleFreezeAllVariations)
			r.Get("/sketches/{sketch_id}/home", s.variationHandlers.HandleSketchHome)
			r.Post("/sketches/{sketch_id}/place-plan", s.variationHandlers.HandlePlacePlan)
			r.Get("/variations", s.variationHandlers.HandleListVariations)
			// Static path before the {variation_id} pattern so chi doesn't
			// treat "deleted" as an id.
			r.Get("/variations/deleted", s.variationHandlers.HandleListDeletedVariations)
			r.Get("/variations/{variation_id}", s.variationHandlers.HandleGetVariation)
			r.Get("/variations/{variation_id}/home", s.variationHandlers.HandleGetVariationHome)
			r.Put("/variations/{variation_id}", s.variationHandlers.HandleUpdateVariation)
			r.Delete("/variations/{variation_id}", s.variationHandlers.HandleDeleteVariation)
			r.Post("/variations/{variation_id}/restore", s.variationHandlers.HandleRestoreVariation)
			r.Put("/variations/{variation_id}/state", s.variationHandlers.HandleSetVariationState)
			r.Post("/variations/{variation_id}/canonize", s.variationHandlers.HandleCanonizeVariation)
			r.Post("/scratchpad-images", s.scratchpadHandlers.HandleUploadImage)
			r.Get("/scratchpad-images/{image_id}", s.scratchpadHandlers.HandleGetImage)

			r.Get("/notes/id/{note_id}", s.noteHandlers.HandleGetNoteByID)
			r.Get("/notes/sentence/{sentence_id}", s.noteHandlers.HandleGetNotesBySentence)
			r.Get("/notes/{commit_hash}", s.noteHandlers.HandleGetNotesByCommit)
			r.Post("/notes", s.noteHandlers.HandleCreateNote)
			r.Put("/notes/{note_id}", s.noteHandlers.HandleUpdateNote)
			r.Put("/notes/{note_id}/reorder", s.noteHandlers.HandleReorderNote)
			r.Put("/notes/{note_id}/manuscript", s.noteHandlers.HandleLinkNoteManuscript)
			r.Delete("/notes/{note_id}", s.noteHandlers.HandleDeleteNote)
			r.Post("/notes/{note_id}/complete", s.noteHandlers.HandleCompleteNote)
			r.Post("/notes/{note_id}/hide", s.noteHandlers.HandleHideNote)
			r.Post("/notes/{note_id}/unhide", s.noteHandlers.HandleUnhideNote)
			r.Post("/notes/{note_id}/points", s.noteHandlers.HandleScoreNotePoints)

			// Task types (031/032): the settings page's dimension list.
			r.Get("/task-types", s.taskTypeHandlers.HandleList)
			r.Post("/task-types", s.taskTypeHandlers.HandleCreate)
			r.Put("/task-types/order", s.taskTypeHandlers.HandleReorder)
			r.Put("/task-types/{name}/color", s.taskTypeHandlers.HandleSetColor)
			r.Delete("/task-types/{name}", s.taskTypeHandlers.HandleDelete)
			// Note actions (settings audit table) + undos.
			r.Get("/note-actions", s.noteActionHandlers.HandleList)
			r.Put("/note-actions/date", s.noteActionHandlers.HandleSetDate)
			r.Delete("/point-events/{event_id}", s.noteActionHandlers.HandleUnaward)
			r.Put("/point-events/{event_id}", s.noteActionHandlers.HandleEditPoints)
			r.Post("/notes/{note_id}/restore", s.noteActionHandlers.HandleRestore)
			r.Post("/notes/{note_id}/uncomplete", s.noteActionHandlers.HandleUncomplete)

			r.Get("/tag-counts", s.noteHandlers.HandleTagCounts)
			r.Get("/notes/{note_id}/tags", s.noteHandlers.HandleGetTagsForNote)
			r.Post("/notes/{note_id}/tags", s.noteHandlers.HandleAddTagToNote)
			r.Delete("/notes/{note_id}/tags/{tag_id}", s.noteHandlers.HandleRemoveTagFromNote)
		})

		// Admin endpoints rate-limit per Authorization header, or per remote IP
		// for the webhook (which authenticates by signature rather than token).
		rlCfg := ratelimit.DefaultConfig()
		if v := s.config.RateLimits.AdminPerTokenRPM; v > 0 {
			rlCfg.PerKeyRequestsPerMinute = v
		}
		if v := s.config.RateLimits.AdminPerTokenBurst; v > 0 {
			rlCfg.PerKeyBurst = v
		}
		adminLimiter := ratelimit.New(rlCfg)
		adminKey := func(r *http.Request) string {
			if h := r.Header.Get("Authorization"); h != "" {
				return ratelimit.HashAuthHeader(h)
			}
			// Port stripped: with the raw "ip:port" every connection would
			// get its own fresh bucket.
			return ratelimit.HostOnly(r.RemoteAddr)
		}

		r.Route("/admin", func(r chi.Router) {
			r.Use(adminLimiter.Middleware(adminKey))
			r.Post("/webhook", s.adminHandlers.HandleWebhook)
			r.Post("/sync", s.adminHandlers.HandleSync)
			r.Get("/status", s.adminHandlers.HandleStatus)
			r.Post("/users", s.adminHandlers.HandleCreateUser)
			r.Post("/grants", s.adminHandlers.HandleCreateGrant)
			r.Post("/wordcount-compute", s.adminHandlers.HandleWordcountCompute)
		})
	})

	// Static files, last. When base_path is set, inject <base href> so relative
	// URLs resolve under the prefix; skip when empty because an unnecessary
	// <base href="/"> breaks 3rd-party libs like Paged.js.
	r.Get("/*", func(w http.ResponseWriter, req *http.Request) {
		path := req.URL.Path
		// http.ServeFile rejects ".." segments itself, but the ReadFile
		// branch below has no such guard — filepath.Join would happily
		// resolve "/../x.html" above the web root. Reject here so both
		// branches are covered, and root-clean the path before joining as
		// defense-in-depth.
		if containsDotDot(path) {
			http.Error(w, "invalid URL path", http.StatusBadRequest)
			return
		}
		if path == "/" {
			path = "/index.html"
		}
		filePath := filepath.Join("web", filepath.Clean("/"+path))

		// Explicit cache policy end to end (field lesson: 'no-cache' HTML
		// WITHOUT validators + validator-only assets let Firefox serve stale
		// bundles on a normal reload — only a devtools-open reload bypassed).
		//  - HTML: no-store — never cached, every load sees fresh ?v= refs.
		//  - ?v=-busted assets: immutable, cache for a year (the URL changes
		//    when the content does).
		//  - everything else: no-cache (revalidate).
		if strings.HasSuffix(path, ".html") {
			w.Header().Set("Cache-Control", "no-store")
		} else if req.URL.Query().Get("v") != "" {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
		if strings.HasSuffix(path, ".html") && basePath != "" {
			data, err := os.ReadFile(filePath)
			if err != nil {
				http.NotFound(w, req)
				return
			}
			// Defense-in-depth: Config.Validate() already restricts base_path to
			// URL-safe chars, but escape anyway against future loosening.
			baseHref := html.EscapeString(basePath + "/")
			injected := bytes.Replace(
				data,
				[]byte("<head>"),
				[]byte("<head>\n  <base href=\""+baseHref+"\">"),
				1,
			)
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Write(injected)
			return
		}
		http.ServeFile(w, req, filePath)
	})

	s.router = r
}

// containsDotDot reports whether any slash-separated segment of the URL
// path is "..". Mirrors the unexported guard inside http.ServeFile.
func containsDotDot(p string) bool {
	for _, seg := range strings.Split(p, "/") {
		if seg == ".." {
			return true
		}
	}
	return false
}

// Liveness probe: process is up. Does not probe downstreams.
func (s *Server) livezHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"status":"alive"}`))
}

// Readiness probe: 200 if DB pings and all manuscript repos are statable;
// degraded if a repo is missing (first sync will create it); 503 on DB error.
func (s *Server) readyzHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	if err := s.db.Ping(r.Context()); err != nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		w.Write([]byte(`{"status":"unhealthy","database":"disconnected"}`))
		return
	}

	for _, g := range s.config.GitRepos {
		path := s.config.GitRemoteDir(g.Name)
		if _, err := os.Stat(path); err != nil {
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(`{"status":"degraded","database":"connected","repos":"some manuscript repos not yet cloned"}`))
			return
		}
	}

	w.Write([]byte(`{"status":"healthy","database":"connected","repos":"ok"}`))
}
