package database

// Manuscript rows (split out of queries.go, 2026-08 — pure code motion).
// 2026-08 (037): the row is the registry — name/storage/git_repo_name/
// git_branch live here; config holds only the git_repos credential registry.

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/slackwing/manuscript-studio/internal/models"

	"github.com/jackc/pgx/v5"
)

// manuscriptCols is the canonical SELECT list; every scan uses scanManuscript.
const manuscriptCols = `manuscript_id, COALESCE(name, ''), git_repo_path, file_path,
	storage, COALESCE(git_repo_name, ''), COALESCE(git_branch, ''),
	COALESCE(display_name, ''), created_at, birthday, word_goal`

func scanManuscript(row pgx.Row) (*models.Manuscript, error) {
	var m models.Manuscript
	err := row.Scan(
		&m.ManuscriptID,
		&m.Name,
		&m.GitRepoPath,
		&m.FilePath,
		&m.Storage,
		&m.GitRepoName,
		&m.GitBranch,
		&m.DisplayName,
		&m.CreatedAt,
		&m.Birthday,
		&m.WordGoal,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &m, nil
}

// LocalGitRepoPath is the git_repo_path sentinel for local-mode rows —
// stable identity that survives repos_dir moves (never a filesystem path).
func LocalGitRepoPath(name string) string {
	return "local:" + name
}

func (db *DB) CreateManuscript(ctx context.Context, gitRepoPath, filePath string) (*models.Manuscript, error) {
	query := `
		INSERT INTO manuscript (git_repo_path, file_path)
		VALUES ($1, $2)
		ON CONFLICT (git_repo_path, file_path) DO UPDATE
			SET git_repo_path = EXCLUDED.git_repo_path
		RETURNING ` + manuscriptCols
	m, err := scanManuscript(db.Pool.QueryRow(ctx, query, gitRepoPath, filePath))
	if err != nil {
		return nil, fmt.Errorf("failed to create manuscript: %w", err)
	}
	return m, nil
}

// ErrDuplicateManuscriptName: uq_manuscript_name violation. Callers map to 409.
var ErrDuplicateManuscriptName = errors.New("a manuscript with this name already exists")

// CreateLocalManuscript inserts a local-mode row. Returns
// ErrDuplicateManuscriptName on a name collision.
func (db *DB) CreateLocalManuscript(ctx context.Context, name, fileName, displayName string) (*models.Manuscript, error) {
	query := `
		INSERT INTO manuscript (name, git_repo_path, file_path, storage, git_branch, display_name)
		VALUES ($1, $2, $3, 'local', 'main', $4)
		RETURNING ` + manuscriptCols
	m, err := scanManuscript(db.Pool.QueryRow(ctx, query, name, LocalGitRepoPath(name), fileName, displayName))
	if isUniqueViolation(err) {
		return nil, ErrDuplicateManuscriptName
	}
	if err != nil {
		return nil, fmt.Errorf("create local manuscript: %w", err)
	}
	return m, nil
}

// DeleteManuscriptRow removes a row by id — only used to roll back a
// creation whose git-side setup failed (no migrations exist yet).
func (db *DB) DeleteManuscriptRow(ctx context.Context, manuscriptID int) error {
	_, err := db.Pool.Exec(ctx, `DELETE FROM manuscript WHERE manuscript_id = $1`, manuscriptID)
	return err
}

// GrantManuscriptAccess is the idempotent manuscript_access upsert.
func (db *DB) GrantManuscriptAccess(ctx context.Context, username, manuscriptName string) error {
	_, err := db.Pool.Exec(ctx, `
		INSERT INTO manuscript_access (username, manuscript_name)
		VALUES ($1, $2)
		ON CONFLICT (username, manuscript_name) DO NOTHING`, username, manuscriptName)
	return err
}

// ReconcileManuscriptFromConfig upserts a legacy config manuscript into the
// registry columns, keyed by the historical (git_repo_path, file_path)
// identity. name is only set when NULL so a row can't be silently renamed
// out from under manuscript_access grants. Returns the reconciled row.
func (db *DB) ReconcileManuscriptFromConfig(ctx context.Context, name, gitRepoPath, filePath, gitRepoName, gitBranch string) (*models.Manuscript, error) {
	query := `
		INSERT INTO manuscript (name, git_repo_path, file_path, storage, git_repo_name, git_branch)
		VALUES ($1, $2, $3, 'github', $4, $5)
		ON CONFLICT (git_repo_path, file_path) DO UPDATE
			SET name          = COALESCE(manuscript.name, EXCLUDED.name),
			    storage       = 'github',
			    git_repo_name = EXCLUDED.git_repo_name,
			    git_branch    = EXCLUDED.git_branch
		RETURNING ` + manuscriptCols
	m, err := scanManuscript(db.Pool.QueryRow(ctx, query, name, gitRepoPath, filePath, gitRepoName, gitBranch))
	if err != nil {
		return nil, fmt.Errorf("reconcile manuscript %q: %w", name, err)
	}
	return m, nil
}

// GetManuscriptByID returns (nil, nil) when no row exists.
func (db *DB) GetManuscriptByID(ctx context.Context, manuscriptID int) (*models.Manuscript, error) {
	m, err := scanManuscript(db.Pool.QueryRow(ctx,
		`SELECT `+manuscriptCols+` FROM manuscript WHERE manuscript_id = $1`, manuscriptID))
	if err != nil {
		return nil, fmt.Errorf("get manuscript by id: %w", err)
	}
	return m, nil
}

// GetManuscriptByName returns (nil, nil) when no row exists.
func (db *DB) GetManuscriptByName(ctx context.Context, name string) (*models.Manuscript, error) {
	m, err := scanManuscript(db.Pool.QueryRow(ctx,
		`SELECT `+manuscriptCols+` FROM manuscript WHERE name = $1`, name))
	if err != nil {
		return nil, fmt.Errorf("get manuscript by name: %w", err)
	}
	return m, nil
}

func (db *DB) GetManuscript(ctx context.Context, gitRepoPath, filePath string) (*models.Manuscript, error) {
	m, err := scanManuscript(db.Pool.QueryRow(ctx,
		`SELECT `+manuscriptCols+` FROM manuscript WHERE git_repo_path = $1 AND file_path = $2`,
		gitRepoPath, filePath))
	if err != nil {
		return nil, fmt.Errorf("failed to get manuscript: %w", err)
	}
	return m, nil
}

// GetManuscriptsByGitRepoName returns all github-mode manuscripts bound to a
// registry entry — the webhook fans out over these.
func (db *DB) GetManuscriptsByGitRepoName(ctx context.Context, gitRepoName string) ([]*models.Manuscript, error) {
	rows, err := db.Pool.Query(ctx,
		`SELECT `+manuscriptCols+` FROM manuscript
		 WHERE git_repo_name = $1 AND storage = 'github' ORDER BY manuscript_id`, gitRepoName)
	if err != nil {
		return nil, fmt.Errorf("manuscripts by git repo: %w", err)
	}
	defer rows.Close()
	var out []*models.Manuscript
	for rows.Next() {
		m, err := scanManuscript(rows)
		if err != nil {
			return nil, fmt.Errorf("manuscripts by git repo scan: %w", err)
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// ListManuscripts returns every row (startup reconciliation + resegment).
func (db *DB) ListManuscripts(ctx context.Context) ([]*models.Manuscript, error) {
	rows, err := db.Pool.Query(ctx,
		`SELECT `+manuscriptCols+` FROM manuscript ORDER BY manuscript_id`)
	if err != nil {
		return nil, fmt.Errorf("list manuscripts: %w", err)
	}
	defer rows.Close()
	var out []*models.Manuscript
	for rows.Next() {
		m, err := scanManuscript(rows)
		if err != nil {
			return nil, fmt.Errorf("list manuscripts scan: %w", err)
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// UpdateManuscriptMeta partially updates settings-modal metadata: a nil
// field is left unchanged. Returns the updated row, or (nil, nil) when the
// manuscript doesn't exist.
func (db *DB) UpdateManuscriptMeta(ctx context.Context, manuscriptID int, birthday *time.Time, wordGoal *int, displayName *string) (*models.Manuscript, error) {
	m, err := scanManuscript(db.Pool.QueryRow(ctx, `
		UPDATE manuscript
		SET birthday = COALESCE($2, birthday),
		    word_goal = COALESCE($3, word_goal),
		    display_name = COALESCE($4, display_name)
		WHERE manuscript_id = $1
		RETURNING `+manuscriptCols, manuscriptID, birthday, wordGoal, displayName))
	if err != nil {
		return nil, fmt.Errorf("update manuscript meta: %w", err)
	}
	return m, nil
}
