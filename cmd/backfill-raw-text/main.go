// backfill-raw-text rewrites sentence.text for every completed migration of
// a manuscript from the old stripped shape to the new raw-markdown-plus-marker
// shape (see UNIFIED_DATA_SHAPE_PLAN.md). Reads each historical source via
// `git show <commit>:<path>` (no working-tree mutation), re-tokenizes with
// the new TokenizeWithMarkers pass, and updates each row by ordinal.
//
// Sentence IDs stay stable because GenerateSentenceID strips the marker and
// markdown before hashing. Only the text column changes. No FK cascade.
// Idempotent — re-running on already-new-format rows is a no-op (the SQL
// writes the same value).
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os/exec"

	"github.com/slackwing/manuscript-studio/internal/config"
	"github.com/slackwing/manuscript-studio/internal/database"
	"github.com/slackwing/manuscript-studio/internal/sentence"
)

func main() {
	manuscriptName := flag.String("manuscript", "", "manuscript name as configured")
	dryRun := flag.Bool("dry-run", false, "report what would change without writing")
	flag.Parse()

	if *manuscriptName == "" {
		log.Fatal("--manuscript is required")
	}

	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("load config: %v", err)
	}

	var mc *config.ManuscriptConfig
	for i := range cfg.Manuscripts {
		if cfg.Manuscripts[i].Name == *manuscriptName {
			mc = &cfg.Manuscripts[i]
			break
		}
	}
	if mc == nil {
		log.Fatalf("manuscript %q not found in config", *manuscriptName)
	}

	ctx := context.Background()
	pool, err := database.Connect(ctx, cfg.Database)
	if err != nil {
		log.Fatalf("connect db: %v", err)
	}
	defer pool.Close()
	db := &database.DB{Pool: pool}

	cloneURL := mc.Repository.CloneURL()
	manuscript, err := db.GetManuscript(ctx, cloneURL, mc.Repository.Path)
	if err != nil {
		log.Fatalf("look up manuscript: %v", err)
	}
	if manuscript == nil {
		log.Fatalf("manuscript row not found for %s (%s, %s)", mc.Name, cloneURL, mc.Repository.Path)
	}

	repoDir := cfg.RepoPath(mc.Name)

	// Newest-first; reverse so we log in chronological order (cosmetic).
	migs, err := db.GetMigrations(ctx, manuscript.ManuscriptID)
	if err != nil {
		log.Fatalf("list migrations: %v", err)
	}
	for i, j := 0, len(migs)-1; i < j; i, j = i+1, j-1 {
		migs[i], migs[j] = migs[j], migs[i]
	}

	tk := sentence.NewTokenizer()
	totalUpdated := 0
	totalSkipped := 0

	for _, m := range migs {
		source, err := gitShowFile(repoDir, m.CommitHash, mc.Repository.Path)
		if err != nil {
			log.Printf("migration %d (commit %s): git show failed, skipping: %v",
				m.MigrationID, short(m.CommitHash), err)
			totalSkipped++
			continue
		}

		newTexts := tk.TokenizeWithMarkers(source)
		existing, err := db.GetSentencesByMigration(ctx, m.MigrationID)
		if err != nil {
			log.Fatalf("get sentences for migration %d: %v", m.MigrationID, err)
		}

		if len(newTexts) != len(existing) {
			log.Printf("migration %d (commit %s): SEGMENT COUNT MISMATCH (old=%d new=%d); skipping to avoid partial updates",
				m.MigrationID, short(m.CommitHash), len(existing), len(newTexts))
			totalSkipped++
			continue
		}

		updated := 0
		for i, s := range existing {
			newText := newTexts[i]
			if s.Text == newText {
				continue
			}
			if err := sentence.ValidateSentenceText(newText); err != nil {
				log.Fatalf("migration %d ordinal %d: new text fails validation: %v", m.MigrationID, i, err)
			}
			if *dryRun {
				log.Printf("  would update %s (ord %d): %q → %q",
					s.SentenceID, i, truncate(s.Text, 40), truncate(newText, 40))
			} else {
				if err := db.UpdateSentenceText(ctx, s.SentenceID, newText); err != nil {
					log.Fatalf("update sentence %s: %v", s.SentenceID, err)
				}
			}
			updated++
		}
		log.Printf("migration %d (commit %s): %d sentences, %d updated",
			m.MigrationID, short(m.CommitHash), len(existing), updated)
		totalUpdated += updated
	}

	mode := "updated"
	if *dryRun {
		mode = "would update"
	}
	fmt.Printf("done — %s %d sentence rows across %d migrations (%d skipped)\n",
		mode, totalUpdated, len(migs)-totalSkipped, totalSkipped)
}

// gitShowFile reads a file at a given commit via `git show`. Doesn't touch
// the working tree.
func gitShowFile(repoDir, commit, filePath string) (string, error) {
	cmd := exec.Command("git", "-C", repoDir, "show", fmt.Sprintf("%s:%s", commit, filePath))
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return string(out), nil
}

func short(hash string) string {
	if len(hash) <= 8 {
		return hash
	}
	return hash[:8]
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "..."
}
