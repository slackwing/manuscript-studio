package main

import (
	"context"
	"log"

	"github.com/slackwing/manuscript-studio/internal/auth"
	"github.com/slackwing/manuscript-studio/internal/config"
	"github.com/slackwing/manuscript-studio/internal/database"
)

// admin-upsert reads config, bcrypts the admin password, upserts the admin
// user into the "user" table, and grants access to every manuscript defined
// in config. Idempotent: updates password hash if changed, inserts access
// rows that don't exist, leaves existing ones alone.
func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("Failed to load configuration: %v", err)
	}

	if cfg.Auth.AdminUsername == "" || cfg.Auth.AdminPassword == "" {
		log.Fatalf("auth.admin_username and auth.admin_password must be set in config")
	}
	if err := auth.ValidatePassword(cfg.Auth.AdminPassword); err != nil {
		log.Fatalf("auth.admin_password: %v", err)
	}

	ctx := context.Background()
	pool, err := database.Connect(ctx, cfg.Database)
	if err != nil {
		log.Fatalf("Failed to connect to database: %v", err)
	}
	defer pool.Close()

	hash, err := auth.HashPassword(cfg.Auth.AdminPassword)
	if err != nil {
		log.Fatalf("Failed to hash admin password: %v", err)
	}

	upsertUser := `
		INSERT INTO "user" (username, password_hash, role)
		VALUES ($1, $2, 'author')
		ON CONFLICT (username) DO UPDATE
		    SET password_hash = EXCLUDED.password_hash
	`
	if _, err := pool.Exec(ctx, upsertUser, cfg.Auth.AdminUsername, hash); err != nil {
		log.Fatalf("Failed to upsert admin user: %v", err)
	}
	log.Printf("Upserted admin user: %s", cfg.Auth.AdminUsername)

	grantAccess := `
		INSERT INTO manuscript_access (username, manuscript_name)
		VALUES ($1, $2)
		ON CONFLICT (username, manuscript_name) DO NOTHING
	`
	for _, m := range cfg.Manuscripts {
		if _, err := pool.Exec(ctx, grantAccess, cfg.Auth.AdminUsername, m.Name); err != nil {
			log.Fatalf("Failed to grant admin access to %s: %v", m.Name, err)
		}
		log.Printf("Granted %s access to manuscript: %s", cfg.Auth.AdminUsername, m.Name)
	}
}
