package database

// Per-user marker symbols (settings "Markers" section): map a marker slug
// to a shape key so &marker#weird can wear a triangle instead of the
// default diamond. The shape catalog lives in web/js/marker-symbols.js;
// the handler validates keys against the same set.

import (
	"context"
	"fmt"
)

// ListMarkerSymbols returns the user's slug → symbol map.
func (db *DB) ListMarkerSymbols(ctx context.Context, username string) (map[string]string, error) {
	rows, err := db.Pool.Query(ctx,
		`SELECT slug, symbol FROM marker_symbol WHERE user_id = $1`, username)
	if err != nil {
		return nil, fmt.Errorf("list marker symbols: %w", err)
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var slug, symbol string
		if err := rows.Scan(&slug, &symbol); err != nil {
			return nil, fmt.Errorf("scan marker symbol: %w", err)
		}
		out[slug] = symbol
	}
	return out, rows.Err()
}

// UpsertMarkerSymbol sets one slug's shape.
func (db *DB) UpsertMarkerSymbol(ctx context.Context, username, slug, symbol string) error {
	if _, err := db.Pool.Exec(ctx, `
		INSERT INTO marker_symbol (user_id, slug, symbol) VALUES ($1, $2, $3)
		ON CONFLICT (user_id, slug) DO UPDATE SET symbol = EXCLUDED.symbol
	`, username, slug, symbol); err != nil {
		return fmt.Errorf("upsert marker symbol: %w", err)
	}
	return nil
}

// DeleteMarkerSymbol reverts one slug to the default shape. Returns
// whether a row existed.
func (db *DB) DeleteMarkerSymbol(ctx context.Context, username, slug string) (bool, error) {
	tag, err := db.Pool.Exec(ctx,
		`DELETE FROM marker_symbol WHERE user_id = $1 AND slug = $2`, username, slug)
	if err != nil {
		return false, fmt.Errorf("delete marker symbol: %w", err)
	}
	return tag.RowsAffected() > 0, nil
}
