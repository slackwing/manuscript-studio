package sentence

import (
	"regexp"
	"strings"
)

// FirstProseSentence returns the first sentence of manuscript-form text
// that READS as prose — what a sketch's note shows when its owner hasn't
// written one (2026-10-18). Segmentation is the manuscript's own (the same
// TokenizeWithMarkers the migration runs); block &-commands are skipped,
// inline &-commands (markers, footnotes, references…) are dropped with the
// space they stood in, *emphasis* marks are removed, and whitespace is
// collapsed. "" when the text holds no prose.
func FirstProseSentence(text string) string {
	for _, s := range NewTokenizer().SplitIntoSentences(text) {
		if IsBlockCommandText(s) {
			continue
		}
		if p := plainProse(s); p != "" {
			return p
		}
	}
	return ""
}

var (
	spaceBeforePunct = regexp.MustCompile(` +([.,;:!?)\]”’])`)
	underscoreEmph   = regexp.MustCompile(`(^|[^\pL\pN_])_+([^_]+?)_+([^\pL\pN_]|$)`)
)

func plainProse(s string) string {
	var b strings.Builder
	runes := []rune(s)
	for i := 0; i < len(runes); {
		if runes[i] == '&' {
			if cmd, ok := ParseCommand(string(runes[i:])); ok {
				i += len([]rune(cmd.Raw))
				b.WriteByte(' ') // collapsed below; punctuation pulled back
				continue
			}
		}
		b.WriteRune(runes[i])
		i++
	}
	out := strings.ReplaceAll(b.String(), "*", "")
	out = underscoreEmph.ReplaceAllString(out, "$1$2$3")
	out = strings.Join(strings.Fields(out), " ")
	out = spaceBeforePunct.ReplaceAllString(out, "$1")
	return strings.TrimSpace(out)
}
