package database

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/slackwing/manuscript-studio/internal/models"
)

// GetAnnotationsForCommitAndUser retrieves all active annotations for a commit and user
// This is an alias for GetAnnotationsByCommit for compatibility
func (db *DB) GetAnnotationsForCommitAndUser(ctx context.Context, commitHash, username string) ([]models.Annotation, error) {
	return db.GetAnnotationsByCommit(ctx, commitHash, username)
}

// DeleteAnnotation soft-deletes an annotation (alias for SoftDeleteAnnotation)
func (db *DB) DeleteAnnotation(ctx context.Context, annotationID int) error {
	return db.SoftDeleteAnnotation(ctx, annotationID)
}

// GetManuscriptByID retrieves a manuscript row by its ID.
func (db *DB) GetManuscriptByID(ctx context.Context, manuscriptID int) (*models.Manuscript, error) {
	query := `SELECT manuscript_id, repo_path, file_path, created_at FROM manuscript WHERE manuscript_id = $1`
	var m models.Manuscript
	err := db.Pool.QueryRow(ctx, query, manuscriptID).Scan(&m.ManuscriptID, &m.RepoPath, &m.FilePath, &m.CreatedAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get manuscript by ID: %w", err)
	}
	return &m, nil
}