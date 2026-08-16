package sentence

import (
	"strings"
	"testing"
)

// applyPlan reproduces what the review/push pipeline does: effective text per
// sentence, concatenated in order (the join Reconstruct would perform).
func applyPlan(olds []PlaceOld, edits []PlaceEdit) string {
	byID := map[string]string{}
	for _, e := range edits {
		byID[e.SentenceID] = e.Text
	}
	var parts []string
	for _, o := range olds {
		text, has := byID[o.ID]
		if !has {
			text = o.Text
		}
		if strings.TrimSpace(text) == "" {
			continue
		}
		parts = append(parts, text)
	}
	var b strings.Builder
	for k, p := range parts {
		if k > 0 && !strings.HasPrefix(p, "\n") {
			b.WriteString(" ")
		}
		b.WriteString(p)
	}
	return b.String()
}

func region() []PlaceOld {
	return []PlaceOld{
		{ID: "s1", Text: "It wasn't a complete lie, but maybe those are worse."},
		{ID: "s2", Text: "I want to apologize, but I wonder if you'd care."},
		{ID: "s3", Text: "\n\tCalifornia was burning down the summers before and after."},
		{ID: "s4", Text: "I was on my way back to the airport."},
		{ID: "s5", Text: "\n\tBut the irony to end up calling it lucky."},
	}
}

func TestPlacePlan_UnchangedTextYieldsNoEdits(t *testing.T) {
	olds := region()
	texts := make([]string, len(olds))
	for i, o := range olds {
		texts[i] = o.Text
	}
	newText := strings.Join(texts, " ")
	// Rebuild with markers verbatim (join inserts no space before \n).
	newText = strings.ReplaceAll(newText, " \n", "\n")
	edits := PlacePlan(olds, newText)
	if len(edits) != 0 {
		t.Fatalf("unchanged text should produce an empty plan, got %d edits: %+v", len(edits), edits)
	}
}

func TestPlacePlan_SingleSentenceEdit(t *testing.T) {
	olds := region()
	newText := "It wasn't a complete lie, but maybe those are worse by being calculated." +
		" I want to apologize, but I wonder if you'd care." +
		"\n\tCalifornia was burning down the summers before and after." +
		" I was on my way back to the airport." +
		"\n\tBut the irony to end up calling it lucky."
	edits := PlacePlan(olds, newText)
	if len(edits) != 1 {
		t.Fatalf("one changed sentence should produce ONE edit, got %d: %+v", len(edits), edits)
	}
	if edits[0].SentenceID != "s1" || !strings.Contains(edits[0].Text, "by being calculated") {
		t.Fatalf("edit should target s1 with the new phrasing, got %+v", edits[0])
	}
	if got := applyPlan(olds, edits); NormalizeText(got) != NormalizeText(newText) {
		t.Fatalf("concatenation invariant broken:\n got %q\nwant %q", got, newText)
	}
}

func TestPlacePlan_SentenceRemoved(t *testing.T) {
	olds := region()
	newText := "It wasn't a complete lie, but maybe those are worse." +
		" I want to apologize, but I wonder if you'd care." +
		"\n\tCalifornia was burning down the summers before and after." +
		"\n\tBut the irony to end up calling it lucky."
	edits := PlacePlan(olds, newText)
	var del *PlaceEdit
	for i := range edits {
		if edits[i].Text == "" {
			del = &edits[i]
		}
	}
	if del == nil || del.SentenceID != "s4" {
		t.Fatalf("removing s4's sentence should plan a delete on s4, got %+v", edits)
	}
	if got := applyPlan(olds, edits); NormalizeText(got) != NormalizeText(newText) {
		t.Fatalf("concatenation invariant broken:\n got %q\nwant %q", got, newText)
	}
}

func TestPlacePlan_SentenceInserted(t *testing.T) {
	olds := region()
	newText := "It wasn't a complete lie, but maybe those are worse." +
		" I want to apologize, but I wonder if you'd care." +
		" A brand new bridging sentence appears here." +
		"\n\tCalifornia was burning down the summers before and after." +
		" I was on my way back to the airport." +
		"\n\tBut the irony to end up calling it lucky."
	edits := PlacePlan(olds, newText)
	if got := applyPlan(olds, edits); NormalizeText(got) != NormalizeText(newText) {
		t.Fatalf("concatenation invariant broken:\n got %q\nwant %q", got, newText)
	}
	// The insert must NOT have produced blanket deletes.
	for _, e := range edits {
		if e.Text == "" {
			t.Fatalf("pure insert should not delete anything, got delete on %s (%+v)", e.SentenceID, edits)
		}
	}
}

func TestPlacePlan_WholesaleRewriteStillReconstructs(t *testing.T) {
	olds := region()
	newText := "Entirely different opening line about something else." +
		"\n\tA second paragraph with no resemblance to the original." +
		" And a closing thought that shares no words either."
	edits := PlacePlan(olds, newText)
	if got := applyPlan(olds, edits); NormalizeText(got) != NormalizeText(newText) {
		t.Fatalf("concatenation invariant broken on rewrite:\n got %q\nwant %q", got, newText)
	}
}

func TestPlacePlan_MarkersPreserved(t *testing.T) {
	olds := region()
	newText := "It wasn't a complete lie, but maybe those are worse." +
		" I want to apologize, but I wonder if you'd care." +
		"\n\tCalifornia was burning down the summers before and after, but the winter was brutal." +
		" I was on my way back to the airport." +
		"\n\tBut the irony to end up calling it lucky."
	edits := PlacePlan(olds, newText)
	if len(edits) != 1 || edits[0].SentenceID != "s3" {
		t.Fatalf("expected one edit on s3, got %+v", edits)
	}
	if !strings.HasPrefix(edits[0].Text, "\n\t") {
		t.Fatalf("edited paragraph-start sentence must keep its \\n\\t marker, got %q", edits[0].Text)
	}
}
