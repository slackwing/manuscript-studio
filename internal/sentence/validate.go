package sentence

import (
	"fmt"
	"regexp"
	"strings"
)

// Permitted leading markers on a non-header sentence. Order matters: longest
// first so a `\n\n` prefix isn't classified as `\n\t`-with-extra-junk.
const (
	MarkerSection   = "\n\n" // new section (no header), blank-line gap
	MarkerParagraph = "\n\t" // new indented paragraph
)

var headerPattern = regexp.MustCompile(`^#+\s\S`)

// ValidateSentenceText enforces the storage rule defined in
// UNIFIED_DATA_SHAPE_PLAN.md. A sentence is exactly one of:
//   - "Plain content."                    (continuation, or first sentence)
//   - "\n\tIndented content."              (new paragraph)
//   - "\n\nNew section content."           (new section, no header)
//   - "# Heading text"                     (header, any depth)
//
// No trailing whitespace, no embedded newlines, no markers on headers.
func ValidateSentenceText(text string) error {
	if text == "" {
		return fmt.Errorf("sentence text is empty")
	}

	// Headers: # / ## / ### plus space plus content. Single-line.
	if strings.HasPrefix(text, "#") {
		if !headerPattern.MatchString(text) {
			return fmt.Errorf("header sentence must match `^#+\\s\\S`: %q", truncate(text))
		}
		if strings.ContainsAny(text, "\n\t") {
			return fmt.Errorf("header sentence must not contain \\n or \\t: %q", truncate(text))
		}
		return nil
	}

	// Non-header: optional leading marker (\n\n or \n\t), then plain content.
	body := text
	if strings.HasPrefix(body, MarkerSection) {
		body = body[len(MarkerSection):]
	} else if strings.HasPrefix(body, MarkerParagraph) {
		body = body[len(MarkerParagraph):]
	}

	if strings.ContainsAny(body, "\n\t") {
		return fmt.Errorf("sentence body must not contain \\n or \\t (only as a single leading marker): %q", truncate(text))
	}

	// No trailing whitespace beyond what's natural inside the content.
	if strings.HasSuffix(body, " ") {
		return fmt.Errorf("sentence text must not have trailing whitespace: %q", truncate(text))
	}

	return nil
}

func truncate(s string) string {
	const max = 60
	if len(s) <= max {
		return s
	}
	return s[:max] + "..."
}
