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

type Server struct {
	config              *config.Config
	db                  *pgxpool.Pool
	dbWrapper           *database.DB
	router              chi.Router
	sessionStore        *auth.SessionStore
	authHandlers        *handlers.AuthHandlers
	migrationHandlers   *handlers.MigrationHandlers
	annotationHandlers  *handlers.AnnotationHandlers
	suggestionHandlers  *handlers.SuggestionHandlers
	adminHandlers       *handlers.AdminHandlers
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
		annotationHandlers: &handlers.AnnotationHandlers{
			DB:           dbWrapper,
			SessionStore: sessionStore,
		},
		suggestionHandlers: &handlers.SuggestionHandlers{
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

func (s *Server) Router() http.Handler {
	return s.router
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

	// Cap request bodies so a runaway upload can't OOM the process.
	const maxRequestBody = 1 << 20 // 1 MiB
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			req.Body = http.MaxBytesReader(w, req.Body, maxRequestBody)
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

	// /health: legacy alias for /readyz.
	r.Get("/livez", s.livezHandler)
	r.Get("/readyz", s.readyzHandler)
	r.Get("/health", s.readyzHandler)

	r.Route("/api", func(r chi.Router) {
		r.Post("/login", s.authHandlers.HandleLogin)
		r.Get("/users", s.authHandlers.HandleGetUsers)
		r.Get("/manuscripts", s.authHandlers.HandleGetManuscripts)

		r.Group(func(r chi.Router) {
			r.Use(auth.Middleware(s.sessionStore))
			r.Post("/logout", s.authHandlers.HandleLogout)
			r.Get("/session", s.authHandlers.HandleGetSession)

			r.Get("/migrations", s.migrationHandlers.HandleGetMigrations)
			r.Get("/migrations/latest", s.migrationHandlers.HandleGetLatestMigration)
			r.Get("/migrations/{migration_id}/manuscript", s.migrationHandlers.HandleGetManuscriptByMigration)
			r.Get("/migrations/{migration_id}/history", s.migrationHandlers.HandleGetSentenceHistory)
			r.Get("/migrations/{migration_id}/suggestions", s.suggestionHandlers.HandleGetSuggestionsForMigration)
			r.Put("/sentences/{sentence_id}/suggestion", s.suggestionHandlers.HandlePutSuggestion)
			r.Delete("/sentences/{sentence_id}/suggestion", s.suggestionHandlers.HandleDeleteSuggestion)

			r.Get("/annotations/{commit_hash}", s.annotationHandlers.HandleGetAnnotationsByCommit)
			r.Get("/annotations/sentence/{sentence_id}", s.annotationHandlers.HandleGetAnnotationsBySentence)
			r.Post("/annotations", s.annotationHandlers.HandleCreateAnnotation)
			r.Put("/annotations/{annotation_id}", s.annotationHandlers.HandleUpdateAnnotation)
			r.Put("/annotations/{annotation_id}/reorder", s.annotationHandlers.HandleReorderAnnotation)
			r.Delete("/annotations/{annotation_id}", s.annotationHandlers.HandleDeleteAnnotation)
			r.Post("/annotations/{annotation_id}/complete", s.annotationHandlers.HandleCompleteAnnotation)

			r.Get("/annotations/{annotation_id}/tags", s.annotationHandlers.HandleGetTagsForAnnotation)
			r.Post("/annotations/{annotation_id}/tags", s.annotationHandlers.HandleAddTagToAnnotation)
			r.Delete("/annotations/{annotation_id}/tags/{tag_id}", s.annotationHandlers.HandleRemoveTagFromAnnotation)
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
			return r.RemoteAddr
		}

		r.Route("/admin", func(r chi.Router) {
			r.Use(adminLimiter.Middleware(adminKey))
			r.Post("/webhook", s.adminHandlers.HandleWebhook)
			r.Post("/sync", s.adminHandlers.HandleSync)
			r.Get("/status", s.adminHandlers.HandleStatus)
			r.Post("/users", s.adminHandlers.HandleCreateUser)
			r.Post("/grants", s.adminHandlers.HandleCreateGrant)
		})
	})

	// Static files, last. When base_path is set, inject <base href> so relative
	// URLs resolve under the prefix; skip when empty because an unnecessary
	// <base href="/"> breaks 3rd-party libs like Paged.js.
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

	for _, m := range s.config.Manuscripts {
		path := s.config.RepoPath(m.Name)
		if _, err := os.Stat(path); err != nil {
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(`{"status":"degraded","database":"connected","repos":"some manuscript repos not yet cloned"}`))
			return
		}
	}

	w.Write([]byte(`{"status":"healthy","database":"connected","repos":"ok"}`))
}

