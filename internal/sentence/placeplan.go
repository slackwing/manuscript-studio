package sentence

import "strings"

// Place-plan: per-sentence suggested edits that re-place a sketch region.
//
// The old placement plan put the ENTIRE new text on the opener sentence and
// blanket-deleted every interior sentence — unreviewable ("one green wall +
// one crossed-out wall"), and the delete artifacts outlived their purpose
// (2026-08-16). This planner aligns the region's current sentences against
// the segmented new text MONOTONICALLY and emits:
//   - nothing for unchanged sentences,
//   - a real per-sentence diff where a sentence changed,
//   - "" (the standard delete proposal) for removed sentences,
//   - added sentences attached, in order, to the nearest following match.
//
// INVARIANT: concatenating the effective results in sentence order equals
// the new text (modulo the whitespace canonicalize will tidy anyway) — the
// plan never loses or duplicates content. A wholesale rewrite degrades to
// deletes + the full text on the last slot, which is acceptable by design.

// PlaceOld is one interior region sentence: its id and EFFECTIVE text
// (pending suggestion if any, else committed).
type PlaceOld struct {
	ID   string
	Text string
}

// PlaceEdit is one planned suggestion.
type PlaceEdit struct {
	SentenceID string `json:"sentence_id"`
	Text       string `json:"text"`
}

// placeSimilarity scores two sentences 0..1: 1.0 for normalized equality,
// else the Dice coefficient of their word sets. Cheap and symmetric —
// region sizes are tens of sentences, so O(n·m) scoring is fine.
func placeSimilarity(a, b string) float64 {
	na, nb := NormalizeText(a), NormalizeText(b)
	if na == nb {
		return 1.0
	}
	wa, wb := strings.Fields(na), strings.Fields(nb)
	if len(wa) == 0 || len(wb) == 0 {
		return 0
	}
	set := make(map[string]int, len(wa))
	for _, w := range wa {
		set[w]++
	}
	common := 0
	for _, w := range wb {
		if set[w] > 0 {
			set[w]--
			common++
		}
	}
	return 2.0 * float64(common) / float64(len(wa)+len(wb))
}

const placeMatchThreshold = 0.55

// PlacePlan aligns the region's interior sentences against newText's
// sentences and returns the suggestion set (unchanged sentences omitted).
func PlacePlan(oldSentences []PlaceOld, newText string) []PlaceEdit {
	// TokenizeWithMarkers — the SAME marker-aware segmentation the migration
	// pipeline uses, so \n\t / \n\n paragraph starts ride on the sentences.
	newSents := NewTokenizer().TokenizeWithMarkers(strings.TrimRight(newText, " \t\n"))
	n, m := len(oldSentences), len(newSents)

	// Monotonic alignment: LCS-style DP maximizing summed similarity over
	// pairs that clear the threshold.
	sim := make([][]float64, n+1)
	dp := make([][]float64, n+1)
	for i := range sim {
		sim[i] = make([]float64, m+1)
		dp[i] = make([]float64, m+1)
	}
	for i := 1; i <= n; i++ {
		for j := 1; j <= m; j++ {
			s := placeSimilarity(oldSentences[i-1].Text, newSents[j-1])
			if s >= placeMatchThreshold {
				sim[i][j] = s
			}
			best := dp[i-1][j]
			if dp[i][j-1] > best {
				best = dp[i][j-1]
			}
			if sim[i][j] > 0 && dp[i-1][j-1]+sim[i][j] > best {
				best = dp[i-1][j-1] + sim[i][j]
			}
			dp[i][j] = best
		}
	}
	// Backtrack into pairs: pairOf[oldIdx] = newIdx (0-based), -1 = unpaired.
	pairOf := make([]int, n)
	for i := range pairOf {
		pairOf[i] = -1
	}
	for i, j := n, m; i > 0 && j > 0; {
		switch {
		case sim[i][j] > 0 && dp[i][j] == dp[i-1][j-1]+sim[i][j]:
			pairOf[i-1] = j - 1
			i--
			j--
		case dp[i][j] == dp[i-1][j]:
			i--
		default:
			j--
		}
	}

	// Emit in old-sentence order, threading unpaired new sentences into the
	// suggestion of the next paired old sentence so document order holds.
	join := func(parts []string) string {
		var b strings.Builder
		for k, p := range parts {
			if k > 0 && !strings.HasPrefix(p, "\n") {
				b.WriteString(" ")
			}
			b.WriteString(p)
		}
		return b.String()
	}
	edits := []PlaceEdit{}
	newPtr := 0
	lastSlot := -1 // index into edits of the last emitted (or virtual) slot
	emitted := make(map[int]int)
	for i := 0; i < n; i++ {
		old := oldSentences[i]
		if pairOf[i] >= 0 {
			j := pairOf[i]
			text := join(newSents[newPtr : j+1])
			newPtr = j + 1
			if text != old.Text {
				edits = append(edits, PlaceEdit{SentenceID: old.ID, Text: text})
				emitted[i] = len(edits) - 1
			}
			lastSlot = i
			continue
		}
		edits = append(edits, PlaceEdit{SentenceID: old.ID, Text: ""})
		emitted[i] = len(edits) - 1
		lastSlot = i
	}
	// Trailing new sentences (after the last pair) append to the last slot.
	if newPtr < m && lastSlot >= 0 {
		tail := join(newSents[newPtr:m])
		if idx, ok := emitted[lastSlot]; ok {
			edits[idx].Text = join([]string{edits[idx].Text, tail})
			if strings.TrimSpace(edits[idx].Text) == strings.TrimSpace(tail) {
				edits[idx].Text = tail // was a delete slot — tail replaces it
			}
		} else {
			// Last slot was an UNCHANGED sentence — suggest old + tail.
			old := oldSentences[lastSlot]
			edits = append(edits, PlaceEdit{SentenceID: old.ID, Text: join([]string{old.Text, tail})})
		}
	} else if newPtr < m && n > 0 {
		// No slots at all (empty region interior can't happen — guarded by caller).
		edits = append(edits, PlaceEdit{SentenceID: oldSentences[n-1].ID, Text: join(newSents[newPtr:m])})
	}
	return edits
}
