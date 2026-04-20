package sentence

import (
	"regexp"
	"strings"
	"unicode"

	"github.com/slackwing/manuscript-studio/internal/segmenter"
)

type Tokenizer struct{}

func NewTokenizer() *Tokenizer {
	return &Tokenizer{}
}

func (t *Tokenizer) SplitIntoSentences(text string) []string {
	if strings.TrimSpace(text) == "" {
		return []string{}
	}

	sentences := segmenter.Segment(text)

	var result []string
	for _, sent := range sentences {
		cleaned := cleanSentenceBoundaries(sent)
		if cleaned != "" {
			result = append(result, cleaned)
		}
	}

	return result
}

// cleanSentenceBoundaries strips leading sentence-joining punctuation but
// preserves opening quotes so quoted sentences ("", '', „) keep their opener.
func cleanSentenceBoundaries(text string) string {
	trimmed := strings.TrimSpace(text)

	for len(trimmed) > 0 {
		firstRune := rune(trimmed[0])
		if firstRune == '"' || firstRune == '\'' || firstRune == '\u201c' ||
			firstRune == '\u201d' || firstRune == '\u2018' || firstRune == '\u2019' ||
			firstRune == '\u201e' {
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

// CountWords counts [a-zA-Z0-9]+ runs (the PLAN.md definition).
func CountWords(text string) int {
	wordPattern := regexp.MustCompile(`[a-zA-Z0-9]+`)
	words := wordPattern.FindAllString(text, -1)
	return len(words)
}

// normalizeText lowercases, strips non-letter/digit/space, and collapses
// whitespace. Used by the fuzzy matcher and by ExtractWords.
func normalizeText(text string) string {
	text = strings.ToLower(text)

	var builder strings.Builder
	for _, r := range text {
		if unicode.IsLetter(r) || unicode.IsDigit(r) || unicode.IsSpace(r) {
			builder.WriteRune(r)
		}
	}

	text = strings.Join(strings.Fields(builder.String()), " ")

	return strings.TrimSpace(text)
}

func ExtractWords(text string) []string {
	normalized := normalizeText(text)
	return strings.Fields(normalized)
}
