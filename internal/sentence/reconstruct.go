package sentence

import (
	"strings"
)

// IsHeaderText reports whether a sentence is a heading (storage form
// "# ..." through "###### ...", no leading marker).
func IsHeaderText(text string) bool {
	return strings.HasPrefix(text, "#") && headerPattern.MatchString(text)
}

// Reconstruct rebuilds the original .manuscript bytes from a sentence list.
// Inverse of TokenizeWithMarkers (in tokenizer.go). The round-trip
// (parse → reconstruct) must be byte-equal for any well-formed source.
//
// Reconstruction rule:
//   - A header sentence emits its text plus "\n", and a blank-line gap is
//     ensured both before (if there's prior content) and after (the next
//     non-header sentence starts on a fresh line, separated by a blank).
//   - A non-header sentence:
//       * If it carries a leading "\n\n" or "\n\t" marker, that marker is
//         emitted verbatim (provides the paragraph/section break).
//       * Otherwise it's appended directly. If the previous output ended
//         with a content character (not whitespace), a single space goes
//         between (continuation within a paragraph).
//   - The output ends with a trailing newline (matches typical source files).
func Reconstruct(sentences []string) string {
	var b strings.Builder
	prevWasHeader := false
	prevWasContent := false // last emit was a content sentence (vs. header or nothing)

	for _, s := range sentences {
		if IsHeaderText(s) {
			// Ensure blank-line gap before header (if anything came before).
			if b.Len() > 0 {
				ensureTrailingBlankLine(&b)
			}
			b.WriteString(s)
			b.WriteByte('\n')
			prevWasHeader = true
			prevWasContent = false
			continue
		}

		// Non-header.
		if strings.HasPrefix(s, MarkerSection) {
			// "\n\n" marker. We want exactly one blank line of gap.
			if prevWasHeader {
				// Header already ended with "\n"; prevWasHeader path closed
				// with single newline. We need ONE more newline for the gap,
				// then the rest of the content (without the marker).
				b.WriteByte('\n')
				b.WriteString(s[len(MarkerSection):])
			} else {
				// Continuation context: emit the marker as-is.
				b.WriteString(s)
			}
		} else if strings.HasPrefix(s, MarkerParagraph) {
			// "\n\t" marker.
			if prevWasHeader {
				// "# H\n\n\tContent" → header wrote "# H\n", we add "\n\t" + body.
				b.WriteString(s)
			} else {
				b.WriteString(s)
			}
		} else {
			// No marker.
			if prevWasHeader {
				// Header wrote "# H\n"; we want a blank line before content.
				b.WriteByte('\n')
				b.WriteString(s)
			} else if prevWasContent {
				// Two plain sentences in the same paragraph: single space.
				b.WriteByte(' ')
				b.WriteString(s)
			} else {
				// First sentence of the manuscript.
				b.WriteString(s)
			}
		}
		prevWasHeader = false
		prevWasContent = true
	}

	// Trailing newline so the file ends cleanly.
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
