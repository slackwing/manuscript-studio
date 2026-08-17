package database

// Task-type rows (031/032) (split out of queries.go, 2026-08 — pure code
// motion).

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// ---- Task types (031/032) ----

// TaskType is one first-dimension option. 'gray' color = no behavior; a
// real note color means "picking this type recolors the note".
type TaskType struct {
	Name     string `json:"name"`
	BuiltIn  bool   `json:"built_in"`
	Color    string `json:"color"`
	IsTask   bool   `json:"is_task"`
	Deleted  bool   `json:"deleted"`
	Position int    `json:"position"`
}

// ListTaskTypes in the user's manual order (settings-page drag; also the
// dropdown order). No name is special. Soft-deleted types ARE returned
// (deleted=true) — a note may still carry one, and the client needs its
// is_task/color; every dropdown and the settings page filter them out.
func (db *DB) ListTaskTypes(ctx context.Context) ([]TaskType, error) {
	rows, err := db.Pool.Query(ctx, `
		SELECT name, built_in, color, is_task, deleted, position FROM task_type
		ORDER BY position, name
	`)
	if err != nil {
		return nil, fmt.Errorf("list task types: %w", err)
	}
	defer rows.Close()
	out := []TaskType{}
	for rows.Next() {
		var t TaskType
		if err := rows.Scan(&t.Name, &t.BuiltIn, &t.Color, &t.IsTask, &t.Deleted, &t.Position); err != nil {
			return nil, fmt.Errorf("scan task type: %w", err)
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// AddTaskTypes inserts custom types in the given category, appended to the
// end of the manual order; live names that already exist are skipped
// (idempotent — the settings field re-submits the whole list), but re-adding
// a soft-deleted name REVIVES its row (same name = same row, so notes that
// kept the value reconnect) in the new category.
func (db *DB) AddTaskTypes(ctx context.Context, names []string, isTask bool) error {
	// One tx (matching SetTaskTypeOrder): a mid-list failure must not leave
	// half the submitted names inserted.
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("add task types: begin: %w", err)
	}
	defer tx.Rollback(ctx)
	for _, n := range names {
		if _, err := tx.Exec(ctx, `
			INSERT INTO task_type (name, built_in, is_task, position)
			VALUES ($1, false, $2, (SELECT COALESCE(MAX(position), 0) + 1 FROM task_type))
			ON CONFLICT (name) DO UPDATE SET deleted = false, is_task = EXCLUDED.is_task
			WHERE task_type.deleted
		`, n, isTask); err != nil {
			return fmt.Errorf("add task type %q: %w", n, err)
		}
	}
	return tx.Commit(ctx)
}

// DeleteTaskType soft-deletes: the row stays (notes keeping the value stay
// valid and still display it) but every dropdown stops offering it. Any
// type may go — an untyped note is simply 'n/a' (NULL), so no fallback
// type needs protecting. false = no such live type.
func (db *DB) DeleteTaskType(ctx context.Context, name string) (bool, error) {
	tag, err := db.Pool.Exec(ctx, `
		UPDATE task_type SET deleted = true WHERE name = $1 AND NOT deleted
	`, name)
	if err != nil {
		return false, fmt.Errorf("delete task type %q: %w", name, err)
	}
	return tag.RowsAffected() > 0, nil
}

// SetTaskTypeOrder rewrites the manual order: position = index in names.
// The settings page sends every live name (both categories concatenated);
// omitted names keep their old positions.
func (db *DB) SetTaskTypeOrder(ctx context.Context, names []string) error {
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("set task type order: begin: %w", err)
	}
	defer tx.Rollback(ctx)
	for i, n := range names {
		if _, err := tx.Exec(ctx, `UPDATE task_type SET position = $2 WHERE name = $1`, n, i+1); err != nil {
			return fmt.Errorf("set task type %q position: %w", n, err)
		}
	}
	return tx.Commit(ctx)
}

// TaskTypeIsTask: whether a type name (live OR soft-deleted — a note may
// still carry a deleted one) is in the task category. ” (the untyped
// 'n/a' state) is never a task.
func (db *DB) TaskTypeIsTask(ctx context.Context, name string) (bool, error) {
	if name == "" {
		return false, nil
	}
	var isTask bool
	err := db.Pool.QueryRow(ctx, `SELECT is_task FROM task_type WHERE name = $1`, name).Scan(&isTask)
	if err == pgx.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("task type is_task for %q: %w", name, err)
	}
	return isTask, nil
}

// SetTaskTypeColor updates one type's color; false = no such type.
func (db *DB) SetTaskTypeColor(ctx context.Context, name, color string) (bool, error) {
	tag, err := db.Pool.Exec(ctx, `UPDATE task_type SET color = $2 WHERE name = $1`, name, color)
	if err != nil {
		return false, fmt.Errorf("set task type %q color: %w", name, err)
	}
	return tag.RowsAffected() > 0, nil
}
