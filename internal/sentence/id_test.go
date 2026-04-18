package sentence

import (
	"testing"
)

func TestGenerateSentenceID(t *testing.T) {
	tests := []struct {
		name       string
		text       string
		ordinal    int
		commitHash string
		// We don't test exact hash output, but verify format and determinism
	}{
		{
			name:       "Three word sentence",
			text:       "Kostya looked around the room.",
			ordinal:    42,
			commitHash: "abc123def456",
		},
		{
			name:       "Single word",
			text:       "V",
			ordinal:    0,
			commitHash: "abc123def456",
		},
		{
			name:       "Two words",
			text:       "Gone now.",
			ordinal:    15,
			commitHash: "abc123def456",
		},
		{
			name:       "Four words (uses first three)",
			text:       "No, but you should.",
			ordinal:    100,
			commitHash: "def456ghi789",
		},
		{
			name:       "With punctuation",
			text:       "\"Hello,\" she said.",
			ordinal:    5,
			commitHash: "abc123def456",
		},
		{
			name:       "Empty words (special case)",
			text:       "***",
			ordinal:    10,
			commitHash: "abc123def456",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Generate ID
			id := GenerateSentenceID(tt.text, tt.ordinal, tt.commitHash)

			// Verify format: should contain at least one dash and end with 8 hex chars
			if len(id) < 10 { // At minimum: "x-12345678"
				t.Errorf("ID too short: %q (len=%d)", id, len(id))
			}

			// Verify it ends with dash + 8 hex characters
			parts := id[len(id)-9:] // Last 9 chars should be "-xxxxxxxx"
			if parts[0] != '-' {
				t.Errorf("Expected dash before hex suffix in %q", id)
			}

			hexPart := parts[1:]
			if len(hexPart) != 8 {
				t.Errorf("Expected 8 hex chars, got %d in %q", len(hexPart), id)
			}

			// Verify hex chars are valid
			for _, c := range hexPart {
				if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
					t.Errorf("Invalid hex character %c in ID %q", c, id)
				}
			}

			// Test determinism: same input should produce same output
			id2 := GenerateSentenceID(tt.text, tt.ordinal, tt.commitHash)
			if id != id2 {
				t.Errorf("Non-deterministic ID generation:\nFirst:  %q\nSecond: %q", id, id2)
			}

			// Test that different inputs produce different IDs
			id3 := GenerateSentenceID(tt.text, tt.ordinal+1, tt.commitHash)
			if id == id3 {
				t.Errorf("Same ID for different ordinals: %q", id)
			}

			id4 := GenerateSentenceID(tt.text, tt.ordinal, tt.commitHash+"different")
			if id == id4 {
				t.Errorf("Same ID for different commit hashes: %q", id)
			}
		})
	}
}

func TestGenerateSentenceID_Examples(t *testing.T) {
	// Test specific examples from PLAN.md to verify format
	tests := []struct {
		text       string
		ordinal    int
		commitHash string
		prefix     string // Expected prefix (before the hash)
	}{
		{
			text:       "Kostya looked around the room.",
			ordinal:    42,
			commitHash: "abc123",
			prefix:     "kostya-looked-around",
		},
		{
			text:       "V",
			ordinal:    0,
			commitHash: "abc123",
			prefix:     "v",
		},
		{
			text:       "Yea.",
			ordinal:    15,
			commitHash: "abc123",
			prefix:     "yea",
		},
		{
			text:       "No, but you should.",
			ordinal:    100,
			commitHash: "def456",
			prefix:     "no-but-you",
		},
		{
			text:       "***",
			ordinal:    10,
			commitHash: "abc123",
			prefix:     "heading",
		},
	}

	for _, tt := range tests {
		t.Run(tt.text, func(t *testing.T) {
			id := GenerateSentenceID(tt.text, tt.ordinal, tt.commitHash)

			// Check prefix
			if !startsWithPrefix(id, tt.prefix) {
				t.Errorf("Expected ID to start with %q, got %q", tt.prefix, id)
			}

			// Verify format
			expectedMinLen := len(tt.prefix) + 1 + 8 // prefix + dash + 8 hex chars
			if len(id) != expectedMinLen {
				t.Errorf("Expected ID length %d, got %d: %q",
					expectedMinLen, len(id), id)
			}
		})
	}
}

func TestGenerateSentenceID_Collision(t *testing.T) {
	// Test that we don't get collisions for common scenarios
	const commitHash = "abc123def456"
	seen := make(map[string]bool)

	sentences := []string{
		"The sun was setting.",
		"The sun was rising.",
		"The sun was bright.",
		"The moon was full.",
		"The stars were out.",
	}

	for ordinal, text := range sentences {
		id := GenerateSentenceID(text, ordinal, commitHash)

		if seen[id] {
			t.Errorf("Collision detected: ID %q generated twice", id)
		}
		seen[id] = true
	}

	// Same sentence at different ordinals should produce different IDs
	text := "The sun was setting."
	for ordinal := 0; ordinal < 10; ordinal++ {
		id := GenerateSentenceID(text, ordinal, commitHash)

		if seen[id] && ordinal > 0 {
			t.Errorf("Collision for same sentence at different ordinals: %q", id)
			break
		}
		seen[id] = true
	}
}

func startsWithPrefix(id, prefix string) bool {
	if len(id) < len(prefix) {
		return false
	}
	return id[:len(prefix)] == prefix
}
