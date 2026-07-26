package scratchpad

import (
	"encoding/json"
	"testing"
)

const testDoc = `{
  "type": "doc",
  "content": [
    {"type": "paragraph", "content": [{"type": "text", "text": "notes"}]},
    {"type": "snippet", "attrs": {"variationId": 41}},
    {"type": "bullet_list", "content": [
      {"type": "list_item", "content": [
        {"type": "snippet", "attrs": {"variationId": 42}}
      ]}
    ]},
    {"type": "snippet", "attrs": {"variationId": 0}}
  ]
}`

func TestExtractVariationIDs(t *testing.T) {
	ids, err := ExtractVariationIDs(json.RawMessage(testDoc))
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 2 || ids[0] != 41 || ids[1] != 42 {
		t.Fatalf("expected [41 42] (nested included, malformed dropped), got %v", ids)
	}
}

func TestSummary(t *testing.T) {
	preview, ids, err := Summary(json.RawMessage(testDoc), 20)
	if err != nil {
		t.Fatal(err)
	}
	if preview != "notes" {
		t.Errorf("preview wrong: %q", preview)
	}
	if len(ids) != 2 {
		t.Errorf("variation ids wrong: %v", ids)
	}
}
