package database

// Tag rows: user-namespaced tags and note_tag links (split out of
// queries.go, 2026-08 — pure code motion).

import (
	"context"
	"fmt"

	"github.com/slackwing/manuscript-studio/internal/models"

	"github.com/jackc/pgx/v5"
)

// rowQuerier is the intersection of pgxpool.Pool and pgx.Tx that the
// tag helper needs — lets one implementation serve both pool and in-tx
// callers (CreateDailyRule must create tags INSIDE its tx so a rollback
// can't orphan them).
type rowQuerier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// GetOrCreateTag resolves a tag within a USER's namespace (user-wide tags):
// "idea" is one row per owner, shared across all their notes regardless of
// manuscript / scratchpad / free context.
func (db *DB) GetOrCreateTag(ctx context.Context, tagName string, userID string) (*models.Tag, error) {
	return getOrCreateTag(ctx, db.Pool, tagName, userID)
}

func getOrCreateTag(ctx context.Context, q rowQuerier, tagName string, userID string) (*models.Tag, error) {
	var tag models.Tag
	query := `
		SELECT tag_id, tag_name, user_id, created_at
		FROM tag
		WHERE tag_name = $1 AND user_id = $2
	`
	err := q.QueryRow(ctx, query, tagName, userID).Scan(
		&tag.TagID,
		&tag.TagName,
		&tag.UserID,
		&tag.CreatedAt,
	)
	if err == nil {
		return &tag, nil
	}
	if err != pgx.ErrNoRows {
		return nil, fmt.Errorf("failed to query tag: %w", err)
	}

	createQuery := `
		INSERT INTO tag (tag_name, user_id)
		VALUES ($1, $2)
		RETURNING tag_id, tag_name, user_id, created_at
	`
	err = q.QueryRow(ctx, createQuery, tagName, userID).Scan(
		&tag.TagID,
		&tag.TagName,
		&tag.UserID,
		&tag.CreatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create tag: %w", err)
	}

	return &tag, nil
}

// AddTagToNote is idempotent; creates the tag (in the user's namespace) if missing.
func (db *DB) AddTagToNote(ctx context.Context, noteID int, tagName string, userID string) error {
	tag, err := db.GetOrCreateTag(ctx, tagName, userID)
	if err != nil {
		return err
	}

	query := `
		INSERT INTO note_tag (note_id, tag_id)
		VALUES ($1, $2)
		ON CONFLICT (note_id, tag_id) DO NOTHING
	`
	_, err = db.Pool.Exec(ctx, query, noteID, tag.TagID)
	if err != nil {
		return fmt.Errorf("failed to add tag to note: %w", err)
	}

	return nil
}

func (db *DB) RemoveTagFromNote(ctx context.Context, noteID int, tagID int) error {
	query := `
		DELETE FROM note_tag
		WHERE note_id = $1 AND tag_id = $2
	`
	result, err := db.Pool.Exec(ctx, query, noteID, tagID)
	if err != nil {
		return fmt.Errorf("failed to remove tag from note: %w", err)
	}

	rowsAffected := result.RowsAffected()
	if rowsAffected == 0 {
		return fmt.Errorf("tag not found on note")
	}

	return nil
}

// TagCount: one row of the tag-autocomplete source — a tag name and how many
// ACTIVE (non-deleted) notes wear it, most-common first.
type TagCount struct {
	TagName string `json:"tag_name"`
	Count   int    `json:"count"`
}

// ListTagCounts powers the tag-input autocomplete: the user's tags ranked by
// how many live notes carry them. Computed on demand — tag edits must show
// immediately (a cron would lag), and the per-user tag set is tiny.
func (db *DB) ListTagCounts(ctx context.Context, username string) ([]TagCount, error) {
	rows, err := db.Pool.Query(ctx, `
		SELECT t.tag_name, count(*) AS n
		FROM tag t
		JOIN note_tag nt ON nt.tag_id = t.tag_id
		JOIN note a ON a.note_id = nt.note_id AND a.deleted_at IS NULL
		WHERE t.user_id = $1
		GROUP BY t.tag_name
		ORDER BY n DESC, t.tag_name
	`, username)
	if err != nil {
		return nil, fmt.Errorf("failed to query tag counts: %w", err)
	}
	defer rows.Close()
	out := []TagCount{}
	for rows.Next() {
		var tc TagCount
		if err := rows.Scan(&tc.TagName, &tc.Count); err != nil {
			return nil, fmt.Errorf("failed to scan tag count: %w", err)
		}
		out = append(out, tc)
	}
	return out, rows.Err()
}

func (db *DB) GetTagsForNote(ctx context.Context, noteID int) ([]models.Tag, error) {
	query := `
		SELECT t.tag_id, t.tag_name, t.user_id, t.created_at
		FROM tag t
		JOIN note_tag at ON t.tag_id = at.tag_id
		WHERE at.note_id = $1
		ORDER BY t.tag_name
	`

	rows, err := db.Pool.Query(ctx, query, noteID)
	if err != nil {
		return nil, fmt.Errorf("failed to query tags: %w", err)
	}
	defer rows.Close()

	tags := []models.Tag{}
	for rows.Next() {
		var tag models.Tag
		err := rows.Scan(
			&tag.TagID,
			&tag.TagName,
			&tag.UserID,
			&tag.CreatedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to scan tag: %w", err)
		}
		tags = append(tags, tag)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating tags: %w", err)
	}

	return tags, nil
}
