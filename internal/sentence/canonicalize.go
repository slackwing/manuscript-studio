package sentence

import "strings"

// Canonicalize normalizes a single sentence's effective text to the house
// canonical form (CANONICALIZE_PLAN.md). It is the ONE source of truth for
// ".manuscript" formatting, run per-sentence in the render loop and mirrored
// by web/js/canonicalize.js (kept in lockstep via tests/canonicalize-
// scenarios.jsonl). It is PURE and IDEMPOTENT: Canonicalize(Canonicalize(x))
// == Canonicalize(x).
//
// A "sentence" here may hold more than one block (a suggestion such as
// "&meta{a}{b}\n\n&title{X}" or a leading-anchor "\n\t&anchor{x} prose"), so we
// work block-by-block. The rules:
//
//  1. Trailing whitespace stripped per line; the sentence never ends in
//     trailing spaces.
//  2. A leading structural marker ("\n\n" section, "\n\t" paragraph) is
//     preserved as the block's separator but normalized to exactly that.
//  3. A block whose (trimmed) content is a whole block command (&title/&part/
//     &chapter/&meta/&placeholder/&anchor) is emitted as just that command
//     token — no surrounding spaces.
//  4. Leading-anchor rule: if a block's content begins with an &anchor command
//     immediately followed by prose on the same line, the anchor is split onto
//     its own line with a single "\n" join to the prose ("&anchor{x}\nprose"),
//     so segman segments the anchor as its own (block) sentence while the prose
//     stays in the same paragraph. An &anchor anywhere else in the block stays
//     inline (untouched beyond whitespace tidy).
//
// Cross-sentence seams are owned by each sentence's own leading marker, so a
// per-sentence pass suffices — there is no cross-sentence byte movement.
func Canonicalize(text string) string {
	if text == "" {
		return ""
	}

	// Peel a single leading structural marker; it is the block separator and
	// is re-emitted verbatim (normalized) in front of the canonical body.
	marker := ""
	body := text
	if strings.HasPrefix(body, MarkerSection) {
		marker = MarkerSection
		body = body[len(MarkerSection):]
	} else if strings.HasPrefix(body, MarkerParagraph) {
		marker = MarkerParagraph
		body = body[len(MarkerParagraph):]
	}

	body = canonicalizeBody(body)
	return marker + body
}

// canonicalizeBody canonicalizes a marker-stripped block body.
func canonicalizeBody(body string) string {
	trimmed := strings.TrimSpace(body)
	if trimmed == "" {
		return ""
	}

	// Whole-block command → just the command token.
	if cmd, ok := ParseCommand(trimmed); ok && blockCommandKinds[cmd.Kind] && cmd.Raw == trimmed {
		return cmd.Raw
	}

	// Leading-anchor split: "&anchor{...} prose" → "&anchor{...}\nprose".
	// Idempotent: any run of whitespace (spaces, tabs, OR the newline this rule
	// itself inserts) between the anchor and following prose normalizes to a
	// single "\n". Recognize an anchor command at the very start with trailing
	// content. &snippet (canon region opener) follows the same rule.
	if strings.HasPrefix(trimmed, "&anchor") || strings.HasPrefix(trimmed, "&snippet") {
		if cmd, ok := ParseCommand(trimmed); ok && (cmd.Kind == CmdAnchor || cmd.Kind == CmdSnippet) {
			rest := trimmed[len(cmd.Raw):]
			restTrimmed := strings.TrimLeft(rest, " \t\n")
			if restTrimmed != "" {
				// Anchor leads a paragraph, prose follows → block anchor form.
				return cmd.Raw + "\n" + canonicalizeProse(restTrimmed)
			}
			// Anchor with no trailing prose is a whole-block command.
			return cmd.Raw
		}
	}

	// Ordinary prose (may contain inline commands, which are left intact).
	return canonicalizeProse(trimmed)
}

// canonicalizeProse tidies a prose run: it collapses no words, only trims edge
// whitespace (inner spacing is the author's). Inline &-commands are untouched.
func canonicalizeProse(s string) string {
	return strings.TrimRight(strings.TrimLeft(s, " \t"), " \t")
}
