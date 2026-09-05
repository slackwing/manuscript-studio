/**
 * canonicalize(text) — normalize a single sentence's effective text to the
 * house canonical form. Mirror of internal/sentence/canonicalize.go; the two
 * ports are kept in lockstep by tests/canonicalize-scenarios.jsonl.
 *
 * Runs per-sentence in the render loop (renderer.js / outline.js / settings)
 * and accumulates into the push source. PURE and IDEMPOTENT:
 * canonicalize(canonicalize(x)) === canonicalize(x).
 *
 * See CANONICALIZE_PLAN.md for the rules. In brief:
 *   1. Trailing whitespace stripped.
 *   2. A single leading structural marker (\n\n section / \n\t paragraph) is
 *      preserved as the block separator.
 *   3. A whole-block command emits just its token (no surrounding spaces).
 *   4. Leading-anchor rule: "&anchor{x} prose" → "&anchor{x}\nprose" so the
 *      anchor segments as its own block sentence while prose stays in the same
 *      paragraph. An anchor anywhere else stays inline.
 */
const WriteSysCanonicalize = (function () {
  const MARKER_SECTION = '\n\n';
  const MARKER_PARAGRAPH = '\n\t';

  const cmdLib = () => (typeof window !== 'undefined' ? window.WriteSysCommand : null)
    || (typeof require === 'function' ? require('./command.js') : null);

  function canonicalizeProse(s) {
    return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  }

  function canonicalizeBody(body, hasMarker) {
    const trimmed = body.trim();
    if (trimmed === '') return '';

    const cmd = cmdLib();

    // Whole-block command → just the token.
    if (cmd) {
      const parsed = cmd.parse(trimmed);
      if (parsed && cmd.BLOCK[parsed.kind] && parsed.raw === trimmed) {
        return parsed.raw;
      }
      // Leading-anchor forms (Go lockstep). Marker-led or newline-joined →
      // block form ("&anchor{...}\nprose", own line). MARKER-LESS with a
      // space/tab join → INLINE form ("&anchor{...} prose", one space) — a
      // mid-paragraph region start; the renderer shows the go-to icon
      // between the two spaces. Idempotent both ways.
      if (trimmed.startsWith('&anchor') || trimmed.startsWith('&sketch') || trimmed.startsWith('&snippet')) {
        const a = cmd.parse(trimmed);
        if (a && (a.kind === 'anchor' || a.kind === 'sketch')) {
          const restRaw = trimmed.slice(a.raw.length);
          const rest = restRaw.replace(/^[ \t\n]+/, '');
          if (rest !== '') {
            const ws = restRaw.slice(0, restRaw.length - rest.length);
            if (!hasMarker && !ws.includes('\n')) {
              return a.raw + ' ' + canonicalizeProse(rest);
            }
            // A STRUCTURAL MARKER in the whitespace between anchor and prose
            // is the prose's paragraph break — keep \n\t (indented) or \n\n
            // (section); plain runs stay "\n". Go lockstep.
            const join = ws.includes('\n\t') ? '\n\t' : (ws.includes('\n\n') ? '\n\n' : '\n');
            return a.raw + join + canonicalizeProse(rest);
          }
          return a.raw;
        }
      }
    }

    return canonicalizeProse(trimmed);
  }

  // Bare "\n" + block anchor = "anchor on its own line". Trimming it
  // space-joined the anchor onto the END of the previous paragraph in the
  // pushed source (the glued-opener bug) — keep the separator. Go lockstep.
  function leadingAnchorNewline(body) {
    if (!body.startsWith('\n')) return false;
    const rest = body.replace(/^[ \t\n]+/, '');
    if (!(rest.startsWith('&anchor') || rest.startsWith('&sketch') || rest.startsWith('&snippet'))) return false;
    const cmd = cmdLib();
    const a = cmd && cmd.parse(rest);
    return !!(a && (a.kind === 'anchor' || a.kind === 'sketch'));
  }

  function canonicalize(text) {
    if (text === '' || text == null) return '';
    let marker = '';
    let body = String(text);
    if (body.startsWith(MARKER_SECTION)) {
      marker = MARKER_SECTION;
      body = body.slice(MARKER_SECTION.length);
    } else if (body.startsWith(MARKER_PARAGRAPH)) {
      marker = MARKER_PARAGRAPH;
      body = body.slice(MARKER_PARAGRAPH.length);
    } else if (leadingAnchorNewline(body)) {
      marker = '\n';
      body = body.replace(/^[ \t\n]+/, '');
    }
    return marker + canonicalizeBody(body, marker !== '');
  }

  return { canonicalize };
})();

if (typeof window !== 'undefined') {
  window.WriteSysCanonicalize = WriteSysCanonicalize;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = WriteSysCanonicalize;
}
