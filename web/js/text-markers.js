/**
 * Glyph conversion at the UI/storage boundary.
 *
 * Storage form (DB + API): real `\n\n` (section break) and `\n\t` (paragraph
 * break) as leading characters on a sentence's text.
 *
 * UI form: `§` (U+00A7) and `¶` (U+00B6) so users can see and edit the
 * markers without dealing with literal whitespace. Replacements happen
 * everywhere we put sentence text into a textarea, popup, etc.
 *
 * Input is permissive: glyphs, real newlines, OR escape-style four-character
 * literals (`\n\n` typed as backslash-n-backslash-n) all collapse to the
 * same storage form.
 */

const SECTION_GLYPH = '\u00A7';   // §
const PARAGRAPH_GLYPH = '\u00B6'; // ¶

function toGlyphs(text) {
  if (text == null) return '';
  return text.replace(/\n\n/g, SECTION_GLYPH).replace(/\n\t/g, PARAGRAPH_GLYPH);
}

// Glyphs are converted before escape-literals so a user-typed "\n\n" doesn't
// collide with a § that has already become a real newline.
function fromGlyphs(text) {
  if (text == null) return '';
  text = text.replace(new RegExp(SECTION_GLYPH, 'g'), '\n\n');
  text = text.replace(new RegExp(PARAGRAPH_GLYPH, 'g'), '\n\t');
  text = text.replace(/\\n\\n/g, '\n\n');
  text = text.replace(/\\n\\t/g, '\n\t');
  return text;
}

if (typeof window !== 'undefined') {
  window.WriteSysTextMarkers = { toGlyphs, fromGlyphs, SECTION_GLYPH, PARAGRAPH_GLYPH };
}

// Shared HTML-escaper — the ONE escaper for the app. The load-order
// invariant is that text-markers.js loads BEFORE its consumers
// (info-tooltip.js, renderer.js, suggestions.js, outline.js) in every page
// that uses them — not that it loads first overall. Do not re-declare
// per-file copies.
function escapeHTML(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Smartquotes post-pass. The library curls direction from the NEXT character,
// so a quote that opens with an ellipsis — dialogue like `"...then` — falls
// through to its closing-quote fallback and renders `”…then`. Re-curl a
// close-quote to an open-quote when it sits at a word start (string start or
// after whitespace/open-bracket) immediately before an ellipsis. Runs on
// TEXT NODES after smartquotes so storage and diffs stay untouched.
var ELLIPSIS_DQ = /(^|[\s([‘“])[”″](?=…|\.\.\.)/g; // ”/″ before …
var ELLIPSIS_SQ = /(^|[\s([“])[’′](?=…|\.\.\.)/g; // ’/′ before …
function fixEllipsisText(t) {
  return t.replace(ELLIPSIS_DQ, '$1“').replace(ELLIPSIS_SQ, '$1‘');
}
function fixEllipsisQuotes(root) {
  const walker = (root.ownerDocument || document).createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    const t = n.textContent;
    if (!/[”’″′]/.test(t)) continue;
    const fixed = fixEllipsisText(t);
    if (fixed !== t) n.textContent = fixed;
  }
}

// One entry point for "curl this container": smartquotes + the post-pass.
// All render-pipeline call sites go through here so the correction can never
// be applied to one pass and forgotten on another.
function curlQuotes(el) {
  if (typeof smartquotes !== 'undefined') smartquotes.element(el);
  fixEllipsisQuotes(el);
}

if (typeof window !== 'undefined') {
  window.WriteSysTextMarkers.fixEllipsisQuotes = fixEllipsisQuotes;
  window.WriteSysTextMarkers.curlQuotes = curlQuotes;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { toGlyphs, fromGlyphs, escapeHTML, SECTION_GLYPH, PARAGRAPH_GLYPH, fixEllipsisText, fixEllipsisQuotes };
}
