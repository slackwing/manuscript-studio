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

  function canonicalizeBody(body) {
    const trimmed = body.trim();
    if (trimmed === '') return '';

    const cmd = cmdLib();

    // Whole-block command → just the token.
    if (cmd) {
      const parsed = cmd.parse(trimmed);
      if (parsed && cmd.BLOCK[parsed.kind] && parsed.raw === trimmed) {
        return parsed.raw;
      }
      // Leading-anchor split. Idempotent: spaces, tabs, OR the inserted
      // newline between the anchor and prose all normalize to a single "\n".
      // &snippet (canon region opener) follows the same rule — Go lockstep.
      if (trimmed.startsWith('&anchor') || trimmed.startsWith('&snippet')) {
        const a = cmd.parse(trimmed);
        if (a && (a.kind === 'anchor' || a.kind === 'snippet')) {
          const rest = trimmed.slice(a.raw.length).replace(/^[ \t\n]+/, '');
          if (rest !== '') {
            return a.raw + '\n' + canonicalizeProse(rest);
          }
          return a.raw;
        }
      }
    }

    return canonicalizeProse(trimmed);
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
    }
    return marker + canonicalizeBody(body);
  }

  return { canonicalize };
})();

if (typeof window !== 'undefined') {
  window.WriteSysCanonicalize = WriteSysCanonicalize;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = WriteSysCanonicalize;
}
