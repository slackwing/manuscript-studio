package api

import (
	"bytes"
	"html"
	"net/http"
	"os"
	"path/filepath"
	"strings"

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

// Server represents the API server
type Server struct {
	config              *config.Config
	db                  *pgxpool.Pool
	dbWrapper           *database.DB
	router              chi.Router
	sessionStore        *auth.SessionStore
	authHandlers        *handlers.AuthHandlers
	migrationHandlers   *handlers.MigrationHandlers
	annotationHandlers  *handlers.AnnotationHandlers
	adminHandlers       *handlers.AdminHandlers
}

// NewServer creates a new API server
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
		annotationHandlers: &handlers.AnnotationHandlers{
			DB:           dbWrapper,
			SessionStore: sessionStore,
		},
		adminHandlers: &handlers.AdminHandlers{
			DB:        dbWrapper,
			Config:    cfg,
			Processor: migrations.NewProcessor(db),
		},
	}
	s.setupRouter()
	return s
}

// Router returns the HTTP handler
func (s *Server) Router() http.Handler {
	return s.router
}

// setupRouter configures all routes
func (s *Server) setupRouter() {
	r := chi.NewRouter()

	// Middleware. Order matters:
	// - RequestID generates the id used by everything after.
	// - logctx.Middleware attaches a per-request slog.Logger that handlers
	//   can pull via logctx.LoggerFrom(ctx).
	// - middleware.Logger writes the chi access log line; we keep it for
	//   now, but the structured handler logs are what you want for queries.
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(logctx.Middleware)
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)

	// Cap request bodies globally so a runaway upload can't OOM the
	// process. Annotation creates and admin POSTs are all small JSON
	// payloads — 1 MiB is generous. Per-route overrides can wrap the
	// handler in http.MaxBytesHandler if a higher cap is ever needed.
	const maxRequestBody = 1 << 20 // 1 MiB
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			req.Body = http.MaxBytesReader(w, req.Body, maxRequestBody)
			next.ServeHTTP(w, req)
		})
	})

	// In production, advertise HSTS so browsers refuse to talk plain HTTP.
	// Skipped in dev because dev runs on http://localhost.
	if s.config.Server.Env == "production" {
		r.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				w.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
				next.ServeHTTP(w, req)
			})
		})
	}

	// Strip base path prefix so internal routes are always root-relative.
	// Must rewrite both req.URL.Path AND chi's RoutePath, and handle the
	// exact-match case (e.g. "/manuscripts" with no trailing slash).
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

	// Health checks (no auth required).
	//
	// /livez: cheap probe — succeeds if the process is running. Use as
	//   the Docker liveness probe.
	// /readyz: deep probe — verifies the DB is reachable and that every
	//   configured manuscript repo path is readable. Use as the readiness
	//   probe; failing means we shouldn't get traffic yet.
	// /health: legacy alias for /readyz (kept so existing scripts keep working).
	r.Get("/livez", s.livezHandler)
	r.Get("/readyz", s.readyzHandler)
	r.Get("/health", s.readyzHandler)

	// API routes (before static files)
	r.Route("/api", func(r chi.Router) {
		// Public auth endpoints
		r.Post("/login", s.authHandlers.HandleLogin)
		r.Get("/users", s.authHandlers.HandleGetUsers)
		r.Get("/manuscripts", s.authHandlers.HandleGetManuscripts)

		// Session-protected endpoints
		r.Group(func(r chi.Router) {
			r.Use(auth.Middleware(s.sessionStore))
			r.Post("/logout", s.authHandlers.HandleLogout)
			r.Get("/session", s.authHandlers.HandleGetSession)

			// Migration endpoints
			r.Get("/migrations", s.migrationHandlers.HandleGetMigrations)
			r.Get("/migrations/latest", s.migrationHandlers.HandleGetLatestMigration)
			r.Get("/migrations/{migration_id}/manuscript", s.migrationHandlers.HandleGetManuscriptByMigration)

			// Annotation endpoints (ported from 14.writesys)
			r.Get("/annotations/{commit_hash}", s.annotationHandlers.HandleGetAnnotationsByCommit)
			r.Get("/annotations/sentence/{sentence_id}", s.annotationHandlers.HandleGetAnnotationsBySentence)
			r.Post("/annotations", s.annotationHandlers.HandleCreateAnnotation)
			r.Put("/annotations/{annotation_id}", s.annotationHandlers.HandleUpdateAnnotation)
			r.Put("/annotations/{annotation_id}/reorder", s.annotationHandlers.HandleReorderAnnotation)
			r.Delete("/annotations/{annotation_id}", s.annotationHandlers.HandleDeleteAnnotation)

			// Tag endpoints
			r.Get("/annotations/{annotation_id}/tags", s.annotationHandlers.HandleGetTagsForAnnotation)
			r.Post("/annotations/{annotation_id}/tags", s.annotationHandlers.HandleAddTagToAnnotation)
			r.Delete("/annotations/{annotation_id}/tags/{tag_id}", s.annotationHandlers.HandleRemoveTagFromAnnotation)
		})

		// Admin endpoints (webhook and system operations).
		// Rate-limited per Authorization header (or remote IP for the
		// webhook, which authenticates via signature instead of token).
		// Defaults: 10 rpm/key with burst 5; configurable via rate_limits.
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
			return r.RemoteAddr
		}

		r.Route("/admin", func(r chi.Router) {
			r.Use(adminLimiter.Middleware(adminKey))
			r.Post("/webhook", s.adminHandlers.HandleWebhook)       // GitHub webhook
			r.Post("/sync", s.adminHandlers.HandleSync)             // Manual sync (requires system token)
			r.Get("/status", s.adminHandlers.HandleStatus)          // Migration status (requires system token)
			r.Post("/users", s.adminHandlers.HandleCreateUser)      // Create/update user (requires system token)
			r.Post("/grants", s.adminHandlers.HandleCreateGrant)    // Grant manuscript access (requires system token)
		})
	})

	// Serve static files from web directory (must be last).
	// When base_path is non-empty, inject a <base href="..."> tag so relative
	// URLs in the page (our html/js use relative paths) resolve under the prefix.
	// When base_path is empty (root hosting or local dev), skip injection —
	// an unnecessary <base href="/"> can confuse 3rd-party libraries like Paged.js.
	r.Get("/*", func(w http.ResponseWriter, req *http.Request) {
		path := req.URL.Path
		if path == "/" {
			path = "/index.html"
		}
		filePath := filepath.Join("web", path)

		if strings.HasSuffix(path, ".html") && basePath != "" {
			data, err := os.ReadFile(filePath)
			if err != nil {
				http.NotFound(w, req)
				return
			}
			// HTML-escape defensively. Config.Validate() already restricts
			// base_path to URL-safe characters, but the escape ensures any
			// future loosening (or a hand-edited deployment config that
			// bypasses validation) can't inject attributes.
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

// livezHandler is a minimal liveness probe — if this responds, the process
// is up. Does NOT check downstreams; that's what /readyz is for.
func (s *Server) livezHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"status":"alive"}`))
}

// readyzHandler is a readiness probe — succeeds only when the server is
// genuinely ready to handle traffic. Verifies:
//   - DB is reachable (Ping)
//   - every configured manuscript repo path exists / is statable
// Returns 503 with details on the first failure.
func (s *Server) readyzHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	if err := s.db.Ping(r.Context()); err != nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		w.Write([]byte(`{"status":"unhealthy","database":"disconnected"}`))
		return
	}

	for _, m := range s.config.Manuscripts {
		path := s.config.RepoPath(m.Name)
		if _, err := os.Stat(path); err != nil {
			// Missing repo isn't a hard failure — the first sync will
			// create it. Report degraded so operators can investigate.
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(`{"status":"degraded","database":"connected","repos":"some manuscript repos not yet cloned"}`))
			return
		}
	}

	w.Write([]byte(`{"status":"healthy","database":"connected","repos":"ok"}`))
}

