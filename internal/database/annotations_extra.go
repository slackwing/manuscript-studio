package database

import (
	"context"

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