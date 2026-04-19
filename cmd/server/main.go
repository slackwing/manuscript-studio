package main

import (
	"context"
	"fmt"
	"log"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/slackwing/manuscript-studio/api"
	"github.com/slackwing/manuscript-studio/internal/config"
	"github.com/slackwing/manuscript-studio/internal/database"
)

func main() {
	// Load configuration
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("Failed to load configuration: %v", err)
	}

	// Install slog as the global logger. JSON in production (greppable,
	// pipeable into log aggregators), text in dev (readable). The standard
	// `log` package is routed through slog so existing log.Printf calls
	// keep working while we migrate them piecemeal.
	var handler slog.Handler
	if cfg.Server.Env == "production" {
		handler = slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo})
	} else {
		handler = slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelDebug})
	}
	slog.SetDefault(slog.New(handler))
	log.SetFlags(0)
	log.SetOutput(slogWriter{})

	// Connect to database
	ctx := context.Background()
	db, err := database.Connect(ctx, cfg.Database)
	if err != nil {
		log.Fatalf("Failed to connect to database: %v", err)
	}
	defer db.Close()

	// Recover any migration rows left in pending/running by a previous
	// process — those goroutines are gone, so the rows are stuck. Mark
	// them 'error' so the next request can proceed and operators can see
	// what happened.
	{
		dbWrapper := &database.DB{Pool: db}
		recovered, err := dbWrapper.RecoverInterruptedMigrations(ctx)
		if err != nil {
			log.Printf("warning: failed to recover interrupted migrations: %v", err)
		} else if recovered > 0 {
			log.Printf("recovered %d interrupted migration(s) at startup", recovered)
		}
	}

	// Create API server
	server := api.NewServer(cfg, db)

	// Create HTTP server
	httpServer := &http.Server{
		Addr:         fmt.Sprintf("%s:%d", cfg.Server.Host, cfg.Server.Port),
		Handler:      server.Router(),
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// Start server in goroutine
	go func() {
		log.Printf("Starting Manuscript Studio server on %s", httpServer.Addr)
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Failed to start server: %v", err)
		}
	}()

	// Wait for interrupt signal to gracefully shutdown the server
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Println("Shutting down server...")

	// Graceful shutdown with timeout
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := httpServer.Shutdown(ctx); err != nil {
		log.Fatalf("Server forced to shutdown: %v", err)
	}

	log.Println("Server shutdown complete")
}

// slogWriter adapts io.Writer (used by stdlib `log`) to slog. Each Write
// becomes one slog record at INFO. We strip the trailing newline that
// `log` always appends.
type slogWriter struct{}

func (slogWriter) Write(p []byte) (int, error) {
	msg := string(p)
	if n := len(msg); n > 0 && msg[n-1] == '\n' {
		msg = msg[:n-1]
	}
	slog.Info(msg)
	return len(p), nil
}