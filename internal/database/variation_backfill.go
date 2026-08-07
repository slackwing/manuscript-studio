package database

import (
	"context"
	"encoding/json"
)

// BackfillVariationHomes populates variation.scratchpad_id for variations created
// before homes were tracked (migration 017 added the column nullable). It walks
// every scratchpad's ProseMirror doc, finds each sketch-placement node (a
// `sketch` node whose attrs carry the variation id as `variationId`), and sets
// that variation's home to the scratchpad it was found in — but only where the
// home is still NULL, so it is idempotent and never re-homes an already-homed
// variation. Returns the number of variations updated.
func (db *DB) BackfillVariationHomes(ctx context.Context) (int, error) {
	rows, err := db.Pool.Query(ctx, `
		SELECT scratchpad_id, doc FROM scratchpad WHERE deleted_at IS NULL
	`)
	if err != nil {
		return 0, err
	}
	// variationID -> home scratchpad (first doc that places it wins).
	home := map[int]int{}
	for rows.Next() {
		var spID int
		var doc []byte
		if err := rows.Scan(&spID, &doc); err != nil {
			rows.Close()
			return 0, err
		}
		var node map[string]any
		if err := json.Unmarshal(doc, &node); err != nil {
			continue // skip an unparseable doc rather than fail the whole backfill
		}
		for _, id := range variationIDsInDoc(node) {
			if _, seen := home[id]; !seen {
				home[id] = spID
			}
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}

	updated := 0
	for variationID, spID := range home {
		ct, err := db.Pool.Exec(ctx, `
			UPDATE variation SET scratchpad_id = $2 WHERE variation_id = $1 AND scratchpad_id IS NULL
		`, variationID, spID)
		if err != nil {
			return updated, err
		}
		updated += int(ct.RowsAffected())
	}
	return updated, nil
}

// variationIDsInDoc walks a ProseMirror doc node recursively and collects the
// variation ids of every sketch-placement node. A sketch node looks like
// {"type":"sketch","attrs":{"variationId":N}} ("variationId" is the historical
// attr name for what is now the variation id).
func variationIDsInDoc(node map[string]any) []int {
	var out []int
	if node == nil {
		return out
	}
	if t, _ := node["type"].(string); t == "sketch" {
		if attrs, ok := node["attrs"].(map[string]any); ok {
			if vid, ok := attrs["variationId"].(float64); ok && int(vid) > 0 {
				out = append(out, int(vid))
			}
		}
	}
	if content, ok := node["content"].([]any); ok {
		for _, c := range content {
			if child, ok := c.(map[string]any); ok {
				out = append(out, variationIDsInDoc(child)...)
			}
		}
	}
	return out
}
