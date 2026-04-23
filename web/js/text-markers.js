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

window.WriteSysTextMarkers = { toGlyphs, fromGlyphs, SECTION_GLYPH, PARAGRAPH_GLYPH };
