package sentence

import (
	"bytes"
	"fmt"

	"github.com/slackwing/manuscript-studio/internal/models"
)

// SuggestionApplyResult records what happened to one suggestion during
// ApplySuggestions: which sentence it was for, and whether the original
// text could be located in the source.
type SuggestionApplyResult struct {
	SentenceID string
	Applied    bool
	Reason     string // populated when Applied == false
}

// ApplySuggestions edits `source` (the raw .manuscript bytes) by replacing
// each suggestion's original sentence text with its proposed replacement.
// Originals come from the {sentenceID → originalText} map; replacements
// come from each SuggestedChange.Text.
//
// Single substring replacement per sentence (only the FIRST occurrence is
// replaced, so a sentence text that happens to recur elsewhere in the file
// won't double-apply). Originals not found in the source are skipped with
// a reason — the rest still apply, so a partial PR is still useful.
//
// Pure function: no I/O, deterministic, easy to unit-test.
func ApplySuggestions(
	source []byte,
	suggestions []models.SuggestedChange,
	originalsBySentenceID map[string]string,
) ([]byte, []SuggestionApplyResult) {
	out := source
	results := make([]SuggestionApplyResult, 0, len(suggestions))

	for _, s := range suggestions {
		original, ok := originalsBySentenceID[s.SentenceID]
		if !ok || original == "" {
			results = append(results, SuggestionApplyResult{
				SentenceID: s.SentenceID,
				Applied:    false,
				Reason:     "original sentence text unknown",
			})
			continue
		}
		if !bytes.Contains(out, []byte(original)) {
			results = append(results, SuggestionApplyResult{
				SentenceID: s.SentenceID,
				Applied:    false,
				Reason:     fmt.Sprintf("original text not found in source (likely hand-edited): %q", truncate(original)),
			})
			continue
		}
		out = bytes.Replace(out, []byte(original), []byte(s.Text), 1)
		results = append(results, SuggestionApplyResult{
			SentenceID: s.SentenceID,
			Applied:    true,
		})
	}

	return out, results
}
