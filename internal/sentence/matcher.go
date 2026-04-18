package sentence

import (
	"strings"
)

// SentenceMatch represents a potential match between old and new sentences
type SentenceMatch struct {
	OldSentenceID string
	NewSentenceID string
	OldText       string
	NewText       string
	Similarity    float64
	MatchType     string // "exact", "high-similarity", "moderate-similarity", "low-similarity", "deletion-nearest", "positional-fallback"
}

// SentenceDiff represents changes between two commits
type SentenceDiff struct {
	Added     []string            // Sentence IDs only in new commit
	Deleted   []string            // Sentence IDs only in old commit
	Unchanged map[string]string   // Map of old ID -> new ID for exact matches
	OldTexts  map[string]string   // Map of sentence ID -> text (for old sentences)
	NewTexts  map[string]string   // Map of sentence ID -> text (for new sentences)
}

// ComputeSimilarity calculates similarity between two texts at word level
// Uses Levenshtein distance on word arrays for better semantic matching
func ComputeSimilarity(text1, text2 string) float64 {
	// Normalize both texts
	norm1 := normalizeText(text1)
	norm2 := normalizeText(text2)

	// Extract words
	words1 := strings.Fields(norm1)
	words2 := strings.Fields(norm2)

	// Handle empty cases
	if len(words1) == 0 && len(words2) == 0 {
		return 1.0
	}
	if len(words1) == 0 || len(words2) == 0 {
		return 0.0
	}

	// Compute word-level Levenshtein distance
	distance := levenshteinDistance(words1, words2)
	maxLen := max(len(words1), len(words2))

	// Convert distance to similarity (0.0 to 1.0)
	similarity := 1.0 - (float64(distance) / float64(maxLen))

	return similarity
}

// levenshteinDistance computes the Levenshtein distance between two word arrays
func levenshteinDistance(words1, words2 []string) int {
	m := len(words1)
	n := len(words2)

	// Create distance matrix
	d := make([][]int, m+1)
	for i := range d {
		d[i] = make([]int, n+1)
	}

	// Initialize base cases
	for i := 0; i <= m; i++ {
		d[i][0] = i
	}
	for j := 0; j <= n; j++ {
		d[0][j] = j
	}

	// Fill in the matrix
	for i := 1; i <= m; i++ {
		for j := 1; j <= n; j++ {
			cost := 1
			if words1[i-1] == words2[j-1] {
				cost = 0
			}

			d[i][j] = min3(
				d[i-1][j]+1,   // deletion
				d[i][j-1]+1,   // insertion
				d[i-1][j-1]+cost, // substitution
			)
		}
	}

	return d[m][n]
}

// min3 returns the minimum of three integers
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

// max returns the maximum of two integers
func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// ComputeSentenceDiff identifies added, deleted, and unchanged sentences
func ComputeSentenceDiff(oldSentences, newSentences map[string]string) *SentenceDiff {
	diff := &SentenceDiff{
		Unchanged: make(map[string]string),
		OldTexts:  oldSentences,
		NewTexts:  newSentences,
	}

	// Build normalized text lookup for exact matching
	oldNormalized := make(map[string][]string) // normalized text -> []sentence IDs
	for id, text := range oldSentences {
		norm := normalizeText(text)
		oldNormalized[norm] = append(oldNormalized[norm], id)
	}

	newNormalized := make(map[string][]string)
	for id, text := range newSentences {
		norm := normalizeText(text)
		newNormalized[norm] = append(newNormalized[norm], id)
	}

	// Find exact matches (unchanged sentences)
	matchedNew := make(map[string]bool)
	matchedOld := make(map[string]bool)

	for norm, oldIDs := range oldNormalized {
		if newIDs, exists := newNormalized[norm]; exists {
			// Match up old and new sentences with same normalized text
			minLen := min(len(oldIDs), len(newIDs))
			for i := 0; i < minLen; i++ {
				diff.Unchanged[oldIDs[i]] = newIDs[i]
				matchedOld[oldIDs[i]] = true
				matchedNew[newIDs[i]] = true
			}
		}
	}

	// Identify deleted sentences (in old but not matched)
	for id := range oldSentences {
		if !matchedOld[id] {
			diff.Deleted = append(diff.Deleted, id)
		}
	}

	// Identify added sentences (in new but not matched)
	for id := range newSentences {
		if !matchedNew[id] {
			diff.Added = append(diff.Added, id)
		}
	}

	return diff
}

// ComputeMigrationMap creates a mapping from old sentence IDs to new sentence IDs
// with confidence scores and match types
func ComputeMigrationMap(diff *SentenceDiff) []SentenceMatch {
	var matches []SentenceMatch

	// Exact matches (unchanged sentences)
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

	// For deleted sentences, find best fuzzy matches in added sentences
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

		// Determine match type based on similarity threshold
		matchType := "positional-fallback"
		if bestSimilarity >= 0.80 {
			matchType = "high-similarity"
		} else if bestSimilarity >= 0.60 {
			matchType = "moderate-similarity"
		} else if bestSimilarity >= 0.40 {
			matchType = "low-similarity"
		} else {
			// If no good match found, this will be handled as deletion-nearest
			matchType = "deletion-nearest"
			bestMatch = "" // Will be resolved later with ordinal-based fallback
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
			// No good match - mark for deletion-nearest handling
			matches = append(matches, SentenceMatch{
				OldSentenceID: oldID,
				NewSentenceID: "", // To be resolved
				OldText:       oldText,
				NewText:       "",
				Similarity:    0.10, // Low confidence for deletion
				MatchType:     "deletion-nearest",
			})
		}
	}

	return matches
}
