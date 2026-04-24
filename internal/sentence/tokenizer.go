package sentence

import (
	"strings"
	"unicode"

	"github.com/slackwing/manuscript-studio/internal/segman"
)

type Tokenizer struct{}

func NewTokenizer() *Tokenizer {
	return &Tokenizer{}
}

func (t *Tokenizer) SplitIntoSentences(text string) []string {
	if strings.TrimSpace(text) == "" {
		return []string{}
	}

	sentences := segman.Segment(text)

	var result []string
	for _, sent := range sentences {
		cleaned := cleanSentenceBoundaries(sent)
		if cleaned != "" {
			result = append(result, cleaned)
		}
	}

	return result
}

// TokenizeWithMarkers runs segman over the source and then makes a second
// pass over the original bytes to recover the structural-whitespace
// information segman discards. Returns sentences in the storage form
// defined in UNIFIED_DATA_SHAPE_PLAN.md (each is plain content, prefixed
// with "\n\t" or "\n\n" if the source had a paragraph or section break, or
// a "# Heading" sentence).
//
// Sentence ordinals MUST match SplitIntoSentences (same drop-empty rule)
// so that GenerateSentenceID stays stable across the storage-shape change.
func (t *Tokenizer) TokenizeWithMarkers(source string) []string {
	if strings.TrimSpace(source) == "" {
		return []string{}
	}

	rawSegments := segman.Segment(source)
	if len(rawSegments) == 0 {
		return []string{}
	}

	out := make([]string, 0, len(rawSegments))
	cursor := 0
	prevHeader := false

	for _, seg := range rawSegments {
		cleaned := cleanSentenceBoundaries(seg)
		if cleaned == "" {
			advance := skipSegmentInSource(source, cursor, seg)
			cursor = advance
			continue
		}

		segStart, segEnd := locateSegment(source, cursor, cleaned)
		if segStart < 0 {
			out = append(out, cleaned)
			cursor = segStart
			prevHeader = false
			continue
		}

		leading := source[cursor:segStart]
		marker := classifyMarker(leading, len(out) == 0, prevHeader)

		if isHeaderSegment(cleaned) {
			out = append(out, cleaned)
			prevHeader = true
		} else {
			out = append(out, marker+cleaned)
			prevHeader = false
		}
		cursor = segEnd
	}

	return out
}

// classifyMarker inspects whitespace between two segments and returns one of
// "", "\n\t", "\n\n".
//
//   - atStart=true: first emitted sentence (manuscript start, marker implicit).
//   - prevHeader=true: previous emitted sentence was a header. The header's
//     surrounding blank-line gap already provides structure, so a section
//     marker would be redundant. Only emit a paragraph marker when the
//     source explicitly indents (a tab). This is the "writing convention:
//     first sentence of a section has no \t" rule.
func classifyMarker(whitespace string, atStart, prevHeader bool) string {
	if atStart {
		return ""
	}
	hasTab := strings.Contains(whitespace, "\t")
	hasNewline := strings.Contains(whitespace, "\n")
	if hasTab && hasNewline {
		return MarkerParagraph
	}
	if prevHeader {
		return ""
	}
	if strings.Count(whitespace, "\n") >= 2 {
		return MarkerSection
	}
	return ""
}

// isHeaderSegment recognises segman segments that are markdown headers.
func isHeaderSegment(segment string) bool {
	return strings.HasPrefix(segment, "#") && headerPattern.MatchString(segment)
}

// locateSegment finds where `seg` (whitespace-collapsed by segman) appears
// in `source` starting at `cursor`. Returns the [start, end) range where
// `start` is the position of the FIRST non-whitespace character of the
// segment in source — so source[cursor:start] is the leading whitespace
// gap, which the caller uses to classify the marker.
//
// Returns (-1, -1) if not found — caller should fall back gracefully.
func locateSegment(source string, cursor int, seg string) (int, int) {
	for start := cursor; start < len(source); start++ {
		if isASCIISpace(source[start]) {
			continue
		}
		i := start
		j := 0
		for i < len(source) && j < len(seg) {
			sb := source[i]
			tb := seg[j]
			if isASCIISpace(sb) && isASCIISpace(tb) {
				// Both whitespace; consume run in source, advance one in seg.
				j++
				i++
				for i < len(source) && isASCIISpace(source[i]) {
					i++
				}
				continue
			}
			if isASCIISpace(sb) && !isASCIISpace(tb) {
				// Source has extra whitespace mid-segment; advance source.
				i++
				continue
			}
			if !isASCIISpace(sb) && isASCIISpace(tb) {
				// Segment expects whitespace, source has none — mismatch.
				break
			}
			if sb != tb {
				break
			}
			i++
			j++
		}
		if j == len(seg) {
			return start, i
		}
	}
	return -1, -1
}

func isASCIISpace(b byte) bool {
	return b == ' ' || b == '\t' || b == '\n' || b == '\r'
}

// skipSegmentInSource advances past a segment that's being dropped (e.g.
// a lone ".") so that the next segment's leading-whitespace classification
// starts from the right position.
func skipSegmentInSource(source string, cursor int, seg string) int {
	cleaned := strings.TrimSpace(seg)
	if cleaned == "" {
		// Pure whitespace segment; advance past trailing whitespace.
		for cursor < len(source) && isASCIISpace(source[cursor]) {
			cursor++
		}
		return cursor
	}
	_, end := locateSegment(source, cursor, cleaned)
	if end < 0 {
		return cursor
	}
	return end
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
