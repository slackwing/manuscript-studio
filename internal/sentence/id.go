package sentence

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
)

// GenerateSentenceID: "{first-three-words}-{8 hex}" where the hex is
// SHA-256(normalizedText + ordinal + commitHash) truncated to 8 chars.
// Sentences with no alphanumeric words (e.g. "***") get prefix "heading".
// See TestGenerateSentenceID.
func GenerateSentenceID(text string, ordinal int, commitHash string) string {
	words := ExtractWords(text)

	var prefix string
	numWords := min(3, len(words))
	if numWords == 0 {
		prefix = "heading"
	} else {
		prefix = strings.Join(words[:numWords], "-")
	}

	normalizedText := normalizeText(text)
	data := fmt.Sprintf("%s-%d-%s", normalizedText, ordinal, commitHash)
	hash := sha256.Sum256([]byte(data))
	suffix := hex.EncodeToString(hash[:4])

	return fmt.Sprintf("%s-%s", prefix, suffix)
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
