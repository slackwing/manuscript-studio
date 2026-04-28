package sentence

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
)

// GenerateSentenceID: "{first-three-words}-{8 hex}" where the hex is
// SHA-256(normalizedText + ordinal + commitHash + segmenterVersion) truncated
// to 8 chars. Sentences with no alphanumeric words (e.g. "***") get prefix
// "heading". See TestGenerateSentenceID.
//
// segmenterVersion is part of the hash so a segmenter bump on the same commit
// always produces fresh IDs — different ID = different row, no PK collision
// when both old and new migrations want to coexist. Existing IDs in the DB
// were generated under the old 3-input formula and remain valid forever; this
// function only affects fresh writes.
func GenerateSentenceID(text string, ordinal int, commitHash, segmenterVersion string) string {
	words := ExtractWords(text)

	var prefix string
	numWords := min(3, len(words))
	if numWords == 0 {
		prefix = "heading"
	} else {
		prefix = strings.Join(words[:numWords], "-")
	}

	normalizedText := normalizeText(text)
	data := fmt.Sprintf("%s-%d-%s-%s", normalizedText, ordinal, commitHash, segmenterVersion)
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
