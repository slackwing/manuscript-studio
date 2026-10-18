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
	// The marker-free form of TokenizeWithMarkers — ONE cutting rule, so
	// the two can never disagree about where sentences are.
	rows := t.TokenizeWithMarkers(text)
	out := make([]string, 0, len(rows))
	for _, r := range rows {
		if strings.HasPrefix(r, MarkerParagraph) || strings.HasPrefix(r, MarkerSection) {
			r = r[2:]
		}
		out = append(out, r)
	}
	return out
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
	prevStructural := false

	for _, seg := range rawSegments {
		cleaned := cleanSentenceBoundaries(seg)
		if cleaned == "" {
			advance := skipSegmentInSource(source, cursor, seg)
			cursor = advance
			continue
		}

		segStart, segEnd := locateSegment(source, cursor, cleaned)
		// GLUED: no whitespace at all between the previous segment and this
		// one — segman cut mid-word-run (`[something]` | `.`, `'Sup'—"` |
		// `, Jaime said…`). It's the same sentence: append it verbatim, so no
		// character is lost and the push's rebuild (one space between rows)
		// can't insert one where the source had none. (2026-10-18: this used
		// to STRIP the leading punctuation instead — data loss on push.)
		if segStart >= 0 && segStart == cursor && cursor > 0 && len(out) > 0 && !prevStructural {
			out[len(out)-1] += cleaned
			cursor = segEnd
			continue
		}
		if segStart < 0 {
			// Couldn't locate the segment — emit it with no marker and leave
			// cursor where it is so the next segment still searches from a
			// valid offset. (Assigning segStart here would poison cursor
			// with -1 and panic the next locateSegment call.)
			out = append(out, cleaned)
			prevStructural = false
			continue
		}

		leading := source[cursor:segStart]
		marker := classifyMarker(leading, len(out) == 0, prevStructural)

		// Structural sentences (Markdown headers and block &-commands) stand
		// on their own line with no leading marker; the blank-line gap around
		// them carries the structure. Everything else gets a paragraph/section
		// marker per the surrounding whitespace.
		if isStructuralSegment(cleaned) {
			out = append(out, cleaned)
			prevStructural = true
		} else {
			out = append(out, marker+cleaned)
			prevStructural = false
		}
		cursor = segEnd
	}

	return out
}

// classifyMarker inspects whitespace between two segments and returns one of
// "", "\n\t", "\n\n".
//
//   - atStart=true: first emitted sentence (manuscript start, marker implicit).
//   - prevStructural=true: previous emitted sentence was a header or block
//     command. Its surrounding blank-line gap already provides structure, so
//     a section marker would be redundant. Only emit a paragraph marker when
//     the source explicitly indents (a tab). This is the "writing convention:
//     first sentence of a section has no \t" rule.
func classifyMarker(whitespace string, atStart, prevStructural bool) string {
	if atStart {
		return ""
	}
	hasTab := strings.Contains(whitespace, "\t")
	hasNewline := strings.Contains(whitespace, "\n")
	if hasTab && hasNewline {
		return MarkerParagraph
	}
	if prevStructural {
		return ""
	}
	if strings.Count(whitespace, "\n") >= 2 {
		return MarkerSection
	}
	return ""
}

// isStructuralSegment recognises segments that stand on their own line with
// no leading marker: block &-commands. (Markdown # headers are deprecated —
// a '#' segment is ordinary content.)
func isStructuralSegment(segment string) bool {
	return IsBlockCommandText(segment)
}

// locateSegment finds where `seg` (whitespace-collapsed by segman) appears
// in `source` starting at `cursor`. Returns the [start, end) range where
// `start` is the position of the FIRST non-whitespace character of the
// segment in source — so source[cursor:start] is the leading whitespace
// gap, which the caller uses to classify the marker.
//
// Returns (-1, -1) if not found — caller should fall back gracefully.
func locateSegment(source string, cursor int, seg string) (int, int) {
	// Defense in depth: a negative cursor must never index source.
	if cursor < 0 {
		cursor = 0
	}
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

// cleanSentenceBoundaries trims the whitespace around a segment — and
// NOTHING else. Punctuation a sentence opens with is the author's ("...And
// then", "—he said"); it used to be stripped here (leading . , ; : ! ? - —),
// which also dropped it from the file on the next push, since the push
// rebuilds the file from these rows (owner's reports: em dash 2026-10-11,
// ellipsis 2026-10-18). A segment glued to the previous one with no
// whitespace is a segman cut mid-run — TokenizeWithMarkers appends it to
// the previous sentence verbatim instead.
func cleanSentenceBoundaries(text string) string {
	return strings.TrimSpace(text)
}

// NormalizeText lowercases, strips non-letter/digit/space, and collapses
// whitespace. Used by the fuzzy matcher and by ExtractWords.
func NormalizeText(text string) string {
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
	normalized := NormalizeText(text)
	return strings.Fields(normalized)
}
