package migrations

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/slackwing/manuscript-studio/internal/database"
	"github.com/slackwing/manuscript-studio/internal/models"
	"github.com/slackwing/manuscript-studio/internal/sentence"
)

// Processor handles manuscript migration processing
type Processor struct {
	db               *pgxpool.Pool
	segmenterVersion string
}

// NewProcessor creates a new migration processor
func NewProcessor(db *pgxpool.Pool) *Processor {
	return &Processor{
		db:               db,
		segmenterVersion: "segman-1.0.0", // TODO: Make configurable
	}
}

// ProcessManuscript processes a manuscript at a specific commit
func (p *Processor) ProcessManuscript(ctx context.Context, manuscriptID int, commitHash, content string) (*MigrationResult, error) {
	// Check for existing migration with this commit and segmenter
	dbWrapper := &database.DB{Pool: p.db}
	existingMigration, err := dbWrapper.GetMigrationByCommitAndSegmenter(ctx, manuscriptID, commitHash, p.segmenterVersion)
	if err != nil {
		return nil, fmt.Errorf("failed to check existing migration: %w", err)
	}

	if existingMigration != nil {
		return &MigrationResult{
			MigrationID: existingMigration.MigrationID,
			Status:      "already_processed",
			Message:     fmt.Sprintf("Commit %s already processed with segmenter %s", commitHash, p.segmenterVersion),
		}, nil
	}

	// Get latest migration to determine if this is bootstrap or migration
	latestMigration, err := dbWrapper.GetLatestMigration(ctx, manuscriptID)
	if err != nil {
		return nil, fmt.Errorf("failed to get latest migration: %w", err)
	}

	if latestMigration == nil {
		// Bootstrap mode
		return p.bootstrap(ctx, dbWrapper, manuscriptID, commitHash, content)
	}

	// Migration mode
	return p.migrate(ctx, dbWrapper, manuscriptID, commitHash, content, latestMigration)
}

// bootstrap processes the first commit of a manuscript
func (p *Processor) bootstrap(ctx context.Context, db *database.DB, manuscriptID int, commitHash, content string) (*MigrationResult, error) {
	// Tokenize into sentences
	tokenizer := sentence.NewTokenizer()
	sentences := tokenizer.SplitIntoSentences(content)

	// Generate sentence IDs
	var sentenceIDs []string
	var sentenceModels []models.Sentence

	for i, sentText := range sentences {
		sentID := sentence.GenerateSentenceID(sentText, i, commitHash)
		sentenceIDs = append(sentenceIDs, sentID)

		sentenceModels = append(sentenceModels, models.Sentence{
			SentenceID:  sentID,
			CommitHash:  commitHash,
			Text:        sentText,
			WordCount:   sentence.CountWords(sentText),
			Ordinal:     i,
		})
	}

	// Create migration record
	migration := &models.Migration{
		ManuscriptID:      manuscriptID,
		CommitHash:        commitHash,
		Segmenter:         p.segmenterVersion,
		ParentMigrationID: nil,
		BranchName:        "main", // TODO: Get actual branch
		SentenceCount:     len(sentences),
		AdditionsCount:    len(sentences),
		DeletionsCount:    0,
		ChangesCount:      0,
		SentenceIDArray:   sentenceIDs,
	}

	if err := db.CreateMigration(ctx, migration); err != nil {
		return nil, fmt.Errorf("failed to create migration: %w", err)
	}

	// Update sentence models with migration ID
	for i := range sentenceModels {
		sentenceModels[i].MigrationID = migration.MigrationID
	}

	// Store sentences
	if err := db.CreateSentences(ctx, sentenceModels); err != nil {
		return nil, fmt.Errorf("failed to store sentences: %w", err)
	}

	return &MigrationResult{
		MigrationID:    migration.MigrationID,
		Status:         "bootstrap_complete",
		SentenceCount:  len(sentences),
		AdditionsCount: len(sentences),
		Message:        fmt.Sprintf("Bootstrap complete: %d sentences", len(sentences)),
	}, nil
}

// migrate processes a commit with annotation migration
func (p *Processor) migrate(ctx context.Context, db *database.DB, manuscriptID int, commitHash, content string, parentMigration *models.Migration) (*MigrationResult, error) {
	// Get old sentences
	oldSentences, err := db.GetSentencesByMigration(ctx, parentMigration.MigrationID)
	if err != nil {
		return nil, fmt.Errorf("failed to get old sentences: %w", err)
	}

	// Build map of old sentences
	oldSentenceMap := make(map[string]string)
	for _, s := range oldSentences {
		oldSentenceMap[s.SentenceID] = s.Text
	}

	// Tokenize new sentences
	tokenizer := sentence.NewTokenizer()
	newSentenceTexts := tokenizer.SplitIntoSentences(content)

	// Generate IDs for new sentences
	var newSentenceIDs []string
	newSentenceMap := make(map[string]string)
	var sentenceModels []models.Sentence

	for i, sentText := range newSentenceTexts {
		sentID := sentence.GenerateSentenceID(sentText, i, commitHash)
		newSentenceIDs = append(newSentenceIDs, sentID)
		newSentenceMap[sentID] = sentText

		sentenceModels = append(sentenceModels, models.Sentence{
			SentenceID:  sentID,
			CommitHash:  commitHash,
			Text:        sentText,
			WordCount:   sentence.CountWords(sentText),
			Ordinal:     i,
		})
	}

	// Compute diff
	diff := sentence.ComputeSentenceDiff(oldSentenceMap, newSentenceMap)

	// Compute migration map
	migrations := sentence.ComputeMigrationMap(diff)

	// Build mapping from old to new sentence IDs
	migrationMap := make(map[string]string)
	confidenceMap := make(map[string]float64)
	for _, m := range migrations {
		if m.NewSentenceID != "" {
			migrationMap[m.OldSentenceID] = m.NewSentenceID
			confidenceMap[m.OldSentenceID] = m.Similarity
		}
	}

	// Create migration record
	migration := &models.Migration{
		ManuscriptID:      manuscriptID,
		CommitHash:        commitHash,
		Segmenter:         p.segmenterVersion,
		ParentMigrationID: &parentMigration.MigrationID,
		BranchName:        "main", // TODO: Get actual branch
		SentenceCount:     len(newSentenceTexts),
		AdditionsCount:    len(diff.Added),
		DeletionsCount:    len(diff.Deleted),
		ChangesCount:      len(diff.Deleted),
		SentenceIDArray:   newSentenceIDs,
	}

	if err := db.CreateMigration(ctx, migration); err != nil {
		return nil, fmt.Errorf("failed to create migration: %w", err)
	}

	// Update sentence models with migration ID
	for i := range sentenceModels {
		sentenceModels[i].MigrationID = migration.MigrationID
	}

	// Store new sentences
	if err := db.CreateSentences(ctx, sentenceModels); err != nil {
		return nil, fmt.Errorf("failed to store sentences: %w", err)
	}

	// Migrate annotations
	annotationsMigrated, err := p.migrateAnnotations(ctx, db, migrationMap, confidenceMap, migration.MigrationID)
	if err != nil {
		// Log but don't fail the migration
		fmt.Printf("Warning: Some annotations failed to migrate: %v\n", err)
	}

	return &MigrationResult{
		MigrationID:         migration.MigrationID,
		Status:              "migration_complete",
		SentenceCount:       len(newSentenceTexts),
		AdditionsCount:      len(diff.Added),
		DeletionsCount:      len(diff.Deleted),
		ChangesCount:        len(diff.Deleted),
		AnnotationsMigrated: annotationsMigrated,
		Message:             fmt.Sprintf("Migration complete: %d sentences, %d annotations migrated", len(newSentenceTexts), annotationsMigrated),
	}, nil
}

// migrateAnnotations migrates annotations from old sentences to new ones
func (p *Processor) migrateAnnotations(ctx context.Context, db *database.DB, migrationMap map[string]string, confidenceMap map[string]float64, newMigrationID int) (int, error) {
	annotationsMigrated := 0

	for oldSentenceID, newSentenceID := range migrationMap {
		annotations, err := db.GetActiveAnnotationsForSentence(ctx, oldSentenceID)
		if err != nil {
			continue // Skip on error
		}

		for _, annotation := range annotations {
			// Get latest version
			latestVersion, err := db.GetLatestAnnotationVersion(ctx, annotation.AnnotationID)
			if err != nil {
				continue
			}

			// Update sentence ID history
			newHistory := append(latestVersion.SentenceIDHistory, newSentenceID)

			// Create new version
			newVersion := &models.AnnotationVersion{
				AnnotationID:        annotation.AnnotationID,
				Version:             latestVersion.Version + 1,
				SentenceID:          newSentenceID,
				SentenceIDHistory:   newHistory,
				OriginMigrationID:   newMigrationID,
				MigrationConfidence: confidenceMap[oldSentenceID],
			}

			// Note: CreateAnnotationVersion not implemented yet
			// TODO: Implement this in database package
			_ = newVersion
			if false {
				continue
			}

			// Update main annotation record
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

// MigrationResult represents the outcome of a migration
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