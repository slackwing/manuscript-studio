package api

import (
	"bytes"
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
	"github.com/slackwing/manuscript-studio/internal/migrations"
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
	sessionStore := auth.NewSessionStore()

	s := &Server{
		config:       cfg,
		db:           db,
		dbWrapper:    dbWrapper,
		sessionStore: sessionStore,
		authHandlers: &handlers.AuthHandlers{
			DB:           dbWrapper,
			SessionStore: sessionStore,
			IsProduction: cfg.Server.Env == "production",
		},
		migrationHandlers: &handlers.MigrationHandlers{
			DB: dbWrapper,
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

	// Middleware
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(middleware.RealIP)
	r.Use(middleware.RequestID)

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

	// Health check (no auth required)
	r.Get("/health", s.healthHandler)

	// API routes (before static files)
	r.Route("/api", func(r chi.Router) {
		// Public auth endpoints
		r.Post("/login", s.authHandlers.HandleLogin)
		r.Get("/users", s.authHandlers.HandleGetUsers)

		// Session-protected endpoints
		r.Group(func(r chi.Router) {
			r.Use(auth.Middleware(s.sessionStore))
			r.Post("/logout", s.authHandlers.HandleLogout)
			r.Get("/session", s.authHandlers.HandleGetSession)

			// Migration endpoints
			r.Get("/migrations", s.migrationHandlers.HandleGetMigrations)
			r.Get("/migrations/latest", s.migrationHandlers.HandleGetLatestMigration)
			r.Get("/migrations/{migration_id}/manuscript", s.migrationHandlers.HandleGetManuscriptByMigration)

			// Annotation endpoints
			r.Get("/annotations/{commit_hash}", s.annotationHandlers.HandleGetAnnotationsByCommit)
			r.Post("/annotations", s.annotationHandlers.HandleCreateAnnotation)
			r.Put("/annotations/{annotation_id}", s.annotationHandlers.HandleUpdateAnnotation)
			r.Delete("/annotations/{annotation_id}", s.annotationHandlers.HandleDeleteAnnotation)
		})

		// Admin endpoints (webhook and system operations)
		r.Route("/admin", func(r chi.Router) {
			r.Post("/webhook", s.adminHandlers.HandleWebhook) // GitHub webhook
			r.Post("/sync", s.adminHandlers.HandleSync)       // Manual sync (requires system token)
			r.Get("/status", s.adminHandlers.HandleStatus)    // Migration status (requires system token)
		})
	})

	// Serve static files from web directory (must be last)
	r.Get("/*", func(w http.ResponseWriter, req *http.Request) {
		path := req.URL.Path
		if path == "/" {
			path = "/index.html"
		}
		filePath := filepath.Join("web", path)

		// Inject <base href> into HTML so relative URLs work under a base path.
		if strings.HasSuffix(path, ".html") {
			data, err := os.ReadFile(filePath)
			if err != nil {
				http.NotFound(w, req)
				return
			}
			baseHref := basePath + "/"
			if baseHref == "/" {
				baseHref = "/"
			}
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

// healthHandler returns server health status
func (s *Server) healthHandler(w http.ResponseWriter, r *http.Request) {
	// Check database connection
	err := s.db.Ping(r.Context())
	if err != nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		w.Write([]byte(`{"status":"unhealthy","database":"disconnected"}`))
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"status":"healthy","database":"connected"}`))
}

