// backfill-prev-sentence walks every adjacent pair of completed migrations
// for a single manuscript and populates sentence.previous_sentence_id by
// re-running the same pairing logic the live migration processor uses.
// Idempotent; unreachable pairings stay NULL (history feature degrades cleanly).
package main

import (
	"context"
	"flag"
	"fmt"
	"log"

	"github.com/slackwing/manuscript-studio/internal/config"
	"github.com/slackwing/manuscript-studio/internal/database"
	"github.com/slackwing/manuscript-studio/internal/migrations"
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

	// Newest-first; reverse for chronological pairing.
	migs, err := db.GetMigrations(ctx, manuscript.ManuscriptID)
	if err != nil {
		log.Fatalf("list migrations: %v", err)
	}
	if len(migs) < 2 {
		log.Printf("manuscript has %d completed migrations — nothing to pair", len(migs))
		return
	}
	for i, j := 0, len(migs)-1; i < j; i, j = i+1, j-1 {
		migs[i], migs[j] = migs[j], migs[i]
	}

	totalUpdated := 0
	for i := 1; i < len(migs); i++ {
		parent := migs[i-1]
		current := migs[i]

		oldSentences, err := db.GetSentencesByMigration(ctx, parent.MigrationID)
		if err != nil {
			log.Printf("skip pair %d→%d: get old: %v", parent.MigrationID, current.MigrationID, err)
			continue
		}
		newSentences, err := db.GetSentencesByMigration(ctx, current.MigrationID)
		if err != nil {
			log.Printf("skip pair %d→%d: get new: %v", parent.MigrationID, current.MigrationID, err)
			continue
		}

		previousByNew := migrations.RecomputePreviousByNew(oldSentences, newSentences)

		updated := 0
		for _, s := range newSentences {
			pid, ok := previousByNew[s.SentenceID]
			var newVal *string
			if ok {
				v := pid
				newVal = &v
			}
			if equalStrPtr(s.PreviousSentenceID, newVal) {
				continue
			}
			if *dryRun {
				log.Printf("  would update %s: %v → %v", s.SentenceID, derefStr(s.PreviousSentenceID), derefStr(newVal))
			} else {
				if err := db.SetPreviousSentenceID(ctx, s.SentenceID, newVal); err != nil {
					log.Printf("  update %s failed: %v", s.SentenceID, err)
					continue
				}
			}
			updated++
		}

		log.Printf("pair %d→%d: %d sentences, %d updated", parent.MigrationID, current.MigrationID, len(newSentences), updated)
		totalUpdated += updated
	}

	mode := "updated"
	if *dryRun {
		mode = "would update"
	}
	fmt.Printf("done — %s %d previous_sentence_id values across %d migration pairs\n", mode, totalUpdated, len(migs)-1)
}

func equalStrPtr(a, b *string) bool {
	if a == nil && b == nil {
		return true
	}
	if a == nil || b == nil {
		return false
	}
	return *a == *b
}

func derefStr(s *string) string {
	if s == nil {
		return "<nil>"
	}
	return *s
}
