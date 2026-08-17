/**
 * Unit tests (no browser, no server) for web/js/command.js — the &-command
 * parser, fragment segmenter, settings extractor, inline scanner, and
 * structural-form mapper (CODE_REVIEW_AUG_2026.md §3.4 rows C1–C14) — plus
 * canonicalize null/empty handling (row N1).
 *
 * command.js mirrors internal/sentence/command.go; where a behavior is pinned
 * here it is pinned in BOTH ports (parity is convention-enforced).
 */
const cmd = require('../web/js/command.js');
const { canonicalize } = require('../web/js/canonicalize.js');

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed++;
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want),
    JSON.stringify(got) === JSON.stringify(want) ? '' : `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// ---- C1: parse keyword gating -----------------------------------------
console.log('=== C1 parse-keyword-gating ===');
check('"Smith & Sons" is not a command', cmd.parse('Smith & Sons') === null);
check('"& Sons" is not a command', cmd.parse('& Sons') === null);
check('"R&D" is not a command', cmd.parse('R&D') === null);
check('&chapterX{...} — keyword must be followed by # or {', cmd.parse('&chapterX{one}') === null);
check('"A &chapter of accidents" is literal prose', cmd.parse('&chapter of accidents') === null);
check('bare &end (nothing after keyword) is null', cmd.parse('&end') === null);
for (const kw of ['title', 'part', 'chapter', 'anchor', 'reference', 'meta', 'placeholder', 'snippet']) {
  const brace = cmd.parse(`&${kw}{x}`);
  check(`&${kw}{x} parses`, !!brace && brace.args.length === 1 && brace.args[0] === 'x');
  const hash = cmd.parse(`&${kw}#s1{x}`);
  check(`&${kw}#s1{x} parses with slug`, !!hash && hash.slug === 's1');
}
check('&sketch{x} parses (successor spelling)', !!cmd.parse('&sketch{x}'));
check('&end#slug parses', !!cmd.parse('&end#slug'));

// ---- C2: sketch normalizes to snippet ---------------------------------
console.log('=== C2 parse-sketch-normalizes-to-snippet ===');
{
  const p = cmd.parse('&sketch#a{x}');
  check('kind is snippet', !!p && p.kind === 'snippet');
  check('raw keeps the sketch spelling', !!p && p.raw === '&sketch#a{x}');
  check('slug and args intact', !!p && p.slug === 'a' && p.args[0] === 'x');
}

// ---- C3: &end bare slug self-terminates -------------------------------
console.log('=== C3 parse-end-bare-slug-self-terminates ===');
{
  const p = cmd.parse('&end#abc. Then prose.');
  check('&end#abc. stops at the period', !!p && p.slug === 'abc' && p.raw === '&end#abc');
  check('&end#abc-def takes the whole slug charset', cmd.parse('&end#abc-def').raw === '&end#abc-def');
  check('&end# (empty slug, no args) is null', cmd.parse('&end#') === null);
  // PINNED CURRENT BEHAVIOR: the review inventory (C3) expected `&end{x}` to
  // be null, but BOTH ports accept it today — the final guard is
  // `args.length === 0 && !(kind === 'end' && slug)` (command.js:86 /
  // command.go), and a brace group satisfies it. Pinning the parity; if the
  // grammar is tightened to slug-only &end, fix both ports and flip this.
  const braceEnd = cmd.parse('&end{x}');
  check('&end{x} currently parses (pinned; review expected null — see comment)',
    !!braceEnd && braceEnd.kind === 'end' && braceEnd.slug === '' && braceEnd.args[0] === 'x');
}

// ---- C4: nested braces + unterminated ---------------------------------
console.log('=== C4 parse-nested-braces-depth ===');
{
  const p = cmd.parse('&anchor{a{b}c}');
  eq('nested {a{b}c} captured whole', p && p.args, ['a{b}c']);
  check('deeper nesting {a{b{c}}d}', cmd.parse('&anchor{a{b{c}}d}').args[0] === 'a{b{c}}d');
  check('unterminated group is null', cmd.parse('&anchor{unterminated') === null);
  check('unterminated nested group is null', cmd.parse('&anchor{a{b}') === null);
}

// ---- C5: slug but no args → null (non-end) ----------------------------
console.log('=== C5 parse-no-args-null ===');
check('&anchor#slug (no groups) is null', cmd.parse('&anchor#slug') === null);
check('&title#slug is null', cmd.parse('&title#slug') === null);
check('&reference#slug is null', cmd.parse('&reference#slug') === null);

// ---- C6: isBlockCommandText trailing prose ----------------------------
console.log('=== C6 isBlockCommandText-trailing ===');
check('whole-block &title is block', cmd.isBlockCommandText('&title{x}') === true);
check('surrounding whitespace trimmed', cmd.isBlockCommandText('  &meta{font}{Georgia}  ') === true);
check('trailing prose defeats block', cmd.isBlockCommandText('&title{x} trailing') === false);
check('&reference is never block', cmd.isBlockCommandText('&reference#a{x}') === false);
check('plain prose is not block', cmd.isBlockCommandText('Just prose.') === false);
check('&end#slug alone is block', cmd.isBlockCommandText('&end#slug') === true);

// ---- C7: blank line + tab = indented paragraph ------------------------
console.log('=== C7 segmentFragments-blank-line-plus-tab ===');
{
  const frags = cmd.segmentFragments('\n\n\tPara');
  check('one prose fragment', frags.length === 1 && frags[0].kind === 'prose');
  check('"\\n\\n\\t" resolves to marker \\n\\t (indent, not section)', frags[0].marker === '\n\t');
  check('tab retained on text', frags[0].text === '\tPara');
  const plain = cmd.segmentFragments('\n\nPara');
  check('plain "\\n\\n" stays a section marker', plain[0].marker === '\n\n');
}

// ---- C8: leading-anchor newline form ----------------------------------
console.log('=== C8 segmentFragments-leading-anchor-newline-form ===');
{
  const frags = cmd.segmentFragments('&anchor{x}\nprose');
  check('splits into [command, prose]',
    frags.length === 2 && frags[0].kind === 'command' && frags[1].kind === 'prose');
  check('anchor command carries no marker', frags[0].marker === '');
  check('prose text is the trailing paragraph', frags[1].text === 'prose');
  const marked = cmd.segmentFragments('\n\t&anchor{x}\nprose');
  check('block marker rides the PROSE fragment', marked.length === 2
    && marked[0].marker === '' && marked[1].marker === '\n\t');
  const alone = cmd.segmentFragments('&anchor{x}\n   ');
  check('whitespace-only trailing prose dropped', alone.length === 1 && alone[0].kind === 'command');
}

// ---- C9: snippet/sketch newline form splits like anchor (FIXED) --------
console.log('=== C9 segmentFragments-snippet-newline-symmetry ===');
{
  // RESOLVED (CODE_REVIEW_AUG_2026.md §3.4 C9, §3.1): the leading-command
  // split (command.js segmentFragments) now matches canonicalize
  // (canonicalize.js:45–47 / canonicalize.go): &snippet — and its &sketch
  // spelling, which parse() normalizes to kind 'snippet' — splits into
  // [command, prose] exactly like &anchor (C8). The former asymmetry (the
  // snippet form staying one prose fragment) is gone.
  const sn = cmd.segmentFragments('&snippet#ab{}\nprose');
  check('snippet newline form splits into [command:snippet, prose]',
    sn.length === 2 && sn[0].kind === 'command' && sn[0].cmd.kind === 'snippet'
    && sn[1].kind === 'prose' && sn[1].text === 'prose');
  const sk = cmd.segmentFragments('&sketch#ab{}\nprose');
  check('sketch spelling splits the same (kind normalized to snippet)',
    sk.length === 2 && sk[0].kind === 'command' && sk[0].cmd.kind === 'snippet'
    && sk[0].cmd.raw === '&sketch#ab{}' && sk[1].kind === 'prose');
  check('block marker rides the PROSE fragment (like C8 anchors)', (() => {
    const m = cmd.segmentFragments('\n\t&snippet#ab{}\nprose');
    return m.length === 2 && m[0].marker === '' && m[1].marker === '\n\t';
  })());
  // Contrast case, guaranteed by C8: anchor splits identically.
  check('anchor newline form splits (symmetry)', cmd.segmentFragments('&anchor#ab{lbl}\nprose').length === 2);
  // A snippet mid-prose is untouched — the split is leading-command only.
  const inline = cmd.segmentFragments('The fire &snippet#s{} spread.');
  check('inline snippet mid-prose stays one prose fragment',
    inline.length === 1 && inline[0].kind === 'prose');
}

// ---- C10: marker reset + empty blocks ---------------------------------
console.log('=== C10 segmentFragments-marker-reset-and-empty-blocks ===');
{
  const doubled = cmd.segmentFragments('A.\n\n\n\nB.');
  check('empty block between two \\n\\n skipped (2 frags)', doubled.length === 2);
  check('second frag still gets a \\n\\n marker', doubled[1].marker === '\n\n');
  const lead = cmd.segmentFragments('\n\nA');
  check('leading delimiter yields no empty fragment', lead.length === 1 && lead[0].marker === '\n\n');
  const seq = cmd.segmentFragments('\n\n&title{X}\n\tProse');
  check('command consumed its own marker', seq.length === 2
    && seq[0].kind === 'command' && seq[0].marker === '\n\n');
  check('marker reset after command — prose gets only its own', seq[1].marker === '\n\t');
  const after = cmd.segmentFragments('&title{X}\n\nProse');
  check('marker after a command belongs to the next fragment',
    after[0].marker === '' && after[1].marker === '\n\n');
}

// ---- C11: extractSettings vocabulary ----------------------------------
console.log('=== C11 extractSettings-vocabulary ===');
{
  const ex = (map) => cmd.extractSettings(Object.keys(map), map);
  eq('valid setting applies', ex({ a: '&meta{chapter-align}{center}' }), { 'chapter-align': 'center' });
  eq('last-wins on repeat', ex({ a: '&meta{chapter-align}{center}', b: '&meta{chapter-align}{left}' }),
    { 'chapter-align': 'left' });
  eq('unknown property dropped', ex({ a: '&meta{bogus}{x}' }), {});
  eq('out-of-range value dropped', ex({ a: '&meta{chapter-align}{middle}' }), {});
  eq('empty value dropped', ex({ a: '&meta{font}{}' }), {});
  eq('single-arg meta dropped', ex({ a: '&meta{font}' }), {});
  eq('font accepts any non-empty value', ex({ a: '&meta{font}{Baskerville}' }), { font: 'Baskerville' });
  eq('non-whole-block meta ignored', ex({ a: '&meta{chapter-align}{center} trailing' }), {});
  eq('multi-block text scanned per block',
    ex({ a: 'Prose first.\n\n&meta{title-align}{left}\n\t&meta{divider-folios}{off}' }),
    { 'title-align': 'left', 'divider-folios': 'off' });
  eq('null effective text skipped', cmd.extractSettings(['a'], {}), {});
  eq('part-align validated', ex({ a: '&meta{part-align}{center}' }), { 'part-align': 'center' });
  eq('divider-folios out-of-range dropped', ex({ a: '&meta{divider-folios}{maybe}' }), {});
}

// ---- C12: findInline block short-circuit ------------------------------
console.log('=== C12 findInline-block-short-circuit ===');
eq('whole-block anchor yields no inline commands', cmd.findInline('&anchor#a{x}'), []);
eq('whole-block with surrounding spaces still short-circuits', cmd.findInline('  &anchor#a{x}  '), []);
check('same token with a tail IS inline', cmd.findInline('&anchor#a{x} tail').length === 1);

// ---- C13: findInline kinds + codepoint offsets ------------------------
console.log('=== C13 findInline-kinds-and-offsets ===');
{
  // '𝒜' is astral (2 UTF-16 units, 1 code point) — offsets must be
  // code-point-based, so the command starts at cp index 2, not 3.
  const t = '\u{1D49C} &reference#tgt{n} tail';
  const out = cmd.findInline(t);
  check('one reference found after astral char', out.length === 1 && out[0].kind === 'reference');
  check('codepoint start offset (2, not UTF-16 3)', out[0].start === 2, `start=${out[0] && out[0].start}`);
  check('codepoint end offset (start + raw cp length)', out[0].end === 2 + Array.from('&reference#tgt{n}').length);
  check('notes = first arg', out[0].notes === 'n');

  const kinds = cmd.findInline('a &reference#r{n} b &anchor#a{} c &placeholder#p{sentences}{s} d &snippet#s{} e &end#z f');
  eq('all five inline kinds reported in order',
    kinds.map((c) => c.kind), ['reference', 'anchor', 'placeholder', 'snippet', 'end']);
  check('placeholder args carried', kinds[2].args.length === 2 && kinds[2].args[0] === 'sentences');

  // A block-only command mid-text is skipped WHOLE — nothing inside its
  // brace groups is rescanned (the inner &reference must not be reported).
  eq('block token mid-text skipped whole', cmd.findInline('pre &title{&reference#in{n}} post'), []);
}

// ---- C14: structuralForm all kinds ------------------------------------
console.log('=== C14 structuralForm-all-kinds ===');
{
  const title = cmd.structuralForm('&title{The Wildfire}');
  check('title → h1 cmd-title, visible name', !!title && title.tag === 'h1'
    && title.cls === 'cmd-title' && title.visible === 'The Wildfire' && title.description === '');
  const part = cmd.structuralForm('&part#p1{I.}{The Gathering}');
  check('part → h2 + description', !!part && part.tag === 'h2'
    && part.cls === 'cmd-part' && part.visible === 'I.' && part.description === 'The Gathering');
  const chapter = cmd.structuralForm('&chapter#c1{1.}{Smoke}');
  check('chapter → h3', !!chapter && chapter.tag === 'h3' && chapter.cls === 'cmd-chapter'
    && chapter.visible === '1.' && chapter.description === 'Smoke');
  const anchor = cmd.structuralForm('&anchor#s{The salvia night}');
  check('anchor → div glyph, label not visible text', !!anchor && anchor.tag === 'div'
    && anchor.cls === 'cmd-anchor' && anchor.glyph === true && anchor.visible === ''
    && anchor.label === 'The salvia night');
  const snip = cmd.structuralForm('&snippet#s{lbl}');
  check('snippet → cmd-anchor cmd-snippet glyph', !!snip && snip.cls === 'cmd-anchor cmd-snippet' && snip.glyph === true);
  check('meta → null', cmd.structuralForm('&meta{font}{Georgia}') === null);
  check('placeholder → null', cmd.structuralForm('&placeholder#p{sentences}') === null);
  check('end → null', cmd.structuralForm('&end#z') === null);
  check('prose → null', cmd.structuralForm('Just prose.') === null);
  check('non-whole-block → null', cmd.structuralForm('&title{X} tail') === null);
}

// ---- N1: canonicalize null/empty --------------------------------------
console.log('=== N1 canonicalize-null-and-empty ===');
check("canonicalize(null) === ''", canonicalize(null) === '');
check("canonicalize(undefined) === ''", canonicalize(undefined) === '');
check("canonicalize('') === ''", canonicalize('') === '');

console.log('');
if (failed === 0) {
  console.log('✅ command.js units: all checks pass');
  process.exit(0);
} else {
  console.log(`❌ ${failed} check(s) failed`);
  process.exit(1);
}
