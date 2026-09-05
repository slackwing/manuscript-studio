// Package scratchpad handles the server side of scratchpads: walking a
// stored ProseMirror doc JSON. Since VARIATIONS_PLAN.md, a sketch node in
// the doc is only a PLACEMENT marker — attrs {variationId} — and all
// content lives in the sketch/variation tables (internal/database).
package scratchpad

import (
	"encoding/json"
	"fmt"
)

type pmNode map[string]interface{}

// isSketchNode matches the sketch placement node. (Legacy "book_content"
// nodes from before the variations rearchitecture no longer exist — the
// author deleted all sketches before Liquibase 015.)
func isSketchNode(n pmNode) bool {
	t, _ := n["type"].(string)
	// "snippet" is the pre-rename node type; changeset 043 rewrites stored
	// docs, but tolerate stragglers (e.g. docs restored from old exports).
	return t == "sketch" || t == "snippet"
}

// walk visits every node in a PM doc depth-first (sketch placements can
// sit inside list items, table cells, etc.).
func walk(node pmNode, visit func(pmNode)) {
	visit(node)
	content, ok := node["content"].([]interface{})
	if !ok {
		return
	}
	for _, child := range content {
		if c, ok := child.(pmNode); ok {
			walk(c, visit)
		} else if c, ok := child.(map[string]interface{}); ok {
			walk(pmNode(c), visit)
		}
	}
}

func attrInt(attrs map[string]interface{}, key string) int {
	switch v := attrs[key].(type) {
	case float64: // numbers straight from json.Unmarshal
		return int(v)
	case int:
		return v
	}
	return 0
}

// ExtractVariationIDs returns every sketch placement's variationId, in
// document order (0s from malformed nodes are dropped).
func ExtractVariationIDs(doc json.RawMessage) ([]int, error) {
	var root map[string]interface{}
	if err := json.Unmarshal(doc, &root); err != nil {
		return nil, fmt.Errorf("parse doc: %w", err)
	}
	var out []int
	walk(root, func(n pmNode) {
		if !isSketchNode(n) {
			return
		}
		attrs, _ := n["attrs"].(map[string]interface{})
		if attrs == nil {
			return
		}
		if id := attrInt(attrs, "variationId"); id > 0 {
			out = append(out, id)
		}
	})
	return out, nil
}

// Summary derives a card-friendly view of a doc (HOME_PLAN.md): a plain-text
// sketch of the first n runes of prose (paragraph/heading text — sketch
// placements carry no text here), plus the placed variation IDs (the caller
// resolves counts/canon against the variation tables).
func Summary(doc json.RawMessage, n int) (preview string, variationIDs []int, err error) {
	var root map[string]interface{}
	if err = json.Unmarshal(doc, &root); err != nil {
		return "", nil, fmt.Errorf("parse doc: %w", err)
	}
	var runes []rune
	walk(root, func(node pmNode) {
		if isSketchNode(node) {
			if attrs, _ := node["attrs"].(map[string]interface{}); attrs != nil {
				if id := attrInt(attrs, "variationId"); id > 0 {
					variationIDs = append(variationIDs, id)
				}
			}
			return
		}
		if t, _ := node["type"].(string); t == "text" {
			if len(runes) >= n {
				return
			}
			if txt, _ := node["text"].(string); txt != "" {
				if len(runes) > 0 {
					runes = append(runes, ' ')
				}
				runes = append(runes, []rune(txt)...)
			}
		}
	})
	if len(runes) > n {
		runes = append(runes[:n], '…')
	}
	return string(runes), variationIDs, nil
}
