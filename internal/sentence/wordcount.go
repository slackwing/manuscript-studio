package sentence

import (
	"strings"
	"unicode"
)

// CountProseWords counts real manuscript words in one sentence's text,
// excluding &-command scaffolding (HOME_PLAN word-count is a reader-facing
// "how much book is written" number, so command tokens, headings, anchor/part/
// chapter labels, &meta, and &placeholder details must NOT inflate it).
//
// Rules:
//   - A whole-sentence block command (&title/&part/&chapter/&anchor/&meta/
//     &placeholder/&end on its own line) contributes 0 — none of its label,
//     description, or details text is prose.
//   - Otherwise the sentence is prose that may carry inline command tokens
//     (&reference{…}, an inline &anchor{}, an inline &placeholder{…}). Each
//     such token is removed entirely (its notes/label are scaffolding, not
//     prose), and the remaining whitespace-separated runs are counted.
//   - A single leading structural marker (\n\n / \n\t) is not a word.
func CountProseWords(text string) int {
	if IsBlockCommandText(text) {
		return 0
	}

	// Strip a single leading structural marker.
	body := text
	if strings.HasPrefix(body, MarkerSection) {
		body = body[len(MarkerSection):]
	} else if strings.HasPrefix(body, MarkerParagraph) {
		body = body[len(MarkerParagraph):]
	}

	// Remove inline command tokens (&reference/&anchor/&placeholder/…): scan
	// for '&', and whenever a valid command parses there, drop its whole Raw
	// span. Literal '&' (Smith & Sons, R&D) leaves ParseCommand ok=false, so it
	// stays as prose.
	runes := []rune(body)
	var b strings.Builder
	for i := 0; i < len(runes); {
		if runes[i] == '&' {
			if cmd, ok := ParseCommand(string(runes[i:])); ok {
				i += len([]rune(cmd.Raw))
				// Leave a space so "word&ref{x}word" doesn't fuse into one.
				b.WriteByte(' ')
				continue
			}
		}
		b.WriteRune(runes[i])
		i++
	}

	// Count only tokens containing a letter or digit — a bare "&" (Smith & Sons)
	// or stray punctuation left after token removal is not a word.
	n := 0
	for _, f := range strings.Fields(b.String()) {
		if strings.IndexFunc(f, func(r rune) bool {
			return unicode.IsLetter(r) || unicode.IsDigit(r)
		}) >= 0 {
			n++
		}
	}
	return n
}

// CountMigrationProseWords sums CountProseWords across a set of sentence texts
// (ordinal order irrelevant to the total).
func CountMigrationProseWords(texts []string) int {
	total := 0
	for _, t := range texts {
		total += CountProseWords(t)
	}
	return total
}
