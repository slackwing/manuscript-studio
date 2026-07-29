package database

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/slackwing/manuscript-studio/internal/models"
	"github.com/slackwing/manuscript-studio/internal/sentence"
)

// Scratchpad persistence (SCRATCHPAD_PLAN.md §4/§5). The doc JSONB is the
// source of truth; scratchpad_block rows are DERIVED from it on every save;
// scratchpad_revision is append-only autosave history.

const emptyPMDoc = `{"type":"doc","content":[{"type":"paragraph"}]}`

func (db *DB) CreateScratchpad(ctx context.Context, userID, title string) (*models.Scratchpad, error) {
	if title == "" {
		title = "Untitled"
	}
	s := &models.Scratchpad{UserID: userID, Title: title, Doc: json.RawMessage(emptyPMDoc), SchemaVersion: 1}
	err := db.Pool.QueryRow(ctx, `
		INSERT INTO scratchpad (user_id, title, doc)
		VALUES ($1, $2, $3::jsonb)
		RETURNING scratchpad_id, created_at, updated_at
	`, userID, title, emptyPMDoc).Scan(&s.ScratchpadID, &s.CreatedAt, &s.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("create scratchpad: %w", err)
	}
	return s, nil
}

// ListScratchpads returns the user's non-deleted scratchpads, most recently
// updated first, without doc bodies (list view).
func (db *DB) ListScratchpads(ctx context.Context, userID string) ([]models.Scratchpad, error) {
	rows, err := db.Pool.Query(ctx, `
		SELECT scratchpad_id, user_id, title, schema_version, created_at, updated_at
		FROM scratchpad
		WHERE user_id = $1 AND deleted_at IS NULL
		ORDER BY updated_at DESC
	`, userID)
	if err != nil {
		return nil, fmt.Errorf("list scratchpads: %w", err)
	}
	defer rows.Close()
	var out []models.Scratchpad
	for rows.Next() {
		var s models.Scratchpad
		if err := rows.Scan(&s.ScratchpadID, &s.UserID, &s.Title, &s.SchemaVersion, &s.CreatedAt, &s.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// GetScratchpad returns one scratchpad with its doc, or nil if missing or
// soft-deleted. Owner checks happen in the handler.
func (db *DB) GetScratchpad(ctx context.Context, id int) (*models.Scratchpad, error) {
	var s models.Scratchpad
	var doc []byte
	err := db.Pool.QueryRow(ctx, `
		SELECT scratchpad_id, user_id, title, doc, schema_version, linked_manuscript_id, created_at, updated_at
		FROM scratchpad
		WHERE scratchpad_id = $1 AND deleted_at IS NULL
	`, id).Scan(&s.ScratchpadID, &s.UserID, &s.Title, &doc, &s.SchemaVersion, &s.LinkedManuscriptID, &s.CreatedAt, &s.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get scratchpad: %w", err)
	}
	s.Doc = json.RawMessage(doc)
	return &s, nil
}

// LinkScratchpad sets (or, with manuscriptID nil, clears) a scratchpad's
// manuscript default. Only the link column changes. Ownership is enforced by
// the handler.
func (db *DB) LinkScratchpad(ctx context.Context, id int, manuscriptID *int) error {
	_, err := db.Pool.Exec(ctx,
		`UPDATE scratchpad SET linked_manuscript_id = $1, updated_at = NOW()
		 WHERE scratchpad_id = $2 AND deleted_at IS NULL`,
		manuscriptID, id)
	if err != nil {
		return fmt.Errorf("link scratchpad: %w", err)
	}
	return nil
}

// GetScratchpadLinkedManuscript returns a pad's manuscript default (nil if
// unlinked or missing). Used to inherit the manuscript onto NEW notes created
// in the pad.
func (db *DB) GetScratchpadLinkedManuscript(ctx context.Context, id int) (*int, error) {
	var mid *int
	err := db.Pool.QueryRow(ctx,
		`SELECT linked_manuscript_id FROM scratchpad WHERE scratchpad_id = $1 AND deleted_at IS NULL`,
		id).Scan(&mid)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get scratchpad linked manuscript: %w", err)
	}
	return mid, nil
}

// UpdateScratchpad saves title + doc (autosave): updates the row and
// appends a revision — one transaction. (Snippet text lives in the
// variation table since VARIATIONS_PLAN; the doc carries only placements.)
func (db *DB) UpdateScratchpad(ctx context.Context, id int, title string, doc json.RawMessage) error {
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `
		UPDATE scratchpad SET title = $2, doc = $3::jsonb, updated_at = NOW()
		WHERE scratchpad_id = $1 AND deleted_at IS NULL
	`, id, title, string(doc)); err != nil {
		return fmt.Errorf("update scratchpad: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO scratchpad_revision (scratchpad_id, doc) VALUES ($1, $2::jsonb)
	`, id, string(doc)); err != nil {
		return fmt.Errorf("insert revision: %w", err)
	}
	return tx.Commit(ctx)
}

// SoftDeleteScratchpad marks a scratchpad deleted (never hard-delete).
func (db *DB) SoftDeleteScratchpad(ctx context.Context, id int) error {
	_, err := db.Pool.Exec(ctx, `
		UPDATE scratchpad SET deleted_at = NOW() WHERE scratchpad_id = $1 AND deleted_at IS NULL
	`, id)
	return err
}

// CreateScratchpadImage stores image bytes (scratchpad-only; the book format
// has no images).
func (db *DB) CreateScratchpadImage(ctx context.Context, userID, imageID, contentType string, data []byte) error {
	_, err := db.Pool.Exec(ctx, `
		INSERT INTO scratchpad_image (image_id, user_id, content_type, data) VALUES ($1, $2, $3, $4)
	`, imageID, userID, contentType, data)
	return err
}

// GetScratchpadImage returns an image's owner, content type, and bytes;
// empty userID means not found.
func (db *DB) GetScratchpadImage(ctx context.Context, imageID string) (userID, contentType string, data []byte, err error) {
	err = db.Pool.QueryRow(ctx, `
		SELECT user_id, content_type, data FROM scratchpad_image WHERE image_id = $1
	`, imageID).Scan(&userID, &contentType, &data)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", nil, nil
	}
	return
}

// ListScratchpadsWithDocs returns the user's non-deleted scratchpads WITH
// their docs (home cards need snippets/counts derived from the doc).
func (db *DB) ListScratchpadsWithDocs(ctx context.Context, userID string) ([]models.Scratchpad, error) {
	rows, err := db.Pool.Query(ctx, `
		SELECT scratchpad_id, user_id, title, doc, schema_version, created_at, updated_at
		FROM scratchpad
		WHERE user_id = $1 AND deleted_at IS NULL
		ORDER BY COALESCE(last_opened_at, updated_at) DESC
	`, userID)
	if err != nil {
		return nil, fmt.Errorf("list scratchpads with docs: %w", err)
	}
	defer rows.Close()
	var out []models.Scratchpad
	for rows.Next() {
		var s models.Scratchpad
		var doc []byte
		if err := rows.Scan(&s.ScratchpadID, &s.UserID, &s.Title, &doc, &s.SchemaVersion, &s.CreatedAt, &s.UpdatedAt); err != nil {
			return nil, err
		}
		s.Doc = json.RawMessage(doc)
		out = append(out, s)
	}
	return out, rows.Err()
}

// UpsertManuscriptOpened stamps per-user manuscript recency (HOME_PLAN.md).
func (db *DB) UpsertManuscriptOpened(ctx context.Context, userID string, manuscriptID int) error {
	_, err := db.Pool.Exec(ctx, `
		INSERT INTO manuscript_opened (user_id, manuscript_id, last_opened_at)
		VALUES ($1, $2, NOW())
		ON CONFLICT (user_id, manuscript_id) DO UPDATE SET last_opened_at = NOW()
	`, userID, manuscriptID)
	return err
}

// GetManuscriptOpenedMap returns manuscript_id → last_opened_at for a user.
func (db *DB) GetManuscriptOpenedMap(ctx context.Context, userID string) (map[int]time.Time, error) {
	rows, err := db.Pool.Query(ctx, `
		SELECT manuscript_id, last_opened_at FROM manuscript_opened WHERE user_id = $1
	`, userID)
	if err != nil {
		return nil, fmt.Errorf("get manuscript opened: %w", err)
	}
	defer rows.Close()
	out := map[int]time.Time{}
	for rows.Next() {
		var id int
		var t time.Time
		if err := rows.Scan(&id, &t); err != nil {
			return nil, err
		}
		out[id] = t
	}
	return out, rows.Err()
}

// GetMigrationWordCount counts real prose words across a migration's
// sentences (home cards show words, not sentences). Unlike a raw whitespace
// count, this EXCLUDES &-command scaffolding — headings, anchor/part/chapter
// labels, &meta, &placeholder details, and inline command tokens — so the
// number reflects book prose, not markup (see sentence.CountProseWords).
func (db *DB) GetMigrationWordCount(ctx context.Context, migrationID int) (int, error) {
	rows, err := db.Pool.Query(ctx, `
		SELECT text FROM sentence WHERE migration_id = $1
	`, migrationID)
	if err != nil {
		return 0, err
	}
	defer rows.Close()

	total := 0
	for rows.Next() {
		var text string
		if err := rows.Scan(&text); err != nil {
			return 0, err
		}
		total += sentence.CountProseWords(text)
	}
	return total, rows.Err()
}

// TouchScratchpadOpened stamps landing-page recency when the modal opens.
func (db *DB) TouchScratchpadOpened(ctx context.Context, id int) error {
	_, err := db.Pool.Exec(ctx, `
		UPDATE scratchpad SET last_opened_at = NOW() WHERE scratchpad_id = $1 AND deleted_at IS NULL
	`, id)
	return err
}
