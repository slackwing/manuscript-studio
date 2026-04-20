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

// SegmenterVersion is the segmenter version stamped onto every migration row.
const SegmenterVersion = "segman-1.0.0"

// Processor handles manuscript migration processing.
//
// Lifecycle:
//   1. Caller calls db.CreatePendingMigration(...) to reserve a row.
//   2. Caller invokes Processor.Run(ctx, log, migrationID, ...).
//   3. Run marks the row 'running', does the work, then writes 'done'
//      (with results) or 'error' (with message) before returning.
type Processor struct {
	db               *pgxpool.Pool
	segmenterVersion string
}

func NewProcessor(db *pgxpool.Pool) *Processor {
	return &Processor{db: db, segmenterVersion: SegmenterVersion}
}

func (p *Processor) SegmenterVersion() string { return p.segmenterVersion }

// MigrationResult is the summary returned to the caller on success.
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

// Run executes the migration for an already-inserted pending row. The row
// will end up at status='done' or status='error' regardless of whether
// this returns a non-nil error.
//
// Pass slog.Default() for log if you don't have a request-scoped one.
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

	// On any failure below, record the error message on the row.
	defer func() {
		if err != nil {
			if mErr := db.MarkMigrationError(context.Background(), migrationID, err.Error()); mErr != nil {
				log.Warn("failed to record migration error on row", slog.Any("err", mErr))
			}
		}
	}()

	// Segment new content. Both bootstrap and migrate need this.
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

// bootstrap processes the very first commit of a manuscript: every sentence
// is "added", there are no annotations to carry forward.
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

// migrate processes a commit that has a prior migration to migrate annotations from.
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

	if err := db.CreateSentences(ctx, newSentences); err != nil {
		return nil, fmt.Errorf("store new sentences: %w", err)
	}

	// Migrate annotations BEFORE marking done. If this fails, the deferred
	// MarkMigrationError flips the row to 'error' and the orphan sentence
	// rows we just inserted stay tied to a non-done migration_id (so they
	// won't be selected as "current" — they're just dead bytes until cleanup).
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

// migrateAnnotations runs the planned moves in one DB transaction.
// Returns the number of annotations migrated. Either all succeed or none do.
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

// plannedMove is what should happen to annotations on a given old sentence.
type plannedMove struct {
	NewSentenceID string
	Confidence    float64
}

// planMigration builds the final old->new sentence map, including
// fallback assignments for old sentences the matcher couldn't place.
//
// Algorithm:
//   1. Take every match the matcher produced (exact + fuzzy).
//   2. Walk old sentences in ordinal order. For each unmapped sentence,
//      buffer it as "pending" until the next mapped sentence — then
//      assign every pending sentence to that mapped sentence's destination.
//      ("Forward fallback": annotations on a deleted sentence land on the
//      next surviving sentence.)
//   3. Anything still pending after the walk had no following mapped
//      sentence — assign it to the last mapped sentence we saw.
//      ("Backward fallback": tail-deletion annotations land on the
//      previous surviving sentence.)
//
// Confidence is the matcher's similarity score for matched sentences,
// 0.0 for fallback assignments.
func planMigration(oldSentences []models.Sentence, matches []sentence.SentenceMatch) map[string]plannedMove {
	plan := make(map[string]plannedMove, len(oldSentences))
	for _, m := range matches {
		if m.NewSentenceID != "" {
			plan[m.OldSentenceID] = plannedMove{NewSentenceID: m.NewSentenceID, Confidence: m.Similarity}
		}
	}

	var pending []string
	var lastMapped string
	for _, s := range oldSentences {
		if move, ok := plan[s.SentenceID]; ok {
			for _, p := range pending {
				plan[p] = plannedMove{NewSentenceID: move.NewSentenceID, Confidence: 0}
			}
			pending = nil
			lastMapped = move.NewSentenceID
			continue
		}
		pending = append(pending, s.SentenceID)
	}
	// Anything left in pending was after the last mapped sentence.
	if lastMapped != "" {
		for _, p := range pending {
			plan[p] = plannedMove{NewSentenceID: lastMapped, Confidence: 0}
		}
	}
	return plan
}

// segmentContent splits a manuscript into sentences and produces the model
// rows + id list needed to insert them. Used by both bootstrap and migrate
// so they don't drift out of sync.
//
// Returns:
//   - sentences ready for db.CreateSentences (migration_id stamped)
//   - the parallel slice of sentence ids in document order
//   - a map of id->text for diffing
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
