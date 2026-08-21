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

t('headings become &chapter commands (markdown # is deprecated)', () => {
  const out = N.normalize('# Chapter 1\n\nFirst para.\n\nSecond para.');
  assert.strictEqual(out, '&chapter{Chapter 1}\n\nFirst para.\n\tSecond para.');
});

t('every heading level maps to &chapter', () => {
  const out = N.normalize('## Chapter 2\n\nText.\n\n### Deeper\n\nMore.');
  assert.strictEqual(out, '&chapter{Chapter 2}\n\nText.\n\n&chapter{Deeper}\n\nMore.');
});

t('"label: title" headings split into label + outline description', () => {
  const out = N.normalize('# Chapter 2: The Reckoning\n\nText.');
  assert.strictEqual(out, '&chapter{Chapter 2}{The Reckoning}\n\nText.');
});

t('braces in headings become parentheses (command syntax safety)', () => {
  const out = N.normalize('# The {Weird} One\n\nText.');
  assert.strictEqual(out, '&chapter{The (Weird) One}\n\nText.');
});

t('paragraph runs: first flush, rest \\n\\t-joined', () => {
  const out = N.normalize('One.\n\nTwo.\n\nThree.');
  assert.strictEqual(out, 'One.\n\tTwo.\n\tThree.');
});

t('heading resets the paragraph run', () => {
  const out = N.normalize('## A\n\nP1.\n\nP2.\n\n## B\n\nP3.\n\nP4.');
  assert.strictEqual(out, '&chapter{A}\n\nP1.\n\tP2.\n\n&chapter{B}\n\nP3.\n\tP4.');
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

t2('bold-only chapter + title lines merge into one &chapter command', () => {
  const out = N2.normalize('**Chapter 1**\n\n**The Predator Paradox**\n\nFirst para.\n\nSecond.');
  assert.strictEqual(out, '&chapter{Chapter 1}{The Predator Paradox}\n\nFirst para.\n\tSecond.');
});

t2('a lone bold-only line becomes a chapter', () => {
  const out = N2.normalize('**Prologue**\n\nText.');
  assert.strictEqual(out, '&chapter{Prologue}\n\nText.');
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

// Appended: authors' hand-rolled section breaks → \n\n section start.
let failures3 = 0;
function t3(name, fn) {
  try { fn(); console.log(`  ok - ${name}`); }
  catch (e) { failures3++; console.error(`  FAIL - ${name}: ${e.message}`); }
}

t3('*** becomes a section break (next para flush after blank line)', () => {
  const out = N.normalize('One.\n\nTwo.\n\n***\n\nThree.\n\nFour.');
  assert.strictEqual(out, 'One.\n\tTwo.\n\nThree.\n\tFour.');
});

t3('spaced and odd-asterisk markers count ("* ✻ *")', () => {
  const out = N.normalize('One.\n\n* ✻ *\n\nTwo.');
  assert.strictEqual(out, 'One.\n\nTwo.');
});

t3('a leading marker (nothing before it) is just dropped', () => {
  const out = N.normalize('***\n\nOne.');
  assert.strictEqual(out, 'One.');
});

t3('short dashes count; real prose does not', () => {
  assert.strictEqual(N.normalize('One.\n\n---\n\nTwo.'), 'One.\n\nTwo.');
  assert.strictEqual(N.normalize('One.\n\nA-B.\n\nTwo.'), 'One.\n\tA-B.\n\tTwo.');
});

if (failures3) { console.error(`${failures3} section-break test(s) failed`); process.exit(1); }
console.log('section-break tests: all passed');
