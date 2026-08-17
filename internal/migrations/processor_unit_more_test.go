package migrations

// Direct unit tests for processor.go's pure helpers (CODE_REVIEW_AUG_2026.md
// AREA 2 rows #130–132). The integration suite exercises these indirectly;
// these pin the exact fallback/dedup/marker semantics.

import (
	"reflect"
	"testing"

	"github.com/slackwing/manuscript-studio/internal/models"
	"github.com/slackwing/manuscript-studio/internal/sentence"
)

func mkSentences(ids ...string) []models.Sentence {
	out := make([]models.Sentence, len(ids))
	for i, id := range ids {
		out[i] = models.Sentence{SentenceID: id, Ordinal: i}
	}
	return out
}

// #130 — planMigration fills matcher gaps by forward-fallback, then
// backward-fallback for orphans after the last mapped sentence. Confidence =
// matcher similarity for real matches, 0 for fallbacks.
func TestPlanMigration_ForwardThenBackwardFallback(t *testing.T) {
	old := mkSentences("o1", "o2", "o3", "o4")
	matches := []sentence.SentenceMatch{
		{OldSentenceID: "o1", NewSentenceID: "n1", Similarity: 1.0},
		{OldSentenceID: "o3", NewSentenceID: "n3", Similarity: 0.85},
	}

	plan := planMigration(old, matches)

	want := map[string]plannedMove{
		"o1": {NewSentenceID: "n1", Confidence: 1.0},
		"o2": {NewSentenceID: "n3", Confidence: 0}, // forward: next mapped target
		"o3": {NewSentenceID: "n3", Confidence: 0.85},
		"o4": {NewSentenceID: "n3", Confidence: 0}, // backward: trails the last mapped target
	}
	if !reflect.DeepEqual(plan, want) {
		t.Errorf("plan = %+v\nwant  %+v", plan, want)
	}
}

func TestPlanMigration_LeadingGapFallsForward(t *testing.T) {
	old := mkSentences("o1", "o2", "o3")
	matches := []sentence.SentenceMatch{
		{OldSentenceID: "o3", NewSentenceID: "n3", Similarity: 1.0},
	}
	plan := planMigration(old, matches)
	for _, id := range []string{"o1", "o2"} {
		got, ok := plan[id]
		if !ok || got.NewSentenceID != "n3" || got.Confidence != 0 {
			t.Errorf("%s = %+v, want forward-fallback to n3 conf 0", id, got)
		}
	}
}

// A match whose NewSentenceID is empty ("deletion-nearest") contributes
// nothing directly; the sentence is covered by fallback like any gap.
func TestPlanMigration_EmptyTargetMatchTreatedAsGap(t *testing.T) {
	old := mkSentences("o1", "o2")
	matches := []sentence.SentenceMatch{
		{OldSentenceID: "o1", NewSentenceID: "n1", Similarity: 1.0},
		{OldSentenceID: "o2", NewSentenceID: "", Similarity: 0.10},
	}
	plan := planMigration(old, matches)
	if got := plan["o2"]; got.NewSentenceID != "n1" || got.Confidence != 0 {
		t.Errorf("o2 = %+v, want backward-fallback to n1 conf 0", got)
	}
}

// With zero mapped targets there is nowhere to fall back to: the plan is
// empty (this is exactly the case where changes_count and len(diff.Deleted)
// diverge — see TestMigration_ChangesCountIsSubUnityPairingCount).
func TestPlanMigration_NoMatchesMeansEmptyPlan(t *testing.T) {
	old := mkSentences("o1", "o2")
	if plan := planMigration(old, nil); len(plan) != 0 {
		t.Errorf("plan = %+v, want empty", plan)
	}
	onlyEmpty := []sentence.SentenceMatch{{OldSentenceID: "o1", NewSentenceID: "", Similarity: 0.10}}
	if plan := planMigration(old, onlyEmpty); len(plan) != 0 {
		t.Errorf("plan with only empty-target matches = %+v, want empty", plan)
	}
}

// #131 — unresolvedReferences: dangling &reference slugs, sorted and
// de-duplicated; references that resolve against the migration's own static
// slugs are skipped, as are slugless references.
func TestUnresolvedReferences_SortedDeduped(t *testing.T) {
	texts := []string{
		"&anchor#camp{The camp.}",                              // static slug "camp"
		"They came back to it; see &reference#camp{the camp}.", // resolves
		"See &reference#zebra{later} and &reference#ghost{gone}.",
		"Again &reference#ghost{still gone}.", // dup
	}
	sentences := make([]models.Sentence, len(texts))
	for i, txt := range texts {
		sentences[i] = models.Sentence{SentenceID: string(rune('a' + i)), Text: txt, Ordinal: i}
	}

	got := unresolvedReferences(sentences)
	want := []string{"ghost", "zebra"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("unresolvedReferences = %v, want %v", got, want)
	}

	// No references at all → nil/empty, never a false positive.
	if got := unresolvedReferences(mkSentences("x")); len(got) != 0 {
		t.Errorf("no-reference content: %v, want empty", got)
	}
}

// #132 — segmentContent carries structural markers ("\n\n" / "\n\t") in
// sentence text, while sentence IDs stay stable against marker changes
// (GenerateSentenceID normalizes them away).
func TestSegmentContent_MarkerCarryStableIDs(t *testing.T) {
	const commit = "cafebabe"
	const segmenter = "segman-test"

	flat := "One sentence here. Two sentence here. Three sentence here."
	broken := "One sentence here. Two sentence here.\n\nThree sentence here."

	flatS, flatIDs, flatByID := segmentContent(flat, commit, segmenter, 1)
	brokenS, brokenIDs, _ := segmentContent(broken, commit, segmenter, 1)

	if len(flatS) != 3 || len(brokenS) != 3 {
		t.Fatalf("segment counts: flat %d, broken %d, want 3 each", len(flatS), len(brokenS))
	}

	// The paragraph-opening sentence carries its marker in the stored text.
	if got := brokenS[2].Text; got != "\n\nThree sentence here." {
		t.Errorf("paragraph opener text = %q, want the \\n\\n marker carried", got)
	}
	// Markers don't perturb IDs: same ordinal + same normalized text → same id.
	if flatIDs[2] != brokenIDs[2] {
		t.Errorf("marker changed the sentence id: %s vs %s", flatIDs[2], brokenIDs[2])
	}

	// Returned shapes agree with each other and with the id generator.
	for i, s := range flatS {
		if s.SentenceID != flatIDs[i] {
			t.Errorf("ids slice out of order at %d: %s vs %s", i, s.SentenceID, flatIDs[i])
		}
		if flatByID[s.SentenceID] != s.Text {
			t.Errorf("textByID[%s] = %q, want %q", s.SentenceID, flatByID[s.SentenceID], s.Text)
		}
		if s.Ordinal != i || s.MigrationID != 1 || s.CommitHash != commit {
			t.Errorf("sentence %d row fields wrong: %+v", i, s)
		}
		want := sentence.GenerateSentenceID(s.Text, i, commit, segmenter)
		if s.SentenceID != want {
			t.Errorf("id %d = %s, want GenerateSentenceID's %s", i, s.SentenceID, want)
		}
	}
}
