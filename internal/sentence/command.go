package sentence

import (
	"regexp"
	"strings"
)

// The &-command layer. segman (the segmenter) decides *boundaries* — a block
// command is its own segment; an inline command rides inside its host
// sentence. This file owns *meaning*: recognizing a stored sentence as a
// command and parsing its fields (keyword, optional #slug, {...} args).
//
// Grammar (see TEX_COMMANDS_PLAN.md):
//
//	&title{name}
//	&part#slug{label}{desc?}
//	&chapter#slug{label}{desc?}
//	&anchor#slug{desc?}          // no label
//	&reference#slug{notes?}       // inline only
//
// A '&' begins a command only when immediately followed by an exact keyword
// and then '#' or '{'. #slug is [a-z0-9-]+. Block vs inline is a segmentation
// concern (handled in segman); here we only parse.

// CommandKind identifies a recognized command keyword.
type CommandKind string

const (
	CmdTitle     CommandKind = "title"
	CmdPart      CommandKind = "part"
	CmdChapter   CommandKind = "chapter"
	CmdAnchor    CommandKind = "anchor"
	CmdReference CommandKind = "reference"
)

// blockCommandKinds are the commands that stand alone as their own sentence
// when they occupy their own line. (anchor is block only when alone on its
// line — that distinction is made by segman; a stored block-anchor sentence
// is recognized here like any other block command.)
var blockCommandKinds = map[CommandKind]bool{
	CmdTitle:   true,
	CmdPart:    true,
	CmdChapter: true,
	CmdAnchor:  true,
}

// Command is a parsed &-command. Slug is the author's static #slug ("" if the
// author gave none — callers derive an auto-slug from Args in that case).
// Args are the brace groups in order: e.g. chapter → [label, desc?].
type Command struct {
	Kind CommandKind
	Slug string   // "" when no #slug was written
	Args []string // brace-group contents, in source order
	Raw  string   // the exact matched command token
}

var (
	// slugPattern: a static slug is lowercase letters, digits, and dashes.
	slugPattern = regexp.MustCompile(`^[a-z0-9-]+$`)
	// commandNames matched at the start of a token.
	commandNames = []CommandKind{CmdTitle, CmdPart, CmdChapter, CmdAnchor, CmdReference}
)

// IsBlockCommandText reports whether a stored sentence is a block &-command
// (its whole text is one command token). Used alongside IsHeaderText to route
// structural sentences through the header-like tokenize/reconstruct path.
func IsBlockCommandText(text string) bool {
	cmd, ok := ParseCommand(strings.TrimSpace(text))
	if !ok {
		return false
	}
	// A block sentence's text is exactly the command (nothing trailing). An
	// inline anchor sharing a line never reaches here as its own sentence.
	return blockCommandKinds[cmd.Kind] && cmd.Raw == strings.TrimSpace(text)
}

// ParseCommand parses a single command token at the START of s. It returns the
// command and true if s begins with a recognized command; trailing content
// after the command is ignored by the parse (cmd.Raw delimits what matched).
// Returns ok=false for a literal '&' (no keyword, or no '#'/'{' delimiter).
func ParseCommand(s string) (Command, bool) {
	runes := []rune(s)
	if len(runes) == 0 || runes[0] != '&' {
		return Command{}, false
	}
	kind, after := matchKeyword(runes)
	if kind == "" {
		return Command{}, false
	}

	i := after
	var slug string
	if i < len(runes) && runes[i] == '#' {
		i++
		start := i
		for i < len(runes) && runes[i] != '{' {
			i++
		}
		slug = string(runes[start:i])
	}

	// One or more {...} groups.
	var args []string
	for i < len(runes) && runes[i] == '{' {
		depth := 0
		start := i + 1
		for i < len(runes) {
			switch runes[i] {
			case '{':
				depth++
			case '}':
				depth--
				if depth == 0 {
					args = append(args, string(runes[start:i]))
					i++
					goto nextGroup
				}
			}
			i++
		}
		// Unterminated group.
		return Command{}, false
	nextGroup:
	}

	if len(args) == 0 {
		return Command{}, false
	}
	return Command{
		Kind: kind,
		Slug: slug,
		Args: args,
		Raw:  string(runes[:i]),
	}, true
}

// matchKeyword returns the command keyword at the start of runes (after '&')
// and the index just past it, requiring the next char to be '#' or '{'.
func matchKeyword(runes []rune) (CommandKind, int) {
	for _, name := range commandNames {
		end := 1 + len([]rune(string(name)))
		if end >= len(runes) {
			continue
		}
		if string(runes[1:end]) != string(name) {
			continue
		}
		if runes[end] == '#' || runes[end] == '{' {
			return name, end
		}
	}
	return "", 0
}

// ValidSlug reports whether a #slug matches the required charset [a-z0-9-]+.
func ValidSlug(slug string) bool {
	return slugPattern.MatchString(slug)
}
