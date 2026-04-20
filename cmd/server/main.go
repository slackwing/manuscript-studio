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
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("Failed to load configuration: %v", err)
	}

	// JSON in production (log aggregators); text in dev (readable). Stdlib
	// `log` is routed through slog so existing log.Printf calls keep working.
	var handler slog.Handler
	if cfg.Server.Env == "production" {
		handler = slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo})
	} else {
		handler = slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelDebug})
	}
	slog.SetDefault(slog.New(handler))
	log.SetFlags(0)
	log.SetOutput(slogWriter{})

	ctx := context.Background()
	db, err := database.Connect(ctx, cfg.Database)
	if err != nil {
		log.Fatalf("Failed to connect to database: %v", err)
	}
	defer db.Close()

	// Mark pending/running migrations from a crashed prior process as 'error'
	// so the next request can proceed and operators can see what happened.
	{
		dbWrapper := &database.DB{Pool: db}
		recovered, err := dbWrapper.RecoverInterruptedMigrations(ctx)
		if err != nil {
			log.Printf("warning: failed to recover interrupted migrations: %v", err)
		} else if recovered > 0 {
			log.Printf("recovered %d interrupted migration(s) at startup", recovered)
		}
	}

	server := api.NewServer(cfg, db)

	httpServer := &http.Server{
		Addr:         fmt.Sprintf("%s:%d", cfg.Server.Host, cfg.Server.Port),
		Handler:      server.Router(),
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	go func() {
		log.Printf("Starting Manuscript Studio server on %s", httpServer.Addr)
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Failed to start server: %v", err)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Println("Shutting down server...")

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := httpServer.Shutdown(ctx); err != nil {
		log.Fatalf("Server forced to shutdown: %v", err)
	}

	log.Println("Server shutdown complete")
}

// slogWriter adapts the io.Writer used by stdlib `log` into slog records at INFO.
type slogWriter struct{}

func (slogWriter) Write(p []byte) (int, error) {
	msg := string(p)
	if n := len(msg); n > 0 && msg[n-1] == '\n' {
		msg = msg[:n-1]
	}
	slog.Info(msg)
	return len(p), nil
}