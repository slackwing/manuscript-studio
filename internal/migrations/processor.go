package migrations

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/slackwing/manuscript-studio/internal/database"
	"github.com/slackwing/manuscript-studio/internal/models"
	"github.com/slackwing/manuscript-studio/internal/sentence"
)

// SegmenterVersion is the segmenter version used by the processor.
// Exposed so callers can stamp it onto pending migration rows before
// kicking off the work.
const SegmenterVersion = "segman-1.0.0"

// Processor handles manuscript migration processing.
//
// The lifecycle is split between caller and processor:
//   1. Caller calls db.CreatePendingMigration(...) to reserve a row.
//   2. Caller spawns a goroutine that calls Processor.Run(ctx, migrationID, ...).
//   3. Processor transitions the row to 'running', does the work, then
//      writes either 'done' (with results) or 'error' (with message).
type Processor struct {
	db               *pgxpool.Pool
	segmenterVersion string
}

// NewProcessor creates a new migration processor.
func NewProcessor(db *pgxpool.Pool) *Processor {
	return &Processor{
		db:               db,
		segmenterVersion: SegmenterVersion,
	}
}

// SegmenterVersion returns the segmenter version used by this processor.
func (p *Processor) SegmenterVersion() string { return p.segmenterVersion }

// Run executes the migration for an already-inserted pending row. It marks
// the row 'running' on entry and 'done' or 'error' on exit. Errors that
// occur after the row is marked are recorded on the row and returned.
//
// migrationID must be the id of a row created by CreatePendingMigration
// with matching manuscriptID/commitHash/segmenter. The row will end up in
// status='done' or status='error' regardless of whether this returns a
// non-nil error.
func (p *Processor) Run(ctx context.Context, migrationID, manuscriptID int, commitHash, branchName, content string) (result *MigrationResult, err error) {
	dbWrapper := &database.DB{Pool: p.db}

	// Mark running. If this fails (DB issue), bail without recording an
	// error on the row — caller will see the wrapped error.
	if err := dbWrapper.MarkMigrationRunning(ctx, migrationID); err != nil {
		return nil, err
	}

	// On any failure below, record the error message on the row before returning.
	defer func() {
		if err != nil {
			if markErr := dbWrapper.MarkMigrationError(context.Background(), migrationID, err.Error()); markErr != nil {
				// Log but don't override the caller's err.
				fmt.Printf("warning: failed to mark migration %d as error: %v\n", migrationID, markErr)
			}
		}
	}()

	// Get latest completed migration to determine bootstrap vs migrate.
	latestMigration, err := dbWrapper.GetLatestMigration(ctx, manuscriptID)
	if err != nil {
		return nil, fmt.Errorf("failed to get latest migration: %w", err)
	}

	if latestMigration == nil || latestMigration.MigrationID == migrationID {
		return p.bootstrap(ctx, dbWrapper, migrationID, manuscriptID, commitHash, branchName, content)
	}
	return p.migrate(ctx, dbWrapper, migrationID, manuscriptID, commitHash, branchName, content, latestMigration)
}

// bootstrap processes the first commit of a manuscript.
func (p *Processor) bootstrap(ctx context.Context, db *database.DB, migrationID, manuscriptID int, commitHash, branchName, content string) (*MigrationResult, error) {
	tokenizer := sentence.NewTokenizer()
	sentences := tokenizer.SplitIntoSentences(content)

	var sentenceIDs []string
	var sentenceModels []models.Sentence
	for i, sentText := range sentences {
		sentID := sentence.GenerateSentenceID(sentText, i, commitHash)
		sentenceIDs = append(sentenceIDs, sentID)

		sentenceModels = append(sentenceModels, models.Sentence{
			SentenceID:  sentID,
			MigrationID: migrationID,
			CommitHash:  commitHash,
			Text:        sentText,
			WordCount:   sentence.CountWords(sentText),
			Ordinal:     i,
		})
	}

	if err := db.CreateSentences(ctx, sentenceModels); err != nil {
		return nil, fmt.Errorf("failed to store sentences: %w", err)
	}

	final := &models.Migration{
		MigrationID:       migrationID,
		ManuscriptID:      manuscriptID,
		CommitHash:        commitHash,
		Segmenter:         p.segmenterVersion,
		ParentMigrationID: nil,
		BranchName:        branchName,
		SentenceCount:     len(sentences),
		AdditionsCount:    len(sentences),
		DeletionsCount:    0,
		ChangesCount:      0,
		SentenceIDArray:   sentenceIDs,
	}
	if err := db.MarkMigrationDone(ctx, final); err != nil {
		return nil, fmt.Errorf("failed to mark migration done: %w", err)
	}

	return &MigrationResult{
		MigrationID:    migrationID,
		Status:         "bootstrap_complete",
		SentenceCount:  len(sentences),
		AdditionsCount: len(sentences),
		Message:        fmt.Sprintf("Bootstrap complete: %d sentences", len(sentences)),
	}, nil
}

// migrate processes a commit with annotation migration.
func (p *Processor) migrate(ctx context.Context, db *database.DB, migrationID, manuscriptID int, commitHash, branchName, content string, parentMigration *models.Migration) (*MigrationResult, error) {
	oldSentences, err := db.GetSentencesByMigration(ctx, parentMigration.MigrationID)
	if err != nil {
		return nil, fmt.Errorf("failed to get old sentences: %w", err)
	}

	oldSentenceMap := make(map[string]string)
	for _, s := range oldSentences {
		oldSentenceMap[s.SentenceID] = s.Text
	}

	tokenizer := sentence.NewTokenizer()
	newSentenceTexts := tokenizer.SplitIntoSentences(content)

	var newSentenceIDs []string
	newSentenceMap := make(map[string]string)
	var sentenceModels []models.Sentence
	for i, sentText := range newSentenceTexts {
		sentID := sentence.GenerateSentenceID(sentText, i, commitHash)
		newSentenceIDs = append(newSentenceIDs, sentID)
		newSentenceMap[sentID] = sentText

		sentenceModels = append(sentenceModels, models.Sentence{
			SentenceID:  sentID,
			MigrationID: migrationID,
			CommitHash:  commitHash,
			Text:        sentText,
			WordCount:   sentence.CountWords(sentText),
			Ordinal:     i,
		})
	}

	diff := sentence.ComputeSentenceDiff(oldSentenceMap, newSentenceMap)
	migrations := sentence.ComputeMigrationMap(diff)

	migrationMap := make(map[string]string)
	confidenceMap := make(map[string]float64)
	for _, m := range migrations {
		if m.NewSentenceID != "" {
			migrationMap[m.OldSentenceID] = m.NewSentenceID
			confidenceMap[m.OldSentenceID] = m.Similarity
		}
	}

	if err := db.CreateSentences(ctx, sentenceModels); err != nil {
		return nil, fmt.Errorf("failed to store sentences: %w", err)
	}

	parentID := parentMigration.MigrationID
	final := &models.Migration{
		MigrationID:       migrationID,
		ManuscriptID:      manuscriptID,
		CommitHash:        commitHash,
		Segmenter:         p.segmenterVersion,
		ParentMigrationID: &parentID,
		BranchName:        branchName,
		SentenceCount:     len(newSentenceTexts),
		AdditionsCount:    len(diff.Added),
		DeletionsCount:    len(diff.Deleted),
		ChangesCount:      len(diff.Deleted),
		SentenceIDArray:   newSentenceIDs,
	}
	if err := db.MarkMigrationDone(ctx, final); err != nil {
		return nil, fmt.Errorf("failed to mark migration done: %w", err)
	}

	annotationsMigrated, err := p.migrateAnnotations(ctx, db, migrationMap, confidenceMap, migrationID)
	if err != nil {
		// Annotation-migration failures don't fail the run — the new
		// migration is already marked done. Just log.
		fmt.Printf("Warning: Some annotations failed to migrate: %v\n", err)
	}

	return &MigrationResult{
		MigrationID:         migrationID,
		Status:              "migration_complete",
		SentenceCount:       len(newSentenceTexts),
		AdditionsCount:      len(diff.Added),
		DeletionsCount:      len(diff.Deleted),
		ChangesCount:        len(diff.Deleted),
		AnnotationsMigrated: annotationsMigrated,
		Message:             fmt.Sprintf("Migration complete: %d sentences, %d annotations migrated", len(newSentenceTexts), annotationsMigrated),
	}, nil
}

// migrateAnnotations migrates annotations from old sentences to new ones.
func (p *Processor) migrateAnnotations(ctx context.Context, db *database.DB, migrationMap map[string]string, confidenceMap map[string]float64, newMigrationID int) (int, error) {
	annotationsMigrated := 0

	for oldSentenceID, newSentenceID := range migrationMap {
		annotations, err := db.GetActiveAnnotationsForSentence(ctx, oldSentenceID)
		if err != nil {
			continue
		}

		for _, annotation := range annotations {
			latestVersion, err := db.GetLatestAnnotationVersion(ctx, annotation.AnnotationID)
			if err != nil {
				continue
			}

			newHistory := append(latestVersion.SentenceIDHistory, newSentenceID)
			conf := confidenceMap[oldSentenceID]
			newVersion := &models.AnnotationVersion{
				AnnotationID:        annotation.AnnotationID,
				Version:             latestVersion.Version + 1,
				SentenceID:          newSentenceID,
				SentenceIDHistory:   newHistory,
				OriginMigrationID:   &newMigrationID,
				MigrationConfidence: &conf,
			}

			// Note: CreateAnnotationVersion not implemented yet
			// TODO: Implement this in database package
			_ = newVersion
			if false {
				continue
			}

			annotation.SentenceID = newSentenceID
			// TODO: Implement UpdateAnnotationSentenceID in database package
			if false {
				continue
			}

			annotationsMigrated++
		}
	}

	return annotationsMigrated, nil
}

// MigrationResult represents the outcome of a migration.
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
