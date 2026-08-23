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
	} else if leadingAnchorNewline(body) {
		// Bare "\n" + block anchor = "anchor on its own line". Trimming it
		// space-joined the anchor onto the END of the previous paragraph in
		// the pushed source (the glued-opener bug) — keep the separator.
		marker = "\n"
		body = strings.TrimLeft(body, " \t\n")
	}

	body = canonicalizeBody(body, marker != "")
	return marker + body
}

// leadingAnchorNewline reports whether text begins with a bare "\n" (not a
// structural marker) directly followed by a block anchor command — the
// "anchor on its own line" form. Dropping that newline space-joined the
// anchor onto the END of the previous paragraph in the pushed source (the
// glued-opener bug), so canonicalize must preserve it.
func leadingAnchorNewline(body string) bool {
	if !strings.HasPrefix(body, "\n") {
		return false
	}
	rest := strings.TrimLeft(body, " \t\n")
	if !(strings.HasPrefix(rest, "&anchor") || strings.HasPrefix(rest, "&snippet") || strings.HasPrefix(rest, "&sketch")) {
		return false
	}
	cmd, ok := ParseCommand(rest)
	return ok && (cmd.Kind == CmdAnchor || cmd.Kind == CmdSnippet)
}

func canonicalizeBody(body string, hasMarker bool) string {
	trimmed := strings.TrimSpace(body)
	if trimmed == "" {
		return ""
	}

	// Whole-block command → just the command token.
	if cmd, ok := ParseCommand(trimmed); ok && blockCommandKinds[cmd.Kind] && cmd.Raw == trimmed {
		return cmd.Raw
	}

	// Leading-anchor forms. Marker-led (or newline-joined) → block form:
	// "&anchor{...}\nprose", the anchor on its own line. MARKER-LESS with a
	// space/tab join → INLINE form: "&anchor{...} prose" stays in the
	// paragraph, one space — a mid-paragraph region start (2026-08-22:
	// inline starts to anchored sections; the renderer shows the go-to icon
	// between the two spaces). Idempotent both ways.
	if strings.HasPrefix(trimmed, "&anchor") || strings.HasPrefix(trimmed, "&snippet") || strings.HasPrefix(trimmed, "&sketch") {
		if cmd, ok := ParseCommand(trimmed); ok && (cmd.Kind == CmdAnchor || cmd.Kind == CmdSnippet) {
			rest := trimmed[len(cmd.Raw):]
			restTrimmed := strings.TrimLeft(rest, " \t\n")
			if restTrimmed != "" {
				ws := rest[:len(rest)-len(restTrimmed)]
				if !hasMarker && !strings.Contains(ws, "\n") {
					// Mid-paragraph inline start: keep the anchor in the flow.
					return cmd.Raw + " " + canonicalizeProse(restTrimmed)
				}
				// Block form. A STRUCTURAL MARKER in the whitespace between
				// anchor and prose is the prose's paragraph break — collapsing
				// it to a bare "\n" merged the paragraph into the previous one
				// (the sketch-from-selection "new paragraph removed" bug). Keep
				// \n\t (indented) or \n\n (section); plain runs stay "\n".
				join := "\n"
				if strings.Contains(ws, "\n\t") {
					join = "\n\t"
				} else if strings.Contains(ws, "\n\n") {
					join = "\n\n"
				}
				return cmd.Raw + join + canonicalizeProse(restTrimmed)
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
