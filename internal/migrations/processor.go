package migrations

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/slackwing/manuscript-studio/internal/database"
	"github.com/slackwing/manuscript-studio/internal/models"
	"github.com/slackwing/manuscript-studio/internal/sentence"
)

// SegmenterVersion is stamped onto every migration row.
const SegmenterVersion = "segman-1.0.0"

// Processor lifecycle: caller reserves a row with CreatePendingMigration, then
// calls Run, which transitions the row running → done/error before returning.
type Processor struct {
	db               *pgxpool.Pool
	segmenterVersion string
}

func NewProcessor(db *pgxpool.Pool) *Processor {
	return &Processor{db: db, segmenterVersion: SegmenterVersion}
}

func (p *Processor) SegmenterVersion() string { return p.segmenterVersion }

type MigrationResult struct {
	MigrationID         int    `json:"migration_id"`
	Status              string `json:"status"`
	SentenceCount       int    `json:"sentence_count"`
	AdditionsCount      int    `json:"additions_count"`
	DeletionsCount      int    `json:"deletions_count"`
	ChangesCount        int    `json:"changes_count"`
	AnnotationsMigrated int    `json:"annotations_migrated"`
	Message             string `json:"message"`
}

// Run executes migration for an already-pending row and always leaves it at
// 'done' or 'error'. Pass slog.Default() if you have no request-scoped logger.
func (p *Processor) Run(ctx context.Context, log *slog.Logger, migrationID, manuscriptID int, commitHash, branchName, content string) (result *MigrationResult, err error) {
	db := &database.DB{Pool: p.db}
	if log == nil {
		log = slog.Default()
	}
	log = log.With(
		slog.Int("migration_id", migrationID),
		slog.Int("manuscript_id", manuscriptID),
		slog.String("commit", commitHash),
	)

	if err := db.MarkMigrationRunning(ctx, migrationID); err != nil {
		return nil, err
	}

	defer func() {
		if err != nil {
			if mErr := db.MarkMigrationError(context.Background(), migrationID, err.Error()); mErr != nil {
				log.Warn("failed to record migration error on row", slog.Any("err", mErr))
			}
		}
	}()

	newSentences, newSentenceIDs, newSentenceMap := segmentContent(content, commitHash, migrationID)

	parent, err := db.GetLatestMigration(ctx, manuscriptID)
	if err != nil {
		return nil, fmt.Errorf("get latest migration: %w", err)
	}

	if parent == nil {
		return p.bootstrap(ctx, db, log, migrationID, manuscriptID, commitHash, branchName, newSentences, newSentenceIDs)
	}
	log.Info("processor: migrating from prior",
		slog.Int("parent_migration_id", parent.MigrationID),
		slog.String("parent_commit", parent.CommitHash),
	)
	return p.migrate(ctx, db, log, migrationID, manuscriptID, commitHash, branchName, parent, newSentences, newSentenceIDs, newSentenceMap)
}

// bootstrap handles the very first commit: every sentence is "added", no
// annotations to carry forward.
func (p *Processor) bootstrap(ctx context.Context, db *database.DB, log *slog.Logger, migrationID, manuscriptID int, commitHash, branchName string, newSentences []models.Sentence, newSentenceIDs []string) (*MigrationResult, error) {
	log.Info("bootstrap: segmented manuscript", slog.Int("sentences", len(newSentences)))

	if err := db.CreateSentences(ctx, newSentences); err != nil {
		return nil, fmt.Errorf("store sentences: %w", err)
	}

	if err := db.MarkMigrationDone(ctx, &models.Migration{
		MigrationID:     migrationID,
		ManuscriptID:    manuscriptID,
		CommitHash:      commitHash,
		Segmenter:       p.segmenterVersion,
		BranchName:      branchName,
		SentenceCount:   len(newSentences),
		AdditionsCount:  len(newSentences),
		SentenceIDArray: newSentenceIDs,
	}); err != nil {
		return nil, fmt.Errorf("mark migration done: %w", err)
	}

	log.Info("bootstrap complete", slog.Int("sentences", len(newSentences)))
	return &MigrationResult{
		MigrationID:    migrationID,
		Status:         "bootstrap_complete",
		SentenceCount:  len(newSentences),
		AdditionsCount: len(newSentences),
		Message:        fmt.Sprintf("Bootstrap complete: %d sentences", len(newSentences)),
	}, nil
}

// migrate handles a commit with a prior migration to carry annotations from.
func (p *Processor) migrate(ctx context.Context, db *database.DB, log *slog.Logger, migrationID, manuscriptID int, commitHash, branchName string, parent *models.Migration, newSentences []models.Sentence, newSentenceIDs []string, newSentenceMap map[string]string) (*MigrationResult, error) {
	oldSentences, err := db.GetSentencesByMigration(ctx, parent.MigrationID)
	if err != nil {
		return nil, fmt.Errorf("get old sentences: %w", err)
	}
	oldSentenceMap := make(map[string]string, len(oldSentences))
	for _, s := range oldSentences {
		oldSentenceMap[s.SentenceID] = s.Text
	}

	diff := sentence.ComputeSentenceDiff(oldSentenceMap, newSentenceMap)
	plan := planMigration(oldSentences, sentence.ComputeMigrationMap(diff))

	log.Info("migrate: segmented and diffed",
		slog.Int("old_sentences", len(oldSentences)),
		slog.Int("new_sentences", len(newSentences)),
		slog.Int("added", len(diff.Added)),
		slog.Int("deleted", len(diff.Deleted)),
		slog.Int("unchanged", len(diff.Unchanged)),
		slog.Int("mapped", len(plan)),
	)

	// Decorate new sentences with their previous_sentence_id so the history
	// endpoint can walk the chain. Pick the highest-confidence pairing per new
	// sentence — fallbacks (confidence 0) lose to real matches.
	prev := bestPreviousByNew(plan)
	for i := range newSentences {
		if pid, ok := prev[newSentences[i].SentenceID]; ok {
			pidCopy := pid
			newSentences[i].PreviousSentenceID = &pidCopy
		}
	}

	if err := db.CreateSentences(ctx, newSentences); err != nil {
		return nil, fmt.Errorf("store new sentences: %w", err)
	}

	// Must run before MarkMigrationDone: on failure, the deferred MarkMigrationError
	// flips the row to 'error' so the new sentence rows stay tied to a non-done
	// migration_id and won't be selected as "current".
	annotationsMigrated, err := p.migrateAnnotations(ctx, db, log, plan)
	if err != nil {
		return nil, fmt.Errorf("annotation migration: %w", err)
	}

	parentID := parent.MigrationID
	if err := db.MarkMigrationDone(ctx, &models.Migration{
		MigrationID:       migrationID,
		ManuscriptID:      manuscriptID,
		CommitHash:        commitHash,
		Segmenter:         p.segmenterVersion,
		ParentMigrationID: &parentID,
		BranchName:        branchName,
		SentenceCount:     len(newSentences),
		AdditionsCount:    len(diff.Added),
		DeletionsCount:    len(diff.Deleted),
		ChangesCount:      len(diff.Deleted),
		SentenceIDArray:   newSentenceIDs,
	}); err != nil {
		return nil, fmt.Errorf("mark migration done: %w", err)
	}

	log.Info("migrate complete",
		slog.Int("sentences", len(newSentences)),
		slog.Int("annotations_migrated", annotationsMigrated),
	)
	return &MigrationResult{
		MigrationID:         migrationID,
		Status:              "migration_complete",
		SentenceCount:       len(newSentences),
		AdditionsCount:      len(diff.Added),
		DeletionsCount:      len(diff.Deleted),
		ChangesCount:        len(diff.Deleted),
		AnnotationsMigrated: annotationsMigrated,
		Message:             fmt.Sprintf("Migration complete: %d sentences, %d annotations migrated", len(newSentences), annotationsMigrated),
	}, nil
}

// migrateAnnotations runs the planned moves in a single all-or-nothing tx.
func (p *Processor) migrateAnnotations(ctx context.Context, db *database.DB, log *slog.Logger, plan map[string]plannedMove) (int, error) {
	var items []database.AnnotationMigrationItem
	sources := 0
	for oldID, move := range plan {
		annots, err := db.GetActiveAnnotationsForSentence(ctx, oldID)
		if err != nil {
			return 0, fmt.Errorf("get annotations for %s: %w", oldID, err)
		}
		if len(annots) == 0 {
			continue
		}
		sources++
		for _, a := range annots {
			items = append(items, database.AnnotationMigrationItem{
				AnnotationID:  a.AnnotationID,
				NewSentenceID: move.NewSentenceID,
				Confidence:    move.Confidence,
			})
		}
	}

	if len(items) == 0 {
		log.Info("no annotations needed migration")
		return 0, nil
	}
	log.Info("migrating annotations",
		slog.Int("annotations", len(items)),
		slog.Int("source_sentences", sources),
	)
	migrated, err := db.MigrateAnnotations(ctx, items)
	if err != nil {
		return 0, fmt.Errorf("atomic write rolled back: %w", err)
	}
	log.Info("annotation migration committed", slog.Int("migrated", migrated))
	return migrated, nil
}

// plannedMove: where annotations on a given old sentence should land.
type plannedMove struct {
	NewSentenceID string
	Confidence    float64
}

// RecomputePreviousByNew runs the live migration's pairing logic against two
// sentence sets and returns newID → bestOldID. Used by the backfill CLI so
// historical migrations get the same answer as fresh ones.
func RecomputePreviousByNew(oldSentences, newSentences []models.Sentence) map[string]string {
	oldMap := make(map[string]string, len(oldSentences))
	for _, s := range oldSentences {
		oldMap[s.SentenceID] = s.Text
	}
	newMap := make(map[string]string, len(newSentences))
	for _, s := range newSentences {
		newMap[s.SentenceID] = s.Text
	}
	diff := sentence.ComputeSentenceDiff(oldMap, newMap)
	plan := planMigration(oldSentences, sentence.ComputeMigrationMap(diff))
	return bestPreviousByNew(plan)
}

// bestPreviousByNew inverts the plan into newID → oldID, choosing the
// highest-confidence old sentence when several point at the same new one.
// Used to set previous_sentence_id at sentence-write time.
func bestPreviousByNew(plan map[string]plannedMove) map[string]string {
	type pick struct {
		oldID      string
		confidence float64
	}
	best := make(map[string]pick, len(plan))
	for oldID, move := range plan {
		if move.NewSentenceID == "" {
			continue
		}
		cur, exists := best[move.NewSentenceID]
		if !exists || move.Confidence > cur.confidence {
			best[move.NewSentenceID] = pick{oldID: oldID, confidence: move.Confidence}
		}
	}
	out := make(map[string]string, len(best))
	for newID, p := range best {
		out[newID] = p.oldID
	}
	return out
}

// planMigration resolves the old→new sentence map, filling matcher gaps by
// forward-fallback (orphans inherit the next mapped sentence's target) then
// backward-fallback for orphans after the last mapped sentence.
// Confidence is the matcher's similarity for real matches, 0 for fallbacks.
func planMigration(oldSentences []models.Sentence, matches []sentence.SentenceMatch) map[string]plannedMove {
	plan := make(map[string]plannedMove, len(oldSentences))
	for _, m := range matches {
		if m.NewSentenceID != "" {
			plan[m.OldSentenceID] = plannedMove{NewSentenceID: m.NewSentenceID, Confidence: m.Similarity}
		}
	}

	var awaitingForwardFallback []string
	var lastMappedTarget string
	for _, s := range oldSentences {
		if move, ok := plan[s.SentenceID]; ok {
			for _, p := range awaitingForwardFallback {
				plan[p] = plannedMove{NewSentenceID: move.NewSentenceID, Confidence: 0}
			}
			awaitingForwardFallback = nil
			lastMappedTarget = move.NewSentenceID
			continue
		}
		awaitingForwardFallback = append(awaitingForwardFallback, s.SentenceID)
	}
	if lastMappedTarget != "" {
		for _, p := range awaitingForwardFallback {
			plan[p] = plannedMove{NewSentenceID: lastMappedTarget, Confidence: 0}
		}
	}
	return plan
}

// segmentContent returns sentences ready for db.CreateSentences (migration_id
// stamped), the parallel id slice in document order, and an id→text map for
// diffing. Shared between bootstrap and migrate to prevent drift.
func segmentContent(content, commitHash string, migrationID int) ([]models.Sentence, []string, map[string]string) {
	tokenizer := sentence.NewTokenizer()
	texts := tokenizer.SplitIntoSentences(content)

	sentences := make([]models.Sentence, len(texts))
	ids := make([]string, len(texts))
	textByID := make(map[string]string, len(texts))

	for i, t := range texts {
		id := sentence.GenerateSentenceID(t, i, commitHash)
		ids[i] = id
		textByID[id] = t
		sentences[i] = models.Sentence{
			SentenceID:  id,
			MigrationID: migrationID,
			CommitHash:  commitHash,
			Text:        t,
			WordCount:   sentence.CountWords(t),
			Ordinal:     i,
		}
	}
	return sentences, ids, textByID
}
