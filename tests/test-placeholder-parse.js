// Unit (no browser, no server): &placeholder argument interpretation in
// command.js and deterministic filler generation in placeholder.js.
// Mirrors internal/sentence TestParsePlaceholder — keep in lockstep.
const cmd = require('../web/js/command.js');
const ph = require('../web/js/placeholder.js');

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed++;
};

console.log('=== &placeholder parsing + filler ===\n');

// --- parse() recognizes the keyword ---
const p = cmd.parse('&placeholder#reunion{sentences}{l}{Reunion}{They meet. Wordless.}');
check('parses &placeholder with slug + 4 args',
  !!p && p.kind === 'placeholder' && p.slug === 'reunion' && p.args.length === 4);
check('literal "&placeholder of doom" is not a command', cmd.parse('&placeholder of doom') === null);

// --- placeholderSpec: sizes, sniffing, defaults, mis-syntax ---
const spec = (args) => cmd.placeholderSpec(args);
check('size defaults to m (3 sentences)', (() => {
  const s = spec(['sentences']); return s.valid && s.size === 'm' && s.count === 3;
})());
check('sentence scale: xxxl = 40', spec(['sentences', 'xxxl']).count === 40);
check('paragraph scale: xxxl = 21 (Fibonacci)', spec(['paragraphs', 'xxxl']).count === 21);
check('paragraph scale: xl = 8', spec(['paragraphs', 'xl']).count === 8);
check('size-enum sniffing: non-size arg 2 is the label', (() => {
  const s = spec(['sentences', 'Reunion beat']);
  return s.valid && s.size === 'm' && s.label === 'Reunion beat';
})());
check('label that IS a size keyword: written after explicit size', (() => {
  const s = spec(['sentences', 'm', 's']);
  return s.valid && s.size === 'm' && s.label === 's';
})());
check('full signature', (() => {
  const s = spec(['sentences', 'l', 'Reunion', 'They meet.']);
  return s.valid && s.count === 5 && s.label === 'Reunion' && s.details === 'They meet.';
})());
check('bad unit is invalid', spec(['words', 'm']).valid === false);
check('5 args (no size) is invalid', spec(['sentences', 'a', 'b', 'c', 'd']).valid === false);

// --- block/inline decisions ---
check('sole-line placeholder is a block command', cmd.isBlockCommandText('&placeholder{paragraphs}{m}'));
check('findInline picks up a mid-line placeholder', (() => {
  const found = cmd.findInline('before &placeholder{sentences}{s} after');
  return found.length === 1 && found[0].kind === 'placeholder' && found[0].args.length === 2;
})());
check('RULE 10 shape: details with periods stay one token', (() => {
  const found = cmd.findInline('Start. &placeholder{sentences}{l}{X}{They meet. Wordless.} End.');
  return found.length === 1 && found[0].args[3] === 'They meet. Wordless.';
})());

// --- deterministic, seeded filler ---
const sA = ph.inlineHTML(spec(['sentences', 'l', 'R', 'd']), 'seed');
const sB = ph.inlineHTML(spec(['sentences', 'l', 'R', 'd']), 'seed');
const sC = ph.inlineHTML(spec(['sentences', 'l', 'R', 'd']), 'other');
check('filler is deterministic for a given slug', sA === sB);
check('different slug seeds different filler', sA !== sC);
check('fillerSentences(5) yields 5 sentences', (ph.fillerSentences(5, ph.rng('x')).match(/\./g) || []).length === 5);
check('fillerParagraphs(3) yields 3 paragraphs', ph.fillerParagraphs(3, ph.rng('y')).length === 3);

// --- rendered HTML shape + escaping ---
check('inline HTML is an aria-hidden .ph span', /class="ph"[^>]*aria-hidden="true"/.test(sA.replace('data-slug="seed" ', '')) || /<span class="ph" data-slug="seed" aria-hidden="true">/.test(sA));
check('inline chip carries slug — label head', sA.includes('#seed — R'));
const evil = ph.blockHTML(
  spec(['paragraphs', 's', '<script>alert(1)</script>', '"><img src=x>']),
  'x', 'id1', false, (t) => String(t));
check('block HTML escapes label and details', !evil.includes('<script>') && !evil.includes('<img'));
check('block HTML has one <p> per paragraph (s = 2)', (evil.match(/<p[ >]/g) || []).length === 2);
check('block overlay chip present', evil.includes('ph-chip-block'));

console.log(failed === 0 ? '\n✅ Test passed' : `\n❌ ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
