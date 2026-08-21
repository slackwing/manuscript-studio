// Markdown → .manuscript normalizer unit tests (MANUSCRIPT_LIFECYCLE_PLAN
// §6). Pure Node — no browser, no server: the module is standalone by
// design (browser + Node + future CLI).
const assert = require('assert');
const N = require('../web/js/manuscript-normalize.js');

let failures = 0;
function t(name, fn) {
  try {
    fn();
    console.log(`  ok - ${name}`);
  } catch (e) {
    failures++;
    console.error(`  FAIL - ${name}: ${e.message}`);
  }
}

t('heading shift: top level becomes ## (chapters), no scene inference', () => {
  const out = N.normalize('# Chapter 1\n\nFirst para.\n\nSecond para.');
  assert.strictEqual(out, '## Chapter 1\n\nFirst para.\n\tSecond para.');
});

t('already-## headings stay put', () => {
  const out = N.normalize('## Chapter 2\n\nText.');
  assert.strictEqual(out, '## Chapter 2\n\nText.');
});

t('deeper headings shift along with the top level', () => {
  const out = N.normalize('# Book\n\n### Part\n\nText.');
  assert.strictEqual(out, '## Book\n\n#### Part\n\nText.');
});

t('paragraph runs: first flush, rest \\n\\t-joined', () => {
  const out = N.normalize('One.\n\nTwo.\n\nThree.');
  assert.strictEqual(out, 'One.\n\tTwo.\n\tThree.');
});

t('heading resets the paragraph run', () => {
  const out = N.normalize('## A\n\nP1.\n\nP2.\n\n## B\n\nP3.\n\nP4.');
  assert.strictEqual(out, '## A\n\nP1.\n\tP2.\n\n## B\n\nP3.\n\tP4.');
});

t('soft-wrapped lines inside a paragraph collapse to spaces', () => {
  const out = N.normalize('A sentence\nthat wraps\nacross lines.');
  assert.strictEqual(out, 'A sentence that wraps across lines.');
});

t('curly quotes straighten; nbsp becomes space; zero-width junk dies', () => {
  const out = N.normalize('“It’s here,” she said.​');
  assert.strictEqual(out, '"It\'s here," she said.');
});

t('turndown backslash-escapes are unescaped', () => {
  const out = N.normalize('It was 1\\. a list\\-like line \\*not emphasis\\*.');
  assert.strictEqual(out, 'It was 1. a list-like line *not emphasis*.');
});

t('italics and em dashes survive untouched', () => {
  const out = N.normalize('*So it was* — the epidemic.');
  assert.strictEqual(out, '*So it was* — the epidemic.');
});

t('empty and whitespace-only input → empty string', () => {
  assert.strictEqual(N.normalize(''), '');
  assert.strictEqual(N.normalize('  \n\n  '), '');
});

t('CRLF input normalizes', () => {
  const out = N.normalize('One.\r\n\r\nTwo.');
  assert.strictEqual(out, 'One.\n\tTwo.');
});

if (failures) {
  console.error(`${failures} normalizer test(s) failed`);
  process.exit(1);
}
console.log('test-manuscript-normalize: all passed');

// Appended: bold-paragraph chapter titles (the Word-manuscript convention —
// short bold-only paragraphs are headings, consecutive ones merge).
const N2 = require('../web/js/manuscript-normalize.js');
let failures2 = 0;
function t2(name, fn) {
  try { fn(); console.log(`  ok - ${name}`); }
  catch (e) { failures2++; console.error(`  FAIL - ${name}: ${e.message}`); }
}

t2('bold-only chapter + title lines merge into one ## heading', () => {
  const out = N2.normalize('**Chapter 1**\n\n**The Predator Paradox**\n\nFirst para.\n\nSecond.');
  assert.strictEqual(out, '## Chapter 1: The Predator Paradox\n\nFirst para.\n\tSecond.');
});

t2('a lone bold-only line becomes a heading', () => {
  const out = N2.normalize('**Prologue**\n\nText.');
  assert.strictEqual(out, '## Prologue\n\nText.');
});

t2('long bold paragraphs are NOT promoted (real emphasis stays)', () => {
  const long = '**' + 'x'.repeat(80) + '**';
  const out = N2.normalize(long + '\n\nText.');
  assert.strictEqual(out, long + '\n\tText.');
});

t2('paragraphs with internal bold are untouched', () => {
  const out = N2.normalize('It was **very** cold.');
  assert.strictEqual(out, 'It was **very** cold.');
});

if (failures2) { console.error(`${failures2} bold-heading test(s) failed`); process.exit(1); }
console.log('bold-heading tests: all passed');
