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
// Grammar (see TEX_COMMANDS_PLAN.md and PLACEHOLDER_PLAN.md):
//
//	&title{text}
//	&part#slug{text}{label?}
//	&chapter#slug{text}{label?}
//	&anchor#slug{label?}{details?}                       // details reserved, unrendered
//	&reference#slug{notes?}                              // inline only
//	&placeholder#slug{unit}{size?}{label?}{details?}     // see ParsePlaceholder
//	&snippet#id{label}                                   // canon region opener (VARIATIONS_PLAN.md)
//	&end#slug                                            // region terminator (SCRATCHPAD_PLAN.md)
//
// Argument vocabulary: {text} renders in the book, {label} shows in the
// outline, {details} is auxiliary metadata (a placeholder's details overlay;
// an anchor's details are parsed but unrendered for now).
//
// A '&' begins a command only when immediately followed by an exact keyword
// and then '#' or '{'. #slug is [a-z0-9-]+. Block vs inline is a segmentation
// concern (handled in segman); here we only parse.

// CommandKind identifies a recognized command keyword.
type CommandKind string

const (
	CmdTitle       CommandKind = "title"
	CmdPart        CommandKind = "part"
	CmdChapter     CommandKind = "chapter"
	CmdAnchor      CommandKind = "anchor"
	CmdReference   CommandKind = "reference"
	CmdMeta        CommandKind = "meta"
	CmdPlaceholder CommandKind = "placeholder"
	CmdSnippet     CommandKind = "snippet"
	CmdEnd         CommandKind = "end"
)

// blockCommandKinds are the commands that stand alone as their own sentence
// when they occupy their own line. (anchor is block only when alone on its
// line — that distinction is made by segman; a stored block-anchor sentence
// is recognized here like any other block command.) &meta is block but
// renders as nothing — it carries a book-wide setting.
var blockCommandKinds = map[CommandKind]bool{
	CmdTitle:       true,
	CmdPart:        true,
	CmdChapter:     true,
	CmdAnchor:      true,
	CmdMeta:        true,
	CmdPlaceholder: true, // block iff sole line content, same as anchor (segman's call)
	CmdSnippet:     true, // block iff sole line content; canon region opener (VARIATIONS_PLAN.md)
	CmdEnd:         true, // block iff sole line content; invisible region terminator
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
	commandNames = []CommandKind{CmdTitle, CmdPart, CmdChapter, CmdAnchor, CmdReference, CmdMeta, CmdPlaceholder, CmdSnippet, CmdEnd}
)

// PlaceholderSpec is the interpreted argument list of a &placeholder command:
// {unit}{size?}{label?}{details?}. The size arg is positional but detected by
// value: an arg that exactly matches a size keyword is the size, anything
// else is the label (a label that IS literally a size keyword can force the
// default by writing the size explicitly). Valid=false means the command is
// mis-syntaxed and renders as literal prose.
type PlaceholderSpec struct {
	Unit    string // "sentences" or "paragraphs"
	Size    string // canonical size keyword; "m" when omitted
	Count   int    // resolved count of Unit
	Label   string // outline text (placeholder lists exactly like an anchor)
	Details string // overlaid on the rendered placeholder region
	Valid   bool
}

// Placeholder t-shirt sizes. Sentences double-ish; paragraphs are Fibonacci.
// The asymmetry is deliberate (PLACEHOLDER_PLAN.md).
var placeholderSentenceCounts = map[string]int{
	"xs": 1, "s": 2, "m": 3, "l": 5, "xl": 10, "xxl": 20, "xxxl": 40,
}
var placeholderParagraphCounts = map[string]int{
	"xs": 1, "s": 2, "m": 3, "l": 5, "xl": 8, "xxl": 13, "xxxl": 21,
}

// ParsePlaceholder interprets a parsed &placeholder command's args. Mirrors
// web/js/command.js placeholderSpec — keep in lockstep.
func ParsePlaceholder(cmd Command) PlaceholderSpec {
	spec := PlaceholderSpec{Size: "m"}
	if cmd.Kind != CmdPlaceholder || len(cmd.Args) == 0 || len(cmd.Args) > 4 {
		return spec
	}
	spec.Unit = strings.TrimSpace(cmd.Args[0])
	counts, ok := map[string]map[string]int{
		"sentences":  placeholderSentenceCounts,
		"paragraphs": placeholderParagraphCounts,
	}[spec.Unit]
	if !ok {
		return spec
	}
	rest := cmd.Args[1:]
	if len(rest) > 0 {
		if _, isSize := counts[strings.TrimSpace(rest[0])]; isSize {
			spec.Size = strings.TrimSpace(rest[0])
			rest = rest[1:]
		}
	}
	if len(rest) > 0 {
		spec.Label = rest[0]
		rest = rest[1:]
	}
	if len(rest) > 0 {
		spec.Details = rest[0]
		rest = rest[1:]
	}
	if len(rest) > 0 {
		// More args than {unit}{size}{label}{details} can absorb.
		return PlaceholderSpec{Size: "m"}
	}
	spec.Count = counts[spec.Size]
	spec.Valid = true
	return spec
}

// IsBlockCommandText reports whether a stored sentence is a block &-command
// (its whole text is one command token). Used to route block-command
// sentences through the own-line, blank-line-gapped tokenize/reconstruct path.
func IsBlockCommandText(text string) bool {
	cmd, ok := ParseCommand(strings.TrimSpace(text))
	if !ok {
		return false
	}
	// A block sentence's text is exactly the command (nothing trailing). An
	// inline anchor sharing a line never reaches here as its own sentence.
	return blockCommandKinds[cmd.Kind] && cmd.Raw == strings.TrimSpace(text)
}

// StaticSlug is a slug the author wrote (#slug) on a block command, paired
// with the sentence that carries it and the command kind. Extracted at
// migration time into the slug index (TEX_COMMANDS_PLAN.md §3).
type StaticSlug struct {
	Slug       string
	SentenceID string
	Kind       CommandKind
}

// Reference is an inline &reference#slug{notes} occurrence: the target slug,
// the notes text, and the char range within its host sentence's text.
type Reference struct {
	Slug       string
	Notes      string
	Start, End int // rune-index range in the host sentence text
}

// FindInlineCommands scans a sentence's text for inline &reference and
// &anchor commands (those that are NOT the whole sentence — inline ones ride
// inside prose). Returns each with its rune range. A block sentence (the whole
// text is one command) yields nothing here; block commands are handled
// separately (slug index / outline).
func FindInlineCommands(text string) (refs []Reference, anchors []Reference) {
	runes := []rune(text)
	// If the entire trimmed text is one block command, it's not inline.
	if IsBlockCommandText(text) {
		return nil, nil
	}
	for i := 0; i < len(runes); i++ {
		if runes[i] != '&' {
			continue
		}
		cmd, ok := ParseCommand(string(runes[i:]))
		if !ok {
			continue
		}
		end := i + len([]rune(cmd.Raw))
		notes := ""
		if len(cmd.Args) > 0 {
			notes = cmd.Args[0]
		}
		switch cmd.Kind {
		case CmdReference:
			refs = append(refs, Reference{Slug: cmd.Slug, Notes: notes, Start: i, End: end})
		case CmdAnchor:
			anchors = append(anchors, Reference{Slug: cmd.Slug, Notes: notes, Start: i, End: end})
		}
		i = end - 1 // skip past the matched command
	}
	return refs, anchors
}

// FindReferences returns just the reference slugs across a set of sentences,
// for migration-time dangling detection. Ignores anchors.
func FindReferences(ids []string, textByID map[string]string) []Reference {
	var out []Reference
	for _, id := range ids {
		text, ok := textByID[id]
		if !ok {
			continue
		}
		refs, _ := FindInlineCommands(text)
		out = append(out, refs...)
	}
	return out
}

// ExtractStaticSlugs walks (sentenceID -> text) block-command sentences and
// returns each author-written static #slug with its sentence and kind. Only
// static slugs are returned — a command with no #slug contributes nothing
// (its auto-slug is computed on read, never stored). Invalid slugs are
// skipped (they'd have failed validation upstream). Order follows the
// provided ids slice so results are deterministic.
func ExtractStaticSlugs(ids []string, textByID map[string]string) []StaticSlug {
	var out []StaticSlug
	for _, id := range ids {
		text, ok := textByID[id]
		if !ok {
			continue
		}
		cmd, ok := ParseCommand(strings.TrimSpace(text))
		if !ok || !blockCommandKinds[cmd.Kind] || cmd.Raw != strings.TrimSpace(text) {
			continue
		}
		if cmd.Slug == "" || !ValidSlug(cmd.Slug) {
			continue
		}
		out = append(out, StaticSlug{Slug: cmd.Slug, SentenceID: id, Kind: cmd.Kind})
	}
	return out
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
		if kind == CmdEnd {
			// 'end' may be a bare #slug token with no {...} groups, so its
			// slug self-terminates on the slug charset [a-z0-9-].
			for i < len(runes) && isSlugRune(runes[i]) {
				i++
			}
		} else {
			for i < len(runes) && runes[i] != '{' {
				i++
			}
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

	if len(args) == 0 && !(kind == CmdEnd && slug != "") {
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

// isSlugRune reports whether r is in the #slug charset [a-z0-9-].
func isSlugRune(r rune) bool {
	return (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-'
}
