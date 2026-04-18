package sentence

import (
	"regexp"
	"strings"
	"unicode"

	"github.com/slackwing/manuscript-studio/internal/segmenter"
)

// Tokenizer handles sentence splitting using senseg library
type Tokenizer struct {
}

// NewTokenizer creates a new tokenizer
func NewTokenizer() *Tokenizer {
	return &Tokenizer{}
}

// SplitIntoSentences splits text into sentences using senseg library
func (t *Tokenizer) SplitIntoSentences(text string) []string {
	// Handle empty text
	if strings.TrimSpace(text) == "" {
		return []string{}
	}

	// Use segmenter library for sentence segmentation
	sentences := segmenter.Segment(text)

	// Apply boundary cleaning
	var result []string
	for _, sent := range sentences {
		cleaned := cleanSentenceBoundaries(sent)
		if cleaned != "" {
			result = append(result, cleaned)
		}
	}

	return result
}

// cleanSentenceBoundaries removes leading punctuation but keeps trailing punctuation
// This ensures cleaner highlighting boundaries in the UI
// Exceptions: Keeps quotes (", ') as they might start quoted sentences
func cleanSentenceBoundaries(text string) string {
	trimmed := strings.TrimSpace(text)

	// Remove leading punctuation (but NOT letters, numbers, quotes, or opening brackets)
	// Common sentence-joining punctuation: . , ; : ! ? —
	// Exception: Keep quotes (", ', ", ', „) as sentences can start with quotes
	for len(trimmed) > 0 {
		firstRune := rune(trimmed[0])
		// Check if it's punctuation that shouldn't start a sentence
		// Skip quote characters (using Unicode code points for curly quotes)
		if firstRune == '"' || firstRune == '\'' || firstRune == '\u201c' || // "
			firstRune == '\u201d' || firstRune == '\u2018' || firstRune == '\u2019' || // ' '
			firstRune == '\u201e' { // „
			// Keep quotes at start
			break
		}
		if firstRune == '.' || firstRune == ',' || firstRune == ';' ||
			firstRune == ':' || firstRune == '!' || firstRune == '?' ||
			firstRune == '—' || firstRune == '-' {
			trimmed = trimmed[1:]
			trimmed = strings.TrimLeftFunc(trimmed, unicode.IsSpace)
		} else {
			break
		}
	}

	return trimmed
}


// CountWords counts alphanumeric word blobs in text
// Matches the definition in PLAN.md: count of [a-zA-Z0-9]+ sequences
func CountWords(text string) int {
	wordPattern := regexp.MustCompile(`[a-zA-Z0-9]+`)
	words := wordPattern.FindAllString(text, -1)
	return len(words)
}

// normalizeText normalizes text for comparison during migration
// Used for fuzzy matching between sentence versions
func normalizeText(text string) string {
	// Convert to lowercase
	text = strings.ToLower(text)

	// Remove punctuation except spaces
	var builder strings.Builder
	for _, r := range text {
		if unicode.IsLetter(r) || unicode.IsDigit(r) || unicode.IsSpace(r) {
			builder.WriteRune(r)
		}
	}

	// Normalize whitespace
	text = strings.Join(strings.Fields(builder.String()), " ")

	return strings.TrimSpace(text)
}

// ExtractWords extracts alphanumeric words from text for sentence ID generation
func ExtractWords(text string) []string {
	// Normalize and extract words
	normalized := normalizeText(text)
	words := strings.Fields(normalized)
	return words
}
