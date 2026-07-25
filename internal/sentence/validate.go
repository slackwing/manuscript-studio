package sentence

import (
	"fmt"
	"strings"
)

// Permitted leading markers on a content sentence. Order matters: longest
// first so a `\n\n` prefix isn't classified as `\n\t`-with-extra-junk.
const (
	MarkerSection   = "\n\n" // new section, blank-line gap
	MarkerParagraph = "\n\t" // new indented paragraph
)

// ValidateSentenceText enforces the storage rule. A sentence is exactly one of:
//   - "Plain content."                    (continuation, or first sentence)
//   - "\n\tIndented content."              (new paragraph)
//   - "\n\nNew section content."           (new section)
//   - "&chapter#slug{I.}{Smoke}"           (block &-command)
//
// Markdown # headers are deprecated — a '#' sentence is ordinary content
// (validated as such). No trailing whitespace, no embedded newlines, no
// markers on block commands. Inline commands (&reference, a shared-line
// &anchor) are not their own sentence — they live inside a content sentence's
// text and are not separately validated here.
func ValidateSentenceText(text string) error {
	if text == "" {
		return fmt.Errorf("sentence text is empty")
	}

	// Block &-commands: their whole text is one command token, single-line,
	// no leading marker. Validate the slug charset when a #slug is present.
	if strings.HasPrefix(text, "&") {
		cmd, ok := ParseCommand(text)
		if ok && cmd.Raw == text {
			if !blockCommandKinds[cmd.Kind] {
				return fmt.Errorf("only block commands (title/part/chapter/anchor/meta) may be their own sentence, got &%s: %q", cmd.Kind, truncate(text))
			}
			if strings.ContainsAny(text, "\n\t") {
				return fmt.Errorf("command sentence must not contain \\n or \\t: %q", truncate(text))
			}
			if cmd.Slug != "" && !ValidSlug(cmd.Slug) {
				return fmt.Errorf("command slug must match [a-z0-9-]+, got %q: %q", cmd.Slug, truncate(text))
			}
			return nil
		}
		// A leading '&' that isn't a well-formed command is ordinary prose
		// (e.g. "& then it happened") — fall through to content validation.
	}

	// Content: optional leading marker (\n\n or \n\t), then plain content.
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
