package sentence

import "testing"

func TestRebuildManuscript_Basic(t *testing.T) {
	ids := []string{"s0", "s1", "s2", "s3"}
	committed := map[string]string{
		"s0": "&title{The Wildfire}",
		"s1": "\n\nThe fire began at dawn.",
		"s2": "It spread across the ridge.",
		"s3": "\n\tA new paragraph continues.",
	}
	got := RebuildManuscript(ids, committed, nil)

	// Title on its own line, blank-line gaps, prose joined with a space.
	want := "&title{The Wildfire}\n\nThe fire began at dawn. It spread across the ridge.\n\tA new paragraph continues.\n"
	if got != want {
		t.Errorf("RebuildManuscript =\n%q\nwant\n%q", got, want)
	}

	// Idempotence: re-segmenting is out of scope here, but rebuilding from the
	// SAME inputs must be deterministic, and Canonicalize on each piece is a
	// fixed point.
	got2 := RebuildManuscript(ids, committed, nil)
	if got2 != got {
		t.Errorf("RebuildManuscript not deterministic")
	}
}

func TestRebuildManuscript_LeadingAnchorSuggestion(t *testing.T) {
	ids := []string{"s0", "s1"}
	committed := map[string]string{
		"s0": "&chapter#c1{1.}{Smoke}",
		"s1": "\n\nThe fire began at dawn.",
	}
	// Suggest turning s1 into a leading-anchor paragraph (inline-typed by the
	// user, canonicalize should block the anchor out).
	suggestions := map[string]string{
		"s1": "\n\n&anchor{The salvia night.} The fire began at dawn.",
	}
	got := RebuildManuscript(ids, committed, suggestions)

	// The anchor is split onto its own line (single \n) so segman will segment
	// it as a block anchor; prose stays in the same paragraph.
	want := "&chapter#c1{1.}{Smoke}\n\n&anchor{The salvia night.}\nThe fire began at dawn.\n"
	if got != want {
		t.Errorf("RebuildManuscript (leading anchor) =\n%q\nwant\n%q", got, want)
	}
}

func TestRebuildManuscript_WhitespaceTidied(t *testing.T) {
	ids := []string{"s0"}
	committed := map[string]string{
		"s0": "   The fire began.   ",
	}
	got := RebuildManuscript(ids, committed, nil)
	want := "The fire began.\n"
	if got != want {
		t.Errorf("RebuildManuscript (tidy) = %q, want %q", got, want)
	}
}
