package sentence

import (
	"regexp"
	"strings"
	"unicode"
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

// NoteDefault is what a note shows while its owner's text is blank
// (2026-10-24) — the default, never written over their text:
//   - every {fill-in} in the text, in order, braces kept, space-joined
//     ("{adjective} {something here}") — braces of &-commands don't count;
//   - else, for a sentence note, the first three words + "..." ("The
//     telephone rang..."; three words or fewer: the words themselves);
//     for a sketch note (wholeSentence), its first prose sentence.
//
// text is a sentence note's sentence as its owner sees it (their suggested
// edit, else the committed text) or a sketch's text. "" when there's no
// prose at all.
func NoteDefault(text string, wholeSentence bool) string {
	if fills := fillIns.FindAllString(stripCommands(text), -1); len(fills) > 0 {
		for i, f := range fills {
			fills[i] = "{" + strings.Join(strings.Fields(f[1:len(f)-1]), " ") + "}"
		}
		return strings.Join(fills, " ")
	}
	if wholeSentence {
		return FirstProseSentence(text)
	}
	plain := []rune(plainProse(text))
	// A word is a run of letters/digits (an apostrophe inside one keeps
	// it going): dashes and punctuation separate words, so "So it
	// was—the…" cuts at "was".
	words := 0
	for i := 0; i < len(plain); i++ {
		if !isWordRune(plain[i]) {
			continue
		}
		for i < len(plain) && (isWordRune(plain[i]) || (isApostrophe(plain[i]) && i+1 < len(plain) && isWordRune(plain[i+1]))) {
			i++
		}
		if words++; words == 3 {
			if strings.TrimFunc(string(plain[i:]), func(r rune) bool { return !isWordRune(r) }) == "" {
				return string(plain) // three words or fewer: all of it
			}
			return string(plain[:i]) + "..."
		}
	}
	return string(plain)
}

func isWordRune(r rune) bool   { return unicode.IsLetter(r) || unicode.IsDigit(r) }
func isApostrophe(r rune) bool { return r == '\'' || r == '’' }

var (
	spaceBeforePunct = regexp.MustCompile(` +([.,;:!?)\]”’])`)
	underscoreEmph   = regexp.MustCompile(`(^|[^\pL\pN_])_+([^_]+?)_+([^\pL\pN_]|$)`)
	fillIns          = regexp.MustCompile(`\{[^{}]*[^{}\s][^{}]*\}`)
)

// stripCommands drops every &-command (its own {…} arguments with it),
// leaving a space where it stood.
func stripCommands(s string) string {
	var b strings.Builder
	runes := []rune(s)
	for i := 0; i < len(runes); {
		if runes[i] == '&' {
			if cmd, ok := ParseCommand(string(runes[i:])); ok {
				i += len([]rune(cmd.Raw))
				b.WriteByte(' ')
				continue
			}
		}
		b.WriteRune(runes[i])
		i++
	}
	return b.String()
}

func plainProse(s string) string {
	// Commands leave a space — collapsed below; punctuation pulled back.
	out := strings.ReplaceAll(stripCommands(s), "*", "")
	out = underscoreEmph.ReplaceAllString(out, "$1$2$3")
	out = strings.Join(strings.Fields(out), " ")
	out = spaceBeforePunct.ReplaceAllString(out, "$1")
	return strings.TrimSpace(out)
}

// NewWords counts the words an edit ADDS (2026-10-26, the statistics
// pane's NEW ACCEPTED): one frequency counter per edit — every word of the
// new text +1, every word of the old text −1 — then the sum of the
// positives. A word that only MOVED nets 0; a rewrite counts just what's
// new. Words are compared as they read (commands and emphasis marks
// stripped, case folded).
func NewWords(oldText, newText string) int {
	freq := map[string]int{}
	for _, w := range proseWords(newText) {
		freq[w]++
	}
	for _, w := range proseWords(oldText) {
		freq[w]--
	}
	n := 0
	for _, c := range freq {
		if c > 0 {
			n += c
		}
	}
	return n
}

// proseWords: the words of manuscript-form text as they read — runs of
// letters/digits, an inner apostrophe kept ("can't"), lowercased.
func proseWords(text string) []string {
	plain := []rune(plainProse(text))
	var out []string
	for i := 0; i < len(plain); i++ {
		if !isWordRune(plain[i]) {
			continue
		}
		start := i
		for i < len(plain) && (isWordRune(plain[i]) || (isApostrophe(plain[i]) && i+1 < len(plain) && isWordRune(plain[i+1]))) {
			i++
		}
		out = append(out, strings.ToLower(strings.ReplaceAll(string(plain[start:i]), "’", "'")))
	}
	return out
}

