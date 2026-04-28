package sentence

import (
	"testing"
)

func TestGenerateSentenceID(t *testing.T) {
	// We assert format and determinism rather than exact hash bytes.
	tests := []struct {
		name       string
		text       string
		ordinal    int
		commitHash string
		segVer     string
	}{
		{
			name:       "Three word sentence",
			text:       "Kostya looked around the room.",
			ordinal:    42,
			commitHash: "abc123def456",
			segVer:     "segman-1.0.0",
		},
		{
			name:       "Single word",
			text:       "V",
			ordinal:    0,
			commitHash: "abc123def456",
			segVer:     "segman-1.0.0",
		},
		{
			name:       "Two words",
			text:       "Gone now.",
			ordinal:    15,
			commitHash: "abc123def456",
			segVer:     "segman-1.0.0",
		},
		{
			name:       "Four words (uses first three)",
			text:       "No, but you should.",
			ordinal:    100,
			commitHash: "def456ghi789",
			segVer:     "segman-1.0.0",
		},
		{
			name:       "With punctuation",
			text:       "\"Hello,\" she said.",
			ordinal:    5,
			commitHash: "abc123def456",
			segVer:     "segman-1.0.0",
		},
		{
			name:       "Empty words (special case)",
			text:       "***",
			ordinal:    10,
			commitHash: "abc123def456",
			segVer:     "segman-1.0.0",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			id := GenerateSentenceID(tt.text, tt.ordinal, tt.commitHash, tt.segVer)

			if len(id) < 10 { // minimum shape is "x-12345678"
				t.Errorf("ID too short: %q (len=%d)", id, len(id))
			}

			parts := id[len(id)-9:]
			if parts[0] != '-' {
				t.Errorf("Expected dash before hex suffix in %q", id)
			}

			hexPart := parts[1:]
			if len(hexPart) != 8 {
				t.Errorf("Expected 8 hex chars, got %d in %q", len(hexPart), id)
			}

			for _, c := range hexPart {
				if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
					t.Errorf("Invalid hex character %c in ID %q", c, id)
				}
			}

			id2 := GenerateSentenceID(tt.text, tt.ordinal, tt.commitHash, tt.segVer)
			if id != id2 {
				t.Errorf("Non-deterministic ID generation:\nFirst:  %q\nSecond: %q", id, id2)
			}

			id3 := GenerateSentenceID(tt.text, tt.ordinal+1, tt.commitHash, tt.segVer)
			if id == id3 {
				t.Errorf("Same ID for different ordinals: %q", id)
			}

			id4 := GenerateSentenceID(tt.text, tt.ordinal, tt.commitHash+"different", tt.segVer)
			if id == id4 {
				t.Errorf("Same ID for different commit hashes: %q", id)
			}

			// Bump the segmenter version → fresh ID. This is the property that
			// lets two segmenter versions coexist on the same commit without
			// PK collisions in the sentence table.
			id5 := GenerateSentenceID(tt.text, tt.ordinal, tt.commitHash, tt.segVer+"-bumped")
			if id == id5 {
				t.Errorf("Same ID for different segmenter versions: %q", id)
			}
		})
	}
}

// Sample pairs from PLAN.md, verifying prefix formation (not the full hash).
func TestGenerateSentenceID_Examples(t *testing.T) {
	const segVer = "segman-1.0.0"
	tests := []struct {
		text       string
		ordinal    int
		commitHash string
		prefix     string
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
			id := GenerateSentenceID(tt.text, tt.ordinal, tt.commitHash, segVer)

			if !startsWithPrefix(id, tt.prefix) {
				t.Errorf("Expected ID to start with %q, got %q", tt.prefix, id)
			}

			expectedMinLen := len(tt.prefix) + 1 + 8
			if len(id) != expectedMinLen {
				t.Errorf("Expected ID length %d, got %d: %q",
					expectedMinLen, len(id), id)
			}
		})
	}
}

func TestGenerateSentenceID_Collision(t *testing.T) {
	const commitHash = "abc123def456"
	const segVer = "segman-1.0.0"
	seen := make(map[string]bool)

	sentences := []string{
		"The sun was setting.",
		"The sun was rising.",
		"The sun was bright.",
		"The moon was full.",
		"The stars were out.",
	}

	for ordinal, text := range sentences {
		id := GenerateSentenceID(text, ordinal, commitHash, segVer)

		if seen[id] {
			t.Errorf("Collision detected: ID %q generated twice", id)
		}
		seen[id] = true
	}

	// Same sentence at different ordinals must not collide.
	text := "The sun was setting."
	for ordinal := 0; ordinal < 10; ordinal++ {
		id := GenerateSentenceID(text, ordinal, commitHash, segVer)

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

// Storage-shape change (UNIFIED_DATA_SHAPE_PLAN.md) preserves IDs because
// normalizeText strips both markdown and structural-whitespace markers
// before hashing.
func TestGenerateSentenceID_StableAcrossStorageShapes(t *testing.T) {
	const segVer = "segman-1.0.0"
	cases := []struct {
		stripped, raw string
	}{
		{"The fox jumped.", "*The* fox jumped."},
		{"The fox jumped.", "\n\tThe fox jumped."},
		{"The fox jumped.", "\n\nThe fox jumped."},
		{"The fox jumped.", "\n\t*The* fox jumped."},
		{"And how are you", "**And** how are you"},
	}
	commit := "abc123"
	for _, c := range cases {
		idStripped := GenerateSentenceID(c.stripped, 7, commit, segVer)
		idRaw := GenerateSentenceID(c.raw, 7, commit, segVer)
		if idStripped != idRaw {
			t.Errorf("ID mismatch:\n  stripped %q → %s\n  raw      %q → %s",
				c.stripped, idStripped, c.raw, idRaw)
		}
	}
}
