package sentence

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

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

			origNorm := normalizeText(string(src))
			reconNorm := normalizeText(reconstructed)
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
