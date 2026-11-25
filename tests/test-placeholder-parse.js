// Unit (no browser, no server): &placeholder argument interpretation in
// command.js and the sized lorem excerpt in placeholder.js (PLACEHOLDER_PLAN.md
// v2). Mirrors internal/sentence TestParsePlaceholder — keep in lockstep.
const cmd = require('../web/js/command.js');
const ph = require('../web/js/placeholder.js');

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed++;
};

console.log('=== &placeholder parsing + lorem excerpt ===\n');

// --- parse() recognizes the keyword ---
const p = cmd.parse('&placeholder#reunion{sentences}{l}{Reunion}');
check('parses &placeholder with slug + 3 args',
  !!p && p.kind === 'placeholder' && p.slug === 'reunion' && p.args.length === 3);
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
check('full signature {unit}{size}{label}', (() => {
  const s = spec(['sentences', 'l', 'Reunion']);
  return s.valid && s.count === 5 && s.label === 'Reunion' && !('details' in s);
})());
check('bad unit is invalid', spec(['words', 'm']).valid === false);
check('the old fourth {details} arg is mis-syntax now', spec(['sentences', 'l', 'Reunion', 'They meet.']).valid === false);
check('label + details without a size is mis-syntax too', spec(['paragraphs', 'The argument', 'Three beats']).valid === false);

// --- block/inline decisions ---
check('sole-line placeholder is a block command', cmd.isBlockCommandText('&placeholder{paragraphs}{m}'));
check('findInline picks up a mid-line placeholder', (() => {
  const found = cmd.findInline('before &placeholder{sentences}{s} after');
  return found.length === 1 && found[0].kind === 'placeholder' && found[0].args.length === 2;
})());
check('RULE 10 shape: a legacy details arg with periods still parses as one token', (() => {
  const found = cmd.findInline('Start. &placeholder{sentences}{l}{X}{They meet. Wordless.} End.');
  return found.length === 1 && found[0].args.length === 4;
})());

// --- the excerpt is the canonical passage, in order, sized by the spec ---
const sentences = (s) => (s.match(/[.?](\s|$)/g) || []).length;
check('excerptSentences(5) yields 5 sentences', sentences(ph.excerptSentences(5)) === 5);
check('the excerpt starts at the start of the passage', /^Lorem ipsum dolor sit amet/.test(ph.excerptSentences(1)));
check('the excerpt is deterministic', ph.excerptSentences(7) === ph.excerptSentences(7));
check('xxxl sentences (40) wraps the passage without running dry', sentences(ph.excerptSentences(40)) === 40);
check('excerptParagraphs(3) yields 3 paragraphs', ph.excerptParagraphs(3).length === 3);
check('paragraphs are the canonical ones, in order', /^Lorem ipsum/.test(ph.excerptParagraphs(2)[0]) && /^Sed ut perspiciatis/.test(ph.excerptParagraphs(2)[1]));
check('xxxl paragraphs (21) wraps the passage', ph.excerptParagraphs(21).length === 21 && /^Lorem ipsum/.test(ph.excerptParagraphs(21)[3]));

// --- rendered HTML shape + escaping ---
const inline = ph.inlineHTML(spec(['sentences', 'l', 'R']), 'seed');
check('inline HTML is an aria-hidden .ph span carrying the slug', /^<span class="ph" data-slug="seed" aria-hidden="true">Lorem ipsum/.test(inline));
check('inline HTML carries no chip', !inline.includes('ph-chip'));
const evil = ph.blockHTML(
  spec(['paragraphs', 's', '<script>alert(1)</script>']),
  '"><img src=x>', 'id1', false, (t) => String(t));
check('block HTML escapes the slug', !evil.includes('<img'));
check('block HTML has one <p> per paragraph (s = 2)', (evil.match(/<p[ >]/g) || []).length === 2);
check('every block paragraph is a .sentence.ph with the one sentence id', (evil.match(/class="sentence ph" data-sentence-id="id1"/g) || []).length === 2);
check('block HTML has no overlay', !evil.includes('ph-overlay'));
check('a suggested block carries cmd-suggested', ph.blockHTML(spec(['paragraphs']), '', 'x', true, (t) => String(t)).includes('cmd-placeholder cmd-suggested'));

console.log(failed === 0 ? '\n✅ Test passed' : `\n❌ ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
