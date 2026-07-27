package database

import (
	"context"
	"encoding/json"
)

// BackfillSketchHomes populates sketch.scratchpad_id for sketches created
// before homes were tracked (migration 017 added the column nullable). It walks
// every scratchpad's ProseMirror doc, finds each snippet-placement node (a
// `snippet` node whose attrs carry the sketch id as `variationId`), and sets
// that sketch's home to the scratchpad it was found in — but only where the
// home is still NULL, so it is idempotent and never re-homes an already-homed
// sketch. Returns the number of sketches updated.
func (db *DB) BackfillSketchHomes(ctx context.Context) (int, error) {
	rows, err := db.Pool.Query(ctx, `
		SELECT scratchpad_id, doc FROM scratchpad WHERE deleted_at IS NULL
	`)
	if err != nil {
		return 0, err
	}
	// sketchID -> home scratchpad (first doc that places it wins).
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
		for _, id := range sketchIDsInDoc(node) {
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
	for sketchID, spID := range home {
		ct, err := db.Pool.Exec(ctx, `
			UPDATE sketch SET scratchpad_id = $2 WHERE sketch_id = $1 AND scratchpad_id IS NULL
		`, sketchID, spID)
		if err != nil {
			return updated, err
		}
		updated += int(ct.RowsAffected())
	}
	return updated, nil
}

// sketchIDsInDoc walks a ProseMirror doc node recursively and collects the
// sketch ids of every snippet-placement node. A snippet node looks like
// {"type":"snippet","attrs":{"variationId":N}} ("variationId" is the historical
// attr name for what is now the sketch id).
func sketchIDsInDoc(node map[string]any) []int {
	var out []int
	if node == nil {
		return out
	}
	if t, _ := node["type"].(string); t == "snippet" {
		if attrs, ok := node["attrs"].(map[string]any); ok {
			if vid, ok := attrs["variationId"].(float64); ok && int(vid) > 0 {
				out = append(out, int(vid))
			}
		}
	}
	if content, ok := node["content"].([]any); ok {
		for _, c := range content {
			if child, ok := c.(map[string]any); ok {
				out = append(out, sketchIDsInDoc(child)...)
			}
		}
	}
	return out
}
