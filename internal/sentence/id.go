package sentence

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
)

// GenerateSentenceID creates a deterministic sentence ID
// Format: {first-three-words}-{8-hex-chars}
// The 8 hex chars are derived from SHA-256 hash of: normalizedText + ordinal + commitHash
func GenerateSentenceID(text string, ordinal int, commitHash string) string {
	// Extract first three alphanumeric words
	words := ExtractWords(text)

	// Build prefix from first 1-3 words
	var prefix string
	numWords := min(3, len(words))
	if numWords == 0 {
		// No words (e.g., scene break markers like "***")
		prefix = "heading"
	} else {
		prefix = strings.Join(words[:numWords], "-")
	}

	// Generate deterministic 8-character hex suffix
	normalizedText := normalizeText(text)
	data := fmt.Sprintf("%s-%d-%s", normalizedText, ordinal, commitHash)
	hash := sha256.Sum256([]byte(data))
	suffix := hex.EncodeToString(hash[:4]) // First 4 bytes = 8 hex chars

	return fmt.Sprintf("%s-%s", prefix, suffix)
}

// min returns the minimum of two integers
func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
