package migrations

import "testing"

func TestBestPreviousByNew(t *testing.T) {
	t.Run("simple bijection", func(t *testing.T) {
		plan := map[string]plannedMove{
			"old1": {NewSentenceID: "new1", Confidence: 1.0},
			"old2": {NewSentenceID: "new2", Confidence: 0.85},
		}
		got := bestPreviousByNew(plan)
		if got["new1"] != "old1" || got["new2"] != "old2" || len(got) != 2 {
			t.Fatalf("unexpected: %v", got)
		}
	})

	t.Run("higher-confidence wins when several olds collapse onto one new", func(t *testing.T) {
		plan := map[string]plannedMove{
			"old_real":     {NewSentenceID: "new1", Confidence: 0.8},
			"old_fallback": {NewSentenceID: "new1", Confidence: 0.0},
		}
		got := bestPreviousByNew(plan)
		if got["new1"] != "old_real" {
			t.Fatalf("expected old_real, got %q", got["new1"])
		}
	})

	t.Run("empty new sentence id ignored", func(t *testing.T) {
		plan := map[string]plannedMove{
			"old_unmapped": {NewSentenceID: "", Confidence: 0.0},
			"old_mapped":   {NewSentenceID: "new1", Confidence: 1.0},
		}
		got := bestPreviousByNew(plan)
		if len(got) != 1 || got["new1"] != "old_mapped" {
			t.Fatalf("unexpected: %v", got)
		}
	})

	t.Run("inserted sentences (no plan entry) get no previous", func(t *testing.T) {
		// No plan entries pointing to "new_inserted" → it never appears in the
		// output map, so previous_sentence_id stays nil.
		plan := map[string]plannedMove{
			"old1": {NewSentenceID: "new1", Confidence: 1.0},
		}
		got := bestPreviousByNew(plan)
		if _, exists := got["new_inserted"]; exists {
			t.Fatalf("inserted sentence should not appear: %v", got)
		}
	})
}
