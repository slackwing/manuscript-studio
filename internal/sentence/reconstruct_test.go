package sentence

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestReconstruct_SmallCases pins down the per-branch behavior of Reconstruct
// directly (without going through TokenizeWithMarkers) so that an erroneous
// edit to one specific branch is caught even if the round-trip test happens
// not to hit that branch with the current testdata corpus.
func TestReconstruct_SmallCases(t *testing.T) {
	cases := []struct {
		name      string
		sentences []string
		want      string
	}{
		{
			name:      "two plain sentences in a paragraph share a single space",
			sentences: []string{"One.", "Two."},
			want:      "One. Two.\n",
		},
		{
			name:      "# is content; a following \\n\\n marker still gives a blank-line gap",
			sentences: []string{"# H", "\n\nBody."},
			want:      "# H\n\nBody.\n",
		},
		{
			name:      "section marker mid-paragraph emits the blank-line gap verbatim",
			sentences: []string{"One.", "\n\nNew section."},
			want:      "One.\n\nNew section.\n",
		},
		{
			name:      "paragraph marker emits its leading \\n\\t as-is",
			sentences: []string{"One.", "\n\tIndented."},
			want:      "One.\n\tIndented.\n",
		},
		{
			name:      "# is content; followed by plain sentence it's a continuation (no blank line)",
			sentences: []string{"# H", "Body."},
			want:      "# H Body.\n",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := Reconstruct(tc.sentences)
			if got != tc.want {
				t.Fatalf("got %q want %q", got, tc.want)
			}
		})
	}
}

// TestTokenizeReconstructRoundTrip is the contract that justifies the
// raw-text storage shape: parsing a manuscript and reconstructing it
// from the resulting sentence list should round-trip to (nearly) the
// same bytes. The relaxation is around dropped segments (segman
// produces stuff like a lone ".") — those characters can't survive a
// round-trip because we don't store them. We assert idempotency:
// parsing the reconstructed output yields the same sentence list.
func TestTokenizeReconstructRoundTrip(t *testing.T) {
	tk := NewTokenizer()

	manuscripts, err := filepath.Glob("../../testdata/manuscripts/*.manuscript")
	if err != nil {
		t.Fatalf("glob manuscripts: %v", err)
	}
	if len(manuscripts) == 0 {
		t.Fatalf("no test manuscripts found")
	}

	for _, path := range manuscripts {
		t.Run(filepath.Base(path), func(t *testing.T) {
			src, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("read: %v", err)
			}

			sentences := tk.TokenizeWithMarkers(string(src))
			if len(sentences) == 0 {
				t.Fatalf("zero sentences from non-empty file")
			}

			for i, s := range sentences {
				if err := ValidateSentenceText(s); err != nil {
					t.Errorf("sentence %d failed validation: %v", i, err)
				}
			}

			reconstructed := Reconstruct(sentences)

			// Idempotency: re-tokenize reconstructed → same sentence list.
			retokenized := tk.TokenizeWithMarkers(reconstructed)
			if len(retokenized) != len(sentences) {
				t.Fatalf("idempotency failed: %d sentences first, %d after re-tokenize",
					len(sentences), len(retokenized))
			}
			drift := 0
			for i := range sentences {
				if sentences[i] != retokenized[i] {
					if drift < 3 {
						t.Errorf("sentence %d drifted on re-tokenize:\n  before: %q\n  after:  %q",
							i, sentences[i], retokenized[i])
					}
					drift++
				}
			}
			if drift > 0 {
				t.Errorf("total %d sentences drifted on re-tokenize", drift)
			}

			origNorm := NormalizeText(string(src))
			reconNorm := NormalizeText(reconstructed)
			prefix := reconNorm
			if len(prefix) > 200 {
				prefix = prefix[:200]
			}
			if !strings.Contains(origNorm, prefix) {
				t.Errorf("reconstructed prefix not found in original")
			}
		})
	}
}

// Em-dash glue (2026-10-11): sentences glued at an em dash — the first
// ending on "—" or the next opening on "—" — join with NO space when the
// push rebuilds the file, and migration reads the result back as one
// sentence (segman never cuts beside a mid-paragraph dash).
func TestReconstructEmDashGlue(t *testing.T) {
	cases := []struct {
		in   []string
		want string
	}{
		{[]string{"He said", "—he sounded composed all of a sudden—", "Then he left."},
			"He said—he sounded composed all of a sudden—Then he left.\n"},
		{[]string{"A.", "B."}, "A. B.\n"},                                  // ordinary continuation keeps its space
		{[]string{"Before.", "\n\t—A paragraph opens on a dash."}, "Before.\n\t—A paragraph opens on a dash.\n"}, // breaks untouched
		{[]string{"It ended—", "And yet."}, "It ended—And yet.\n"},         // trailing dash glues forward
	}
	for _, c := range cases {
		if got := Reconstruct(c.in); got != c.want {
			t.Errorf("Reconstruct(%q) = %q, want %q", c.in, got, c.want)
		}
	}

	// The owner's flow: the period dropped from the sentence before, the
	// next suggested as "—…—" → push → migration.
	ids := []string{"a", "b", "c"}
	committed := map[string]string{"a": "He said.", "b": "He sounded composed all of a sudden.", "c": "Then he left."}
	sugs := map[string]string{"a": "He said", "b": "—he sounded composed all of a sudden—"}
	file := RebuildManuscript(ids, committed, sugs)
	if file != "He said—he sounded composed all of a sudden—Then he left.\n" {
		t.Errorf("push file = %q", file)
	}
	rows := NewTokenizer().TokenizeWithMarkers(file)
	if len(rows) != 1 || rows[0] != "He said—he sounded composed all of a sudden—Then he left." {
		t.Errorf("after migration = %q", rows)
	}
}
