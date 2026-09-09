package database

// Per-user marker symbols (settings "Markers" section): map a marker slug
// to a shape key so &marker#weird can wear a triangle instead of the
// default diamond. The shape catalog lives in web/js/marker-symbols.js;
// the handler validates keys against the same set.

import (
	"context"
	"fmt"
)

// MarkerConfig: one slug's row — its shape key plus its attention value
// (the impulse amplitude of the reader-attention envelope,
// ATTENTION_PLAN.md §2; 0 = neutral).
type MarkerConfig struct {
	Symbol    string `json:"symbol"`
	Attention int    `json:"attention"`
}

// ListMarkerSymbols returns the user's slug → config map.
func (db *DB) ListMarkerSymbols(ctx context.Context, username string) (map[string]MarkerConfig, error) {
	rows, err := db.Pool.Query(ctx,
		`SELECT slug, symbol, attention FROM marker_symbol WHERE user_id = $1`, username)
	if err != nil {
		return nil, fmt.Errorf("list marker symbols: %w", err)
	}
	defer rows.Close()
	out := map[string]MarkerConfig{}
	for rows.Next() {
		var slug string
		var c MarkerConfig
		if err := rows.Scan(&slug, &c.Symbol, &c.Attention); err != nil {
			return nil, fmt.Errorf("scan marker symbol: %w", err)
		}
		out[slug] = c
	}
	return out, rows.Err()
}

// UpsertMarkerSymbol PARTIALLY updates one slug's row: nil leaves that
// field alone (a fresh row gets 'default' / 0 — the ※ symbol and a
// neutral attention value, ATTENTION_PLAN.md §3).
func (db *DB) UpsertMarkerSymbol(ctx context.Context, username, slug string, symbol *string, attention *int) error {
	if _, err := db.Pool.Exec(ctx, `
		INSERT INTO marker_symbol (user_id, slug, symbol, attention)
		VALUES ($1, $2, COALESCE($3, 'default'), COALESCE($4, 0))
		ON CONFLICT (user_id, slug) DO UPDATE SET
			symbol    = COALESCE($3, marker_symbol.symbol),
			attention = COALESCE($4, marker_symbol.attention)
	`, username, slug, symbol, attention); err != nil {
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
