// Package scratchpad handles the server side of scratchpads
// (SCRATCHPAD_PLAN.md): walking a stored ProseMirror doc JSON for
// book_content blocks and stamping canonize attributes into it. The doc
// JSON is the source of truth; scratchpad_block rows are derived from it.
package scratchpad

import (
	"encoding/json"
	"fmt"
	"time"
)

// Block is a book_content node's attrs as the server cares about them.
type Block struct {
	BlockID              string `json:"blockId"`
	Text                 string `json:"text"`
	ManuscriptID         int    `json:"manuscriptId"`
	RefSlug              string `json:"refSlug"`
	Label                string `json:"label"`
	SnapshotText         string `json:"snapshotText"`
	CanonizedMigrationID int    `json:"canonizedMigrationId"`
	CanonizedAt          string `json:"canonizedAt"` // RFC3339, "" when draft
}

// Canonized reports whether the block has been canonized into a manuscript.
func (b Block) Canonized() bool { return b.RefSlug != "" }

type pmNode map[string]interface{}

// isSnippetNode matches the snippet node type — "snippet" is canonical;
// "book_content" is the legacy name still present in older docs.
func isSnippetNode(n pmNode) bool {
	t, _ := n["type"].(string)
	return t == "snippet" || t == "book_content"
}

// walk visits every node in a PM doc depth-first (blocks can sit inside
// list items, table cells, etc.).
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

func attrStr(attrs map[string]interface{}, key string) string {
	if v, ok := attrs[key].(string); ok {
		return v
	}
	return ""
}

func attrInt(attrs map[string]interface{}, key string) int {
	switch v := attrs[key].(type) {
	case float64: // numbers straight from json.Unmarshal
		return int(v)
	case int: // numbers we stamped in ourselves (Canonize)
		return v
	}
	return 0
}

func blockFromAttrs(attrs map[string]interface{}) Block {
	return Block{
		BlockID:              attrStr(attrs, "blockId"),
		Text:                 attrStr(attrs, "text"),
		ManuscriptID:         attrInt(attrs, "manuscriptId"),
		RefSlug:              attrStr(attrs, "refSlug"),
		Label:                attrStr(attrs, "label"),
		SnapshotText:         attrStr(attrs, "snapshotText"),
		CanonizedMigrationID: attrInt(attrs, "canonizedMigrationId"),
		CanonizedAt:          attrStr(attrs, "canonizedAt"),
	}
}

// ExtractBlocks returns every book_content node's attrs, in document order.
func ExtractBlocks(doc json.RawMessage) ([]Block, error) {
	var root map[string]interface{}
	if err := json.Unmarshal(doc, &root); err != nil {
		return nil, fmt.Errorf("parse doc: %w", err)
	}
	var out []Block
	walk(root, func(n pmNode) {
		if !isSnippetNode(n) {
			return
		}
		attrs, _ := n["attrs"].(map[string]interface{})
		if attrs == nil {
			return
		}
		out = append(out, blockFromAttrs(attrs))
	})
	return out, nil
}

// Canonize stamps canonize attrs onto the doc's book_content node with the
// given blockId: target manuscript + slug + label, the snapshot (the block's
// text at this moment, kept forever), and the timestamp. Fails if the block
// is missing or already canonized (strictness — decision 6). Returns the
// updated doc JSON and the resulting Block.
func Canonize(doc json.RawMessage, blockID string, manuscriptID int, refSlug, label string, migrationID int, now time.Time) (json.RawMessage, Block, error) {
	var root map[string]interface{}
	if err := json.Unmarshal(doc, &root); err != nil {
		return nil, Block{}, fmt.Errorf("parse doc: %w", err)
	}
	var found *Block
	var errOut error
	walk(root, func(n pmNode) {
		if found != nil || errOut != nil {
			return
		}
		if !isSnippetNode(n) {
			return
		}
		attrs, _ := n["attrs"].(map[string]interface{})
		if attrs == nil || attrStr(attrs, "blockId") != blockID {
			return
		}
		if attrStr(attrs, "refSlug") != "" {
			errOut = fmt.Errorf("block %s is already canonized (→ #%s)", blockID, attrStr(attrs, "refSlug"))
			return
		}
		attrs["manuscriptId"] = manuscriptID
		attrs["refSlug"] = refSlug
		attrs["label"] = label
		attrs["snapshotText"] = attrStr(attrs, "text")
		attrs["canonizedMigrationId"] = migrationID
		attrs["canonizedAt"] = now.UTC().Format(time.RFC3339)
		b := blockFromAttrs(attrs)
		found = &b
	})
	if errOut != nil {
		return nil, Block{}, errOut
	}
	if found == nil {
		return nil, Block{}, fmt.Errorf("block %s not found in doc", blockID)
	}
	updated, err := json.Marshal(root)
	if err != nil {
		return nil, Block{}, fmt.Errorf("re-marshal doc: %w", err)
	}
	return updated, *found, nil
}

// Summary derives a card-friendly view of a doc (HOME_PLAN.md): a plain-text
// snippet of the first n runes of prose (paragraph/heading text, skipping
// book_content — that's book prose, not scratch prose), plus block counts.
func Summary(doc json.RawMessage, n int) (snippet string, blocks, canonized int, err error) {
	var root map[string]interface{}
	if err = json.Unmarshal(doc, &root); err != nil {
		return "", 0, 0, fmt.Errorf("parse doc: %w", err)
	}
	var runes []rune
	walk(root, func(node pmNode) {
		if isSnippetNode(node) {
			blocks++
			if attrs, _ := node["attrs"].(map[string]interface{}); attrs != nil && attrStr(attrs, "refSlug") != "" {
				canonized++
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
	return string(runes), blocks, canonized, nil
}
