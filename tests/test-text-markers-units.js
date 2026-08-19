/**
 * Unit tests (no browser, no server) for web/js/text-markers.js — the
 * §/¶ glyph conversion at the UI/storage boundary and the shared HTML
 * escaper (CODE_REVIEW_AUG_2026.md §3.4 rows T1–T3).
 */
const tm = require('../web/js/text-markers.js');

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed++;
};

// ---- T1: toGlyphs basics ----------------------------------------------
console.log('=== T1 toGlyphs-basic ===');
check('\\n\\n → §', tm.toGlyphs('\n\nNew section.') === '§New section.');
check('\\n\\t → ¶', tm.toGlyphs('\n\tIndented.') === '¶Indented.');
check('mixed markers mid-text', tm.toGlyphs('a\n\nb\n\tc') === 'a§b¶c');
check('null → empty string', tm.toGlyphs(null) === '');
check('undefined → empty string', tm.toGlyphs(undefined) === '');
check('plain text untouched', tm.toGlyphs('no markers here') === 'no markers here');
check('lone \\n untouched', tm.toGlyphs('a\nb') === 'a\nb');
check('glyph constants exported', tm.SECTION_GLYPH === '§' && tm.PARAGRAPH_GLYPH === '¶');

// ---- T2: fromGlyphs ordering + round trip ------------------------------
console.log('=== T2 fromGlyphs-order ===');
check('§ → \\n\\n', tm.fromGlyphs('§New section.') === '\n\nNew section.');
check('¶ → \\n\\t', tm.fromGlyphs('¶Indented.') === '\n\tIndented.');
check('escape-literal \\n\\n (4 chars) → real \\n\\n', tm.fromGlyphs('\\n\\nX') === '\n\nX');
check('escape-literal \\n\\t → real \\n\\t', tm.fromGlyphs('\\n\\tX') === '\n\tX');
// Order matters: glyphs convert BEFORE escape-literals, so a glyph-produced
// real newline can never be re-consumed by the escape-literal pass, and a
// typed literal alongside a glyph converts independently.
check('glyphs-before-literals: "§\\n\\t" (glyph + typed literal) → both real markers',
  tm.fromGlyphs('§\\n\\t') === '\n\n\n\t');
check('round-trip identity on storage form',
  tm.fromGlyphs(tm.toGlyphs('\n\tPara one.\n\nSection two.')) === '\n\tPara one.\n\nSection two.');
check('null → empty string', tm.fromGlyphs(null) === '');
check('undefined → empty string', tm.fromGlyphs(undefined) === '');

// ---- T3: escapeHTML all five entities ----------------------------------
console.log('=== T3 escapeHTML-entities ===');
check('& → &amp;', tm.escapeHTML('a & b') === 'a &amp; b');
check('< → &lt;', tm.escapeHTML('a < b') === 'a &lt; b');
check('> → &gt;', tm.escapeHTML('a > b') === 'a &gt; b');
check('" → &quot;', tm.escapeHTML('a "b"') === 'a &quot;b&quot;');
check("' → &#39;", tm.escapeHTML("a 'b'") === 'a &#39;b&#39;');
check('all five together',
  tm.escapeHTML(`<a href="x" & 'y'>`) === '&lt;a href=&quot;x&quot; &amp; &#39;y&#39;&gt;');
check('ampersand escaped first (no double-escape)',
  tm.escapeHTML('&lt;') === '&amp;lt;');
check('non-string coerced', tm.escapeHTML(5) === '5');


// ---- T4: fixEllipsisText — quote direction before an ellipsis -----------
console.log('=== T4 fixEllipsisText ===');
check('T4: ”… at string start re-curls open', tm.fixEllipsisText('”…then he said') === '“…then he said');
check('T4: ”... after space re-curls open', tm.fixEllipsisText('said ”...then') === 'said “...then');
check('T4: ’… single-quote variant re-curls open', tm.fixEllipsisText(' ’…whisper') === ' ‘…whisper');
check('T4: closing quote after a word stays closed', tm.fixEllipsisText('he said.”… and then') === 'he said.”… and then');
check('T4: mid-word apostrophe untouched', tm.fixEllipsisText('rock’n’roll…') === 'rock’n’roll…');
check('T4: after open bracket re-curls', tm.fixEllipsisText('(”…aside)') === '(“…aside)');
check('T4: no ellipsis → untouched', tm.fixEllipsisText('”then') === '”then');
check('T4: double-prime before dots re-curls open', tm.fixEllipsisText('″...then') === '“...then');
check('T4: single-prime before ellipsis re-curls open', tm.fixEllipsisText(' ′…then') === ' ‘…then');
check('T4: genuine prime after number untouched', tm.fixEllipsisText('5′10″ tall…') === '5′10″ tall…');

console.log('');
if (failed === 0) {
  console.log('✅ text-markers.js units: all checks pass');
  process.exit(0);
} else {
  console.log(`❌ ${failed} check(s) failed`);
  process.exit(1);
}
