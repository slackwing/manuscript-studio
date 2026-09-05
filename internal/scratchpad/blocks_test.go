package scratchpad

import (
	"encoding/json"
	"testing"
)

const testDoc = `{
  "type": "doc",
  "content": [
    {"type": "paragraph", "content": [{"type": "text", "text": "notes"}]},
    {"type": "sketch", "attrs": {"variationId": 41}},
    {"type": "bullet_list", "content": [
      {"type": "list_item", "content": [
        {"type": "sketch", "attrs": {"variationId": 42}}
      ]}
    ]},
    {"type": "sketch", "attrs": {"variationId": 0}},
    {"type": "snippet", "attrs": {"variationId": 43}}
  ]
}`

func TestExtractVariationIDs(t *testing.T) {
	ids, err := ExtractVariationIDs(json.RawMessage(testDoc))
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 3 || ids[0] != 41 || ids[1] != 42 || ids[2] != 43 {
		t.Fatalf("expected [41 42 43] (nested included, legacy 'snippet' type included, malformed dropped), got %v", ids)
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
	if len(ids) != 3 {
		t.Errorf("variation ids wrong: %v", ids)
	}
}
