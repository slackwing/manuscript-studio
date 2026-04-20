package sentence

import (
	"testing"
)

func TestComputeSimilarity(t *testing.T) {
	tests := []struct {
		name   string
		text1  string
		text2  string
		minSim float64
		maxSim float64
	}{
		{
			name:   "Identical texts",
			text1:  "The quick brown fox",
			text2:  "The quick brown fox",
			minSim: 1.0,
			maxSim: 1.0,
		},
		{
			name:   "Minor edit",
			text1:  "The quick brown fox jumps",
			text2:  "The quick brown fox leaps",
			minSim: 0.75,
			maxSim: 0.85,
		},
		{
			name:   "Punctuation difference only",
			text1:  "Hello, world!",
			text2:  "Hello world",
			minSim: 1.0,
			maxSim: 1.0,
		},
		{
			name:   "Case difference only",
			text1:  "HELLO WORLD",
			text2:  "hello world",
			minSim: 1.0,
			maxSim: 1.0,
		},
		{
			name:   "Completely different",
			text1:  "The cat sat on the mat",
			text2:  "Dogs are barking loudly",
			minSim: 0.0,
			maxSim: 0.3,
		},
		{
			name:   "One word changed",
			text1:  "I love programming",
			text2:  "I love coding",
			minSim: 0.60,
			maxSim: 0.70,
		},
		{
			name:   "Word added",
			text1:  "She walked",
			text2:  "She walked quickly",
			minSim: 0.60,
			maxSim: 0.75,
		},
		{
			name:   "Word removed",
			text1:  "He said hello there",
			text2:  "He said there",
			minSim: 0.70,
			maxSim: 0.80,
		},
		{
			name:   "Empty strings",
			text1:  "",
			text2:  "",
			minSim: 1.0,
			maxSim: 1.0,
		},
		{
			name:   "One empty",
			text1:  "Something",
			text2:  "",
			minSim: 0.0,
			maxSim: 0.0,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			sim := ComputeSimilarity(tt.text1, tt.text2)

			if sim < tt.minSim || sim > tt.maxSim {
				t.Errorf("Similarity %.3f out of expected range [%.3f, %.3f] for:\n  Text1: %q\n  Text2: %q",
					sim, tt.minSim, tt.maxSim, tt.text1, tt.text2)
			} else {
				t.Logf("✓ Similarity: %.3f (expected [%.3f, %.3f])", sim, tt.minSim, tt.maxSim)
			}
		})
	}
}

func TestLevenshteinDistance(t *testing.T) {
	tests := []struct {
		name     string
		words1   []string
		words2   []string
		expected int
	}{
		{
			name:     "Identical",
			words1:   []string{"hello", "world"},
			words2:   []string{"hello", "world"},
			expected: 0,
		},
		{
			name:     "One substitution",
			words1:   []string{"hello", "world"},
			words2:   []string{"hello", "earth"},
			expected: 1,
		},
		{
			name:     "One insertion",
			words1:   []string{"hello", "world"},
			words2:   []string{"hello", "beautiful", "world"},
			expected: 1,
		},
		{
			name:     "One deletion",
			words1:   []string{"hello", "beautiful", "world"},
			words2:   []string{"hello", "world"},
			expected: 1,
		},
		{
			name:     "Multiple operations",
			words1:   []string{"the", "quick", "brown", "fox"},
			words2:   []string{"the", "slow", "red", "fox", "jumped"},
			expected: 3, // quick→slow + brown→red + insert "jumped"
		},
		{
			name:     "Empty arrays",
			words1:   []string{},
			words2:   []string{},
			expected: 0,
		},
		{
			name:     "One empty",
			words1:   []string{"hello", "world"},
			words2:   []string{},
			expected: 2,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dist := levenshteinDistance(tt.words1, tt.words2)
			if dist != tt.expected {
				t.Errorf("Expected distance %d, got %d for:\n  %v\n  %v",
					tt.expected, dist, tt.words1, tt.words2)
			}
		})
	}
}

func TestComputeSentenceDiff(t *testing.T) {
	tests := []struct {
		name             string
		oldSentences     map[string]string
		newSentences     map[string]string
		expectedAdded    int
		expectedDeleted  int
		expectedUnchanged int
	}{
		{
			// Matching is by normalized text, so different ids with same text count as unchanged.
			name: "No changes",
			oldSentences: map[string]string{
				"id1": "The cat sat.",
				"id2": "The dog barked.",
			},
			newSentences: map[string]string{
				"id3": "The cat sat.",
				"id4": "The dog barked.",
			},
			expectedAdded:    0,
			expectedDeleted:  0,
			expectedUnchanged: 2,
		},
		{
			name: "One added",
			oldSentences: map[string]string{
				"id1": "The cat sat.",
			},
			newSentences: map[string]string{
				"id2": "The cat sat.",
				"id3": "The dog barked.",
			},
			expectedAdded:    1,
			expectedDeleted:  0,
			expectedUnchanged: 1,
		},
		{
			name: "One deleted",
			oldSentences: map[string]string{
				"id1": "The cat sat.",
				"id2": "The dog barked.",
			},
			newSentences: map[string]string{
				"id3": "The cat sat.",
			},
			expectedAdded:    0,
			expectedDeleted:  1,
			expectedUnchanged: 1,
		},
		{
			name: "One edited (counts as delete + add)",
			oldSentences: map[string]string{
				"id1": "The cat sat on the mat.",
			},
			newSentences: map[string]string{
				"id2": "The cat sat on the rug.",
			},
			expectedAdded:    1,
			expectedDeleted:  1,
			expectedUnchanged: 0,
		},
		{
			name: "Mix of changes",
			oldSentences: map[string]string{
				"id1": "Sentence one.",
				"id2": "Sentence two.",
				"id3": "Sentence three.",
			},
			newSentences: map[string]string{
				"id4": "Sentence one.",
				"id5": "Sentence two EDIT.",
				"id6": "Sentence four.",
			},
			expectedAdded:    2,
			expectedDeleted:  2,
			expectedUnchanged: 1,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			diff := ComputeSentenceDiff(tt.oldSentences, tt.newSentences)

			if len(diff.Added) != tt.expectedAdded {
				t.Errorf("Expected %d added, got %d: %v",
					tt.expectedAdded, len(diff.Added), diff.Added)
			}

			if len(diff.Deleted) != tt.expectedDeleted {
				t.Errorf("Expected %d deleted, got %d: %v",
					tt.expectedDeleted, len(diff.Deleted), diff.Deleted)
			}

			if len(diff.Unchanged) != tt.expectedUnchanged {
				t.Errorf("Expected %d unchanged, got %d: %v",
					tt.expectedUnchanged, len(diff.Unchanged), diff.Unchanged)
			}

			t.Logf("✓ Added: %d, Deleted: %d, Unchanged: %d",
				len(diff.Added), len(diff.Deleted), len(diff.Unchanged))
		})
	}
}

func TestComputeMigrationMap(t *testing.T) {
	tests := []struct {
		name         string
		oldSentences map[string]string
		newSentences map[string]string
		checkMatch   func(*testing.T, []SentenceMatch)
	}{
		{
			name: "Exact matches only",
			oldSentences: map[string]string{
				"old1": "The cat sat.",
				"old2": "The dog barked.",
			},
			newSentences: map[string]string{
				"new1": "The cat sat.",
				"new2": "The dog barked.",
			},
			checkMatch: func(t *testing.T, matches []SentenceMatch) {
				if len(matches) != 2 {
					t.Errorf("Expected 2 matches, got %d", len(matches))
					return
				}
				for _, m := range matches {
					if m.MatchType != "exact" {
						t.Errorf("Expected exact match, got %s", m.MatchType)
					}
					if m.Similarity != 1.0 {
						t.Errorf("Expected similarity 1.0, got %.3f", m.Similarity)
					}
				}
			},
		},
		{
			name: "High similarity match",
			oldSentences: map[string]string{
				"old1": "The quick brown fox jumps over the lazy dog.",
			},
			newSentences: map[string]string{
				"new1": "The quick brown fox leaps over the lazy dog.",
			},
			checkMatch: func(t *testing.T, matches []SentenceMatch) {
				if len(matches) != 1 {
					t.Errorf("Expected 1 match, got %d", len(matches))
					return
				}
				m := matches[0]
				if m.MatchType != "high-similarity" && m.MatchType != "moderate-similarity" {
					t.Errorf("Expected high or moderate similarity, got %s", m.MatchType)
				}
				if m.Similarity < 0.7 {
					t.Errorf("Expected similarity >= 0.7, got %.3f", m.Similarity)
				}
				t.Logf("✓ Match type: %s, similarity: %.3f", m.MatchType, m.Similarity)
			},
		},
		{
			name: "Deletion with no good match",
			oldSentences: map[string]string{
				"old1": "This sentence will be deleted.",
			},
			newSentences: map[string]string{
				"new1": "Completely different sentence here.",
			},
			checkMatch: func(t *testing.T, matches []SentenceMatch) {
				if len(matches) != 1 {
					t.Errorf("Expected 1 match, got %d", len(matches))
					return
				}
				m := matches[0]
				if m.Similarity > 0.4 {
					t.Errorf("Expected low similarity, got %.3f", m.Similarity)
				}
				t.Logf("✓ Match type: %s, similarity: %.3f", m.MatchType, m.Similarity)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			diff := ComputeSentenceDiff(tt.oldSentences, tt.newSentences)
			matches := ComputeMigrationMap(diff)
			tt.checkMatch(t, matches)
		})
	}
}
