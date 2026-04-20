package sentence

import (
	"strings"
)

type SentenceMatch struct {
	OldSentenceID string
	NewSentenceID string
	OldText       string
	NewText       string
	Similarity    float64
	MatchType     string // exact | high/moderate/low-similarity | deletion-nearest | positional-fallback
}

type SentenceDiff struct {
	Added     []string          // new-commit-only
	Deleted   []string          // old-commit-only
	Unchanged map[string]string // old id → new id (exact)
	OldTexts  map[string]string
	NewTexts  map[string]string
}

// ComputeSimilarity returns 1 − wordLevenshtein(norm1, norm2) / maxLen.
// Using a word tokenization avoids over-penalizing minor edits within words.
func ComputeSimilarity(text1, text2 string) float64 {
	norm1 := normalizeText(text1)
	norm2 := normalizeText(text2)

	words1 := strings.Fields(norm1)
	words2 := strings.Fields(norm2)

	if len(words1) == 0 && len(words2) == 0 {
		return 1.0
	}
	if len(words1) == 0 || len(words2) == 0 {
		return 0.0
	}

	distance := levenshteinDistance(words1, words2)
	maxLen := max(len(words1), len(words2))

	similarity := 1.0 - (float64(distance) / float64(maxLen))

	return similarity
}

func levenshteinDistance(words1, words2 []string) int {
	m := len(words1)
	n := len(words2)

	d := make([][]int, m+1)
	for i := range d {
		d[i] = make([]int, n+1)
	}

	for i := 0; i <= m; i++ {
		d[i][0] = i
	}
	for j := 0; j <= n; j++ {
		d[0][j] = j
	}

	for i := 1; i <= m; i++ {
		for j := 1; j <= n; j++ {
			cost := 1
			if words1[i-1] == words2[j-1] {
				cost = 0
			}

			d[i][j] = min3(
				d[i-1][j]+1,      // deletion
				d[i][j-1]+1,      // insertion
				d[i-1][j-1]+cost, // substitution
			)
		}
	}

	return d[m][n]
}

func min3(a, b, c int) int {
	if a < b {
		if a < c {
			return a
		}
		return c
	}
	if b < c {
		return b
	}
	return c
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// ComputeSentenceDiff: added (new-only), deleted (old-only), and exact
// matches (pairs with identical normalized text).
func ComputeSentenceDiff(oldSentences, newSentences map[string]string) *SentenceDiff {
	diff := &SentenceDiff{
		Unchanged: make(map[string]string),
		OldTexts:  oldSentences,
		NewTexts:  newSentences,
	}

	// Normalized text → []id, for exact matching.
	oldNormalized := make(map[string][]string)
	for id, text := range oldSentences {
		norm := normalizeText(text)
		oldNormalized[norm] = append(oldNormalized[norm], id)
	}

	newNormalized := make(map[string][]string)
	for id, text := range newSentences {
		norm := normalizeText(text)
		newNormalized[norm] = append(newNormalized[norm], id)
	}

	matchedNew := make(map[string]bool)
	matchedOld := make(map[string]bool)

	for norm, oldIDs := range oldNormalized {
		if newIDs, exists := newNormalized[norm]; exists {
			minLen := min(len(oldIDs), len(newIDs))
			for i := 0; i < minLen; i++ {
				diff.Unchanged[oldIDs[i]] = newIDs[i]
				matchedOld[oldIDs[i]] = true
				matchedNew[newIDs[i]] = true
			}
		}
	}

	for id := range oldSentences {
		if !matchedOld[id] {
			diff.Deleted = append(diff.Deleted, id)
		}
	}

	for id := range newSentences {
		if !matchedNew[id] {
			diff.Added = append(diff.Added, id)
		}
	}

	return diff
}

// ComputeMigrationMap produces old→new SentenceMatches with MatchType set by
// similarity thresholds; low-similarity deletions get MatchType="deletion-nearest"
// and empty NewSentenceID for the caller's ordinal-based fallback.
func ComputeMigrationMap(diff *SentenceDiff) []SentenceMatch {
	var matches []SentenceMatch

	for oldID, newID := range diff.Unchanged {
		matches = append(matches, SentenceMatch{
			OldSentenceID: oldID,
			NewSentenceID: newID,
			OldText:       diff.OldTexts[oldID],
			NewText:       diff.NewTexts[newID],
			Similarity:    1.0,
			MatchType:     "exact",
		})
	}

	for _, oldID := range diff.Deleted {
		oldText := diff.OldTexts[oldID]
		bestMatch := ""
		bestSimilarity := 0.0

		for _, newID := range diff.Added {
			newText := diff.NewTexts[newID]
			similarity := ComputeSimilarity(oldText, newText)

			if similarity > bestSimilarity {
				bestSimilarity = similarity
				bestMatch = newID
			}
		}

		matchType := "positional-fallback"
		if bestSimilarity >= 0.80 {
			matchType = "high-similarity"
		} else if bestSimilarity >= 0.60 {
			matchType = "moderate-similarity"
		} else if bestSimilarity >= 0.40 {
			matchType = "low-similarity"
		} else {
			matchType = "deletion-nearest"
			bestMatch = ""
		}

		if bestMatch != "" {
			matches = append(matches, SentenceMatch{
				OldSentenceID: oldID,
				NewSentenceID: bestMatch,
				OldText:       oldText,
				NewText:       diff.NewTexts[bestMatch],
				Similarity:    bestSimilarity,
				MatchType:     matchType,
			})
		} else {
			matches = append(matches, SentenceMatch{
				OldSentenceID: oldID,
				NewSentenceID: "",
				OldText:       oldText,
				NewText:       "",
				Similarity:    0.10,
				MatchType:     "deletion-nearest",
			})
		}
	}

	return matches
}
