package sentence

// RebuildManuscript produces the canonical .manuscript bytes for a migration
// from its ordered sentences overlaid with a user's suggestions. It mirrors the
// client render loop (web/js/renderer.js): for each sentence in ordinal order,
// take the suggestion if present else the committed text, Canonicalize it, then
// Reconstruct the whole document. This is the AUTHORITATIVE push source —
// "what you see is what you push" holds because both sides run the same
// per-sentence Canonicalize.
//
// suggestionsByID maps sentenceID -> suggested text (only entries that changed).
// orderedSentences must be in ordinal order.
//
// Because Canonicalize is idempotent, re-running RebuildManuscript on an
// already-canonical migration is a no-op — the file converges and stays put.
func RebuildManuscript(orderedSentenceIDs []string, committedByID map[string]string, suggestionsByID map[string]string) string {
	effective := make([]string, 0, len(orderedSentenceIDs))
	for _, id := range orderedSentenceIDs {
		text, ok := committedByID[id]
		if !ok {
			continue
		}
		if sug, has := suggestionsByID[id]; has {
			text = sug
		}
		effective = append(effective, Canonicalize(text))
	}
	return Reconstruct(effective)
}
