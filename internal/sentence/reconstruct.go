package sentence

import (
	"strings"
)

// IsStructuralText reports whether a sentence stands on its own line with no
// leading marker: a block &-command. These reconstruct with a blank-line gap
// before and after. (Markdown # headers are deprecated — a '#' sentence is
// ordinary content now.)
func IsStructuralText(text string) bool {
	return IsBlockCommandText(text)
}

// Reconstruct rebuilds the original .manuscript bytes from a sentence list.
// Inverse of TokenizeWithMarkers (in tokenizer.go). The round-trip
// (parse → reconstruct) must be byte-equal for any well-formed source.
//
// Reconstruction rule:
//   - A block-command sentence emits its text plus "\n", and a blank-line gap
//     is ensured both before (if there's prior content) and after (the next
//     content sentence starts on a fresh line, separated by a blank).
//   - A content sentence:
//       * If it carries a leading "\n\n" or "\n\t" marker, that marker is
//         emitted verbatim (provides the paragraph/section break).
//       * Otherwise it's appended directly. If the previous output ended
//         with a content character (not whitespace), a single space goes
//         between (continuation within a paragraph).
//   - The output ends with a trailing newline (matches typical source files).
func Reconstruct(sentences []string) string {
	var b strings.Builder
	prevWasStructural := false // last emit was a block &-command
	prevWasContent := false    // last emit was a content sentence (vs. structural or nothing)

	for _, s := range sentences {
		// A block &-command stands on its own line with a blank-line gap
		// before and after.
		if IsStructuralText(s) {
			if b.Len() > 0 {
				ensureTrailingBlankLine(&b)
			}
			b.WriteString(s)
			b.WriteByte('\n')
			prevWasStructural = true
			prevWasContent = false
			continue
		}

		switch {
		case strings.HasPrefix(s, MarkerSection):
			if prevWasStructural {
				// Structural line already ended with "\n"; one more newline
				// gives the blank-line gap, then the body sans marker.
				b.WriteByte('\n')
				b.WriteString(s[len(MarkerSection):])
			} else {
				b.WriteString(s)
			}
		case strings.HasPrefix(s, MarkerParagraph):
			b.WriteString(s)
		default:
			if prevWasStructural {
				b.WriteByte('\n')
				b.WriteString(s)
			} else if prevWasContent && !strings.HasPrefix(s, "\n") {
				// Continuation within a paragraph.
				b.WriteByte(' ')
				b.WriteString(s)
			} else {
				// Starts with its own separator (e.g. "\n&sketch#…{}" — the
				// own-line anchor form): no space, or it trails the previous
				// line.
				b.WriteString(s)
			}
		}
		prevWasStructural = false
		prevWasContent = true
	}

	if b.Len() > 0 && !strings.HasSuffix(b.String(), "\n") {
		b.WriteByte('\n')
	}

	return b.String()
}

// ensureTrailingBlankLine guarantees the builder ends with exactly "\n\n"
// (one full line terminator + one blank line). Called before emitting a
// header so headers are always preceded by a blank-line gap.
func ensureTrailingBlankLine(b *strings.Builder) {
	s := b.String()
	switch {
	case strings.HasSuffix(s, "\n\n"):
		// already good
	case strings.HasSuffix(s, "\n"):
		b.WriteByte('\n')
	default:
		b.WriteString("\n\n")
	}
}
