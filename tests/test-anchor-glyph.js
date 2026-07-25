/**
 * Anchor glyph — pure unit test (no DB, no browser, no dev server).
 *
 * A block anchor must be marked for GLYPH rendering (⚓) with its label carried
 * as hover metadata, NOT as visible book text. The decision lives in
 * command.js structuralForm(); renderer.js turns form.glyph into the ⚓ span.
 * We assert structuralForm's contract here (the render string shape is checked
 * by the existing browser smoke path).
 */
const cmd = require('../web/js/command.js');

let failed = 0;
const check = (name, ok, extra) => {
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) failed++;
};

// Block anchor → glyph form, label in metadata, NOT in visible.
const anchor = cmd.structuralForm('&anchor#salvia{The salvia night.}');
check('anchor form exists', !!anchor);
check('anchor is glyph', anchor && anchor.glyph === true);
check('anchor visible is empty (no book text)', anchor && anchor.visible === '');
check('anchor label carried for hover/outline', anchor && anchor.label === 'The salvia night.', JSON.stringify(anchor && anchor.label));
check('anchor tag/class unchanged', anchor && anchor.tag === 'div' && anchor.cls === 'cmd-anchor');

// Anchor with no slug still glyphs.
const anon = cmd.structuralForm('&anchor{Waypoint}');
check('slugless anchor is glyph', anon && anon.glyph === true && anon.label === 'Waypoint');

// Non-anchor block commands are NOT glyphs (title/part/chapter show text).
const title = cmd.structuralForm('&title{The Wildfire}');
check('title is not glyph', title && !title.glyph && title.visible === 'The Wildfire');
const chapter = cmd.structuralForm('&chapter#c1{1.}{Smoke}');
check('chapter is not glyph', chapter && !chapter.glyph && chapter.visible === '1.');

// An inline anchor is not a structural form at all (findInline handles it).
const inlineIsBlock = cmd.isBlockCommandText('The fire &anchor#x{} spread.');
check('inline anchor is not a block command', inlineIsBlock === false);

if (failed === 0) {
  console.log('\n✅ anchor glyph: all checks pass');
  process.exit(0);
}
console.log(`\n${failed} check(s) failed`);
process.exit(1);
