package scratchpad

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

const testDoc = `{
  "type": "doc",
  "content": [
    {"type": "paragraph", "content": [{"type": "text", "text": "notes"}]},
    {"type": "book_content", "attrs": {"blockId": "b1", "text": "Draft one.", "manuscriptId": 0, "refSlug": "", "label": "", "snapshotText": "", "canonizedMigrationId": 0, "canonizedAt": ""}},
    {"type": "bullet_list", "content": [
      {"type": "list_item", "content": [
        {"type": "book_content", "attrs": {"blockId": "b2", "text": "Nested draft.", "manuscriptId": 3, "refSlug": "keg", "label": "Keg", "snapshotText": "old", "canonizedMigrationId": 7, "canonizedAt": "2026-07-25T00:00:00Z"}}
      ]}
    ]}
  ]
}`

func TestExtractBlocks(t *testing.T) {
	blocks, err := ExtractBlocks(json.RawMessage(testDoc))
	if err != nil {
		t.Fatal(err)
	}
	if len(blocks) != 2 {
		t.Fatalf("expected 2 blocks (incl. nested), got %d", len(blocks))
	}
	if blocks[0].BlockID != "b1" || blocks[0].Canonized() {
		t.Errorf("b1 should be a draft: %+v", blocks[0])
	}
	if blocks[1].BlockID != "b2" || !blocks[1].Canonized() || blocks[1].ManuscriptID != 3 || blocks[1].RefSlug != "keg" {
		t.Errorf("b2 extraction wrong: %+v", blocks[1])
	}
}

func TestCanonize(t *testing.T) {
	now := time.Date(2026, 7, 25, 12, 0, 0, 0, time.UTC)
	updated, b, err := Canonize(json.RawMessage(testDoc), "b1", 5, "reunion", "Reunion", 9, now)
	if err != nil {
		t.Fatal(err)
	}
	if b.RefSlug != "reunion" || b.ManuscriptID != 5 || b.SnapshotText != "Draft one." || b.CanonizedMigrationID != 9 {
		t.Errorf("canonized block wrong: %+v", b)
	}
	if !strings.Contains(string(updated), `"snapshotText":"Draft one."`) {
		t.Errorf("doc not updated with snapshot: %s", updated)
	}
	// Re-canonizing the same block must fail (strictness).
	if _, _, err := Canonize(updated, "b1", 5, "other", "", 9, now); err == nil {
		t.Error("re-canonize must fail")
	}
	// Already-canonized nested block must fail too.
	if _, _, err := Canonize(json.RawMessage(testDoc), "b2", 5, "x", "", 9, now); err == nil {
		t.Error("canonizing an already-canonized block must fail")
	}
	// Unknown block.
	if _, _, err := Canonize(json.RawMessage(testDoc), "nope", 5, "x", "", 9, now); err == nil {
		t.Error("unknown block must fail")
	}
}

func TestSummary(t *testing.T) {
	snippet, blocks, canonized, err := Summary(json.RawMessage(testDoc), 20)
	if err != nil {
		t.Fatal(err)
	}
	if snippet == "" || len([]rune(snippet)) > 21 {
		t.Errorf("snippet wrong: %q", snippet)
	}
	if blocks != 2 || canonized != 1 {
		t.Errorf("counts wrong: blocks=%d canonized=%d", blocks, canonized)
	}
}
