package database

// Role grants (038, PERMISSIONS_PLAN.md v3): (username, manuscript_id,
// role) rows. Role → action bundles live in internal/perm, not here.
// Any row on a manuscript makes it visible to that user; this table
// replaced manuscript_access as the read path.

import (
	"context"
	"errors"
	"fmt"
	"time"
)

// ErrLastAdmin guards the invariant "every manuscript keeps ≥1 admin".
var ErrLastAdmin = errors.New("cannot remove the last admin of a manuscript")

// RoleMember is one user's standing on a manuscript (People tab, access UI).
type RoleMember struct {
	Username      string    `json:"username"`
	Roles         []string  `json:"roles"`
	UserCreatedAt time.Time `json:"user_created_at"`
}

func (db *DB) GetRolesForUser(ctx context.Context, username string, manuscriptID int) ([]string, error) {
	rows, err := db.Pool.Query(ctx,
		`SELECT role FROM role WHERE username = $1 AND manuscript_id = $2 ORDER BY role`,
		username, manuscriptID)
	if err != nil {
		return nil, fmt.Errorf("roles for user: %w", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var r string
		if err := rows.Scan(&r); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// HasAnyRole is the visibility/login gate.
func (db *DB) HasAnyRole(ctx context.Context, username string, manuscriptID int) (bool, error) {
	var exists bool
	err := db.Pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM role WHERE username = $1 AND manuscript_id = $2)`,
		username, manuscriptID).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("has any role: %w", err)
	}
	return exists, nil
}

// HasRoleAnywhere: server-level convenience (e.g. pointer's user-scoped
// points surfaces on the landing page).
func (db *DB) HasRoleAnywhere(ctx context.Context, username, role string) (bool, error) {
	var exists bool
	err := db.Pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM role WHERE username = $1 AND role = $2)`,
		username, role).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("has role anywhere: %w", err)
	}
	return exists, nil
}

// GrantRole is idempotent.
func (db *DB) GrantRole(ctx context.Context, username string, manuscriptID int, role string) error {
	_, err := db.Pool.Exec(ctx, `
		INSERT INTO role (username, manuscript_id, role)
		VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
		username, manuscriptID, role)
	if err != nil {
		return fmt.Errorf("grant role: %w", err)
	}
	return nil
}

// RevokeRole enforces last-admin protection in the same transaction the
// row disappears in — two racing revokes can't both succeed.
func (db *DB) RevokeRole(ctx context.Context, username string, manuscriptID int, role string) error {
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("revoke role: begin: %w", err)
	}
	defer tx.Rollback(ctx)

	if role == "admin" {
		// Lock the admin rows, then count — FOR UPDATE can't ride an
		// aggregate directly.
		var admins int
		if err := tx.QueryRow(ctx, `
			SELECT count(*) FROM (
				SELECT 1 FROM role
				WHERE manuscript_id = $1 AND role = 'admin' FOR UPDATE
			) locked`,
			manuscriptID).Scan(&admins); err != nil {
			return fmt.Errorf("revoke role: count admins: %w", err)
		}
		var holds bool
		if err := tx.QueryRow(ctx,
			`SELECT EXISTS(SELECT 1 FROM role WHERE username = $1 AND manuscript_id = $2 AND role = 'admin')`,
			username, manuscriptID).Scan(&holds); err != nil {
			return fmt.Errorf("revoke role: check holder: %w", err)
		}
		if holds && admins <= 1 {
			return ErrLastAdmin
		}
	}

	if _, err := tx.Exec(ctx,
		`DELETE FROM role WHERE username = $1 AND manuscript_id = $2 AND role = $3`,
		username, manuscriptID, role); err != nil {
		return fmt.Errorf("revoke role: delete: %w", err)
	}
	return tx.Commit(ctx)
}

// ListRoleMembers returns everyone with a role on the manuscript, roles
// aggregated per user, with the account's creation time (People-tab sort).
func (db *DB) ListRoleMembers(ctx context.Context, manuscriptID int) ([]RoleMember, error) {
	rows, err := db.Pool.Query(ctx, `
		SELECT r.username, array_agg(r.role ORDER BY r.role), u.created_at
		FROM role r JOIN "user" u ON u.username = r.username
		WHERE r.manuscript_id = $1
		GROUP BY r.username, u.created_at
		ORDER BY u.created_at, r.username`, manuscriptID)
	if err != nil {
		return nil, fmt.Errorf("list role members: %w", err)
	}
	defer rows.Close()
	var out []RoleMember
	for rows.Next() {
		var m RoleMember
		if err := rows.Scan(&m.Username, &m.Roles, &m.UserCreatedAt); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// ManuscriptRoles is one visible manuscript + the user's roles on it
// (session payload).
type ManuscriptRoles struct {
	ManuscriptID int
	Roles        []string
}

func (db *DB) GetManuscriptRolesForUser(ctx context.Context, username string) ([]ManuscriptRoles, error) {
	rows, err := db.Pool.Query(ctx, `
		SELECT manuscript_id, array_agg(role ORDER BY role)
		FROM role WHERE username = $1
		GROUP BY manuscript_id ORDER BY manuscript_id`, username)
	if err != nil {
		return nil, fmt.Errorf("manuscript roles for user: %w", err)
	}
	defer rows.Close()
	var out []ManuscriptRoles
	for rows.Next() {
		var m ManuscriptRoles
		if err := rows.Scan(&m.ManuscriptID, &m.Roles); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}
