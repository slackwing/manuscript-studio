/**
 * Unit tests (no browser, no server) for suggestions.js's diff rendering:
 * renderDiffHTML + the word tokeniser shim, whitespace coalescing, leading-EQ
 * guard, overflow punt, renderStructuralMarkers, and pairItalicsAcrossInserts
 * (CODE_REVIEW_AUG_2026.md §3.4 rows S3–S9).
 *
 * suggestions.js is a browser script (file-scope functions, window/document
 * at load), so we execute it — plus the vendored diff-match-patch and
 * text-markers.js (escapeHTML) — with vm.runInThisContext under minimal
 * window/document shims. Function declarations land on the node global, the
 * same shape the browser gives them. No prod-file changes required.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Browser-global shims BEFORE loading the scripts.
global.window = global;
global.document = { addEventListener() {}, };

const load = (rel) => {
  const p = path.join(__dirname, '..', rel);
  vm.runInThisContext(fs.readFileSync(p, 'utf-8'), { filename: p });
};
load('web/js/vendor/diff-match-patch.js'); // defines diff_match_patch
load('web/js/text-markers.js');            // defines escapeHTML (shared escaper)
load('web/js/command.js');                 // WriteSysCommand — renderDiffHTML lifts &footnote{} via parse()
load('web/js/suggestions.js');             // renderDiffHTML + helpers (+ patches dmp)

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed++;
};
const dmp = () => new diff_match_patch();

// ---- S3: word-level diff basics ---------------------------------------
console.log('=== S3 diff-word-level-basic ===');
{
  check('tokeniser shim installed on the prototype',
    typeof diff_match_patch.prototype.diff_linesToWords_ === 'function');
  const a = dmp().diff_linesToWords_('the cat', 'the cat sat');
  check('tokeniser splits ws-runs and word-runs',
    a && a.lineArray.includes('the') && a.lineArray.includes(' ') && a.lineArray.includes('cat'));

  const ins = renderDiffHTML('the cat sat', 'the big cat sat', dmp());
  check('pure insert → one <strong>, no <del>',
    ins.includes('<strong>big </strong>') && !ins.includes('<del>'), ins);

  const rep = renderDiffHTML('the red cat', 'the blue cat', dmp());
  check('replace → <del>old</del><strong>new</strong>',
    rep === 'the <del>red</del><strong>blue</strong> cat', rep);

  const del = renderDiffHTML('the big cat', 'the cat', dmp());
  check('pure delete → <del> only', del.includes('<del>') && !del.includes('<strong>'), del);

  // Whitespace-run changes are visible too (ws-runs are tokens).
  const ws = renderDiffHTML('a b', 'a  b', dmp());
  check('whitespace-run change diffs', ws.includes('<del>') && ws.includes('<strong>'), JSON.stringify(ws));

  const esc = renderDiffHTML('safe', '<b>bold</b>', dmp());
  check('segments HTML-escaped', esc.includes('&lt;b&gt;') && !esc.includes('<b>'), esc);
}

// ---- S4: no-dmp fallback ----------------------------------------------
console.log('=== S4 diff-no-dmp-fallback ===');
{
  const out = renderDiffHTML('old text', 'new *it*', null);
  check('single <strong> wrap with italics applied',
    out === '<strong>new <em>it</em></strong>', out);
  const escaped = renderDiffHTML('x', 'a < b', null);
  check('fallback escapes HTML', escaped === '<strong>a &lt; b</strong>', escaped);
}

// ---- S5: whitespace-EQ coalescing -------------------------------------
console.log('=== S5 diff-ws-coalescing ===');
{
  // Token diff yields DEL big / INS small / EQ " " / DEL red / INS blue —
  // the barber-pole. The ws-EQ between the change clusters is absorbed into
  // the surrounding del+ins, and the cluster regroups dels-first.
  const out = renderDiffHTML('the big red dog ran', 'the small blue dog ran', dmp());
  check('DEL-EQ-DEL merged into one del block + one ins block',
    out === 'the <del>big red</del><strong>small blue</strong> dog ran', out);

  // Non-whitespace EQ between changes stays visible (never absorbed).
  const keep = renderDiffHTML('big dog barked', 'small dog howled', dmp());
  check('real preserved word stays outside the change blocks',
    keep === '<del>big</del><strong>small</strong> dog <del>barked</del><strong>howled</strong>', keep);

  // Three changed words / two absorbed gaps — the splice+rewind loop
  // terminates and folds the whole run into one del + one ins.
  const three = renderDiffHTML('one red big old dog', 'one blue small new dog', dmp());
  check('multi-gap cluster fully coalesced (splice+rewind terminates)',
    three === 'one <del>red big old</del><strong>blue small new</strong> dog', three);
}

// ---- S6: leading ws EQ not absorbed (phantom-§ regression) -------------
console.log('=== S6 diff-leading-ws-eq-not-absorbed ===');
{
  // A preserved \n\n at sentence start must NOT be pulled into the adjacent
  // change cluster — it would render as a phantom section-break glyph. As a
  // leading EQ marker it is dropped entirely (renderStructuralMarkers rule 1).
  const out = renderDiffHTML('\n\nBig dog', '\n\nSmall dog', dmp());
  check('no phantom marker glyph', !out.includes('suggested-marker') && !out.includes('§'), out);
  check('leading preserved marker dropped, diff intact',
    out === '<del>Big</del><strong>Small</strong> dog', out);

  // Trailing ws EQ likewise stays out of the change cluster.
  const trail = renderDiffHTML('word one\n\n', 'word two\n\n', dmp());
  check('trailing ws EQ not absorbed into the change', !trail.includes('two\n\n</strong>'), JSON.stringify(trail));
}

// ---- S7: token-overflow punt -------------------------------------------
console.log('=== S7 diff-token-overflow-punt ===');
{
  // >65535 distinct tokens → munge() punts (returns null) → char-level diff.
  const words = [];
  for (let i = 0; i < 65600; i++) words.push('w' + i);
  const big = words.join(' ');
  const oldText = big + ' cat';
  const newText = big + ' dog';
  check('tokeniser returns null past 65535 tokens',
    dmp().diff_linesToWords_(oldText, newText) === null);
  const out = renderDiffHTML(oldText, newText, dmp());
  check('falls back to char diff without crashing',
    out.includes('<del>') && out.includes('<strong>') && out.includes('at') === true, out.slice(-120));
  check('common prefix preserved un-marked', out.startsWith('w0 w1 '));
}

// ---- S8: renderStructuralMarkers 4 rules -------------------------------
console.log('=== S8 structural-markers-4-rules ===');
{
  // Rule 1: leading EQ marker dropped entirely.
  check('leading EQ \\n\\n dropped', renderStructuralMarkers('\n\nHello') === 'Hello');
  check('leading EQ \\n\\t dropped', renderStructuralMarkers('\n\tHello') === 'Hello');

  // Rule 2: leading INS/DEL marker → glyph, no <br>.
  const ins = renderStructuralMarkers('<strong>\n\nHello</strong>');
  check('leading INS marker → § glyph without <br>',
    ins === '<strong><span class="suggested-marker">§</span>Hello</strong>', ins);
  const del = renderStructuralMarkers('<del>\n\tHello</del>');
  check('leading DEL marker → ¶ glyph without <br>',
    del === '<del><span class="suggested-marker">¶</span>Hello</del>', del);

  // Rule 3: mid-content marker → glyph + <br> + indent.
  const mid = renderStructuralMarkers('Hello\n\nworld');
  check('mid-content § → glyph + blank line (double spacing), flush start',
    mid === 'Hello<span class="suggested-marker">§</span><br><br>world', mid);
  const midP = renderStructuralMarkers('Hello\n\tworld');
  check('mid-content ¶ same shape', midP.includes('suggested-marker">¶</span><br>'), midP);

  // Rule 4: inside <del>, mid-content marker → struck glyph only, no <br>.
  const inDel = renderStructuralMarkers('<del>Hello\n\nworld</del>');
  check('in-del mid marker: glyph only (no <br>)',
    inDel === '<del>Hello<span class="suggested-marker">§</span>world</del>', inDel);

  // Tag-state tracking survives adjacent tags; EQ text after content is mid.
  const mixed = renderStructuralMarkers('<del>gone</del> kept\n\ttail');
  check('marker after closing tag treated as EQ mid-content (has <br>)',
    mixed.includes('suggested-marker">¶</span><br>'), mixed);
  check('lone \\n untouched', renderStructuralMarkers('a\nb') === 'a\nb');
}

// ---- S9: italics pairing across inserts --------------------------------
console.log('=== S9 italics-pairing-across-inserts ===');
{
  // Markers inserted AROUND existing text (pair straddles two <strong>
  // blocks) stay VISIBLE — the italicization itself is the edit and the
  // user must see the green asterisks.
  const paired = pairItalicsAcrossInserts('<strong>*A</strong> tesselated <strong>away*</strong>');
  check('pair spans two <strong> blocks; added stars stay visible',
    paired === '<strong>*<em>A</strong> tesselated <strong>away</em>*</strong>', paired);

  // A pair inside ONE <strong> is wholly inserted prose — the green italics
  // carry it; the syntax chars hide, same as committed rendering.
  const delMix = pairItalicsAcrossInserts('<del>*x*</del><strong>*y*</strong>');
  check('in-del asterisks excluded from pairing; whole-insert pair hides stars',
    delMix === '<del>*x*</del><strong><em>y</em></strong>', delMix);

  const midPhrase = pairItalicsAcrossInserts('<strong>He went *quietly* away.</strong>');
  check('italic word inside an inserted phrase: no visible stars',
    midPhrase === '<strong>He went <em>quietly</em> away.</strong>', midPhrase);

  const odd = pairItalicsAcrossInserts('a * b');
  check('odd count: unpaired star untouched', odd === 'a * b', odd);

  const two = pairItalicsAcrossInserts('*one* and *two*');
  check('multiple pairs greedily 0+1, 2+3',
    two === '<em>one</em> and <em>two</em>', two);

  const three = pairItalicsAcrossInserts('*a* b *c');
  check('three stars: first pair matched, third left',
    three === '<em>a</em> b *c', three);
}


// ---- S9b: bold pairing across inserts (2026-09-11) ----------------------
console.log('=== S9b bold-pairing-across-inserts ===');
{
  const p = pairItalicsAcrossInserts('<strong>**A</strong> tesselated <strong>away**</strong>');
  check('bold pair spanning two inserts keeps the ** visible',
    p === '<strong>**<b>A</strong> tesselated <strong>away</b>**</strong>', p);
  const w = pairItalicsAcrossInserts('<strong>He went **quietly** away.</strong>');
  check('bold word inside an inserted phrase: no visible markers',
    w === '<strong>He went <b>quietly</b> away.</strong>', w);
  const n = pairItalicsAcrossInserts('*a **b** c*');
  check('bold nests inside italics', n === '<em>a <b>b</b> c</em>', n);
  const u = pairItalicsAcrossInserts('__x__ and _y_ and snake_case_name');
  check('__ bold, _ italics, intraword underscores untouched',
    u === '<b>x</b> and <em>y</em> and snake_case_name', u);
  const t = pairItalicsAcrossInserts('***x***');
  check('*** → bold italics', t === '<b><em>x</em></b>', t);
  const x = pairItalicsAcrossInserts('*a __b* c__');
  check('crossing pairs: earliest-open wins, the crosser is left literal',
    x === '<em>a __b</em> c__', x);
  const d = renderDiffHTML('the cat sat', 'the **cat** sat', dmp());
  // The markers are the edit: they stay visible green (md-marker inserts)
  // and the <b> straddles them — <b> opens inside the first insert, closes
  // inside the second, "cat" bold in between (browsers render that fine).
  check('diff: wrapping a word in ** → green ** markers with <b> straddling them',
    /md-marker">\*\*<b><\/strong>cat<strong class="md-marker"><\/b>\*\*<\/strong>/.test(d), d);
  const f = formatFallbackHTML('a **b** *c*');
  check('fallback path renders bold and italics', f === 'a <b>b</b> <em>c</em>', f);
}

// ---- S10-md: markdown-aware diffs (moved markers, underscores) ----------
console.log('=== S10-md markdown-aware diffs ===');
{
  const h = renderDiffHTML('*So it was*—the epidemic of silence.', '*So it was—the epidemic of silence.*', dmp());
  check('moved star: no whole word struck', !/<del[^>]*>[^<]*[a-zA-Z]{2}/.test(h), h);
  check('moved star: old marker is a subdued del', /<del class="md-marker">\*<\/del>/.test(h), h);
  check('moved star: whole new range italicized, new marker visible (green)',
    /<em>So it was<del class="md-marker">\*<\/del>—the epidemic of silence\.<strong class="md-marker"><\/em>\*<\/strong>/.test(h), h);
  const h2 = renderDiffHTML('the red cat', 'the blue cat', dmp());
  check('word change has no md-marker class', !/md-marker/.test(h2), h2);
  const h3 = renderDiffHTML('the *red* cat', 'the blue cat', dmp());
  check('word+marker change keeps full-weight diff', /<del>\*red\*<\/del>/.test(h3) && /<strong>blue<\/strong>/.test(h3), h3);
}
{
  const h = renderDiffHTML('plain words here.', '_plain words here._', dmp());
  check('underscore pair renders <em> with both added _ visible',
    /<em>/.test(h) && (h.replace(/<[^>]*>/g, '').match(/_/g) || []).length === 2, h);
  const h2 = renderDiffHTML('use snake_case here', 'use snake_case there', dmp());
  check('snake_case never italicizes', !/<em>/.test(h2), h2);
  const h3 = renderDiffHTML('a b c', '*a _b* c_', dmp());
  check('crossing pairs leave well-formed HTML',
    !/<[a-z]*</.test(h3) && (h3.match(/<em>/g) || []).length === (h3.match(/<\/em>/g) || []).length, h3);
}

// ---- S11: the two 2026-09-05 reports ------------------------------------
console.log('=== S11 emphasis-add-visible + split-not-wholesale ===');
{
  // (a) Wrapping an existing word in asterisks must SHOW two green stars
  //     (they render inside <strong>/md-marker context), plus the italics.
  const h = renderDiffHTML('some word here.', 'some *word* here.', dmp());
  const visibleStars = (h.replace(/<[^>]*>/g, '').match(/\*/g) || []).length;
  check('adding emphasis: both new asterisks visible', visibleStars === 2, h);
  check('adding emphasis: content italicized', /<em>word<\/em>|<em>/.test(h), h);
  check('adding emphasis: word itself not struck', !/<del[^>]*>[^<]*word/.test(h), h);

  // (b) Splitting one sentence into two (pure extension) must NOT wholesale:
  //     the surviving first sentence stays plain, only the addition is green.
  const oldT = 'The fire moved through the canyon.';
  const newT = 'The fire moved through the canyon. It did not stop for the houses or the orchards or the long-abandoned mill by the creek.';
  const h2 = renderDiffHTML(oldT, newT, dmp());
  check('split: old sentence not struck', !/<del/.test(h2), h2.slice(0, 120));
  check('split: old sentence not repeated in green', !new RegExp('<strong>[^<]*canyon').test(h2), h2.slice(0, 120));
  check('split: the addition is one green block', /<strong>[^<]*mill by the creek\./.test(h2), h2.slice(-120));

  // (c) An italicized word arriving INSIDE new prose shows no syntax —
  //     the whole *word* is inserted, so the italics alone carry it (the
  //     visible-stars rule is only for emphasis added to EXISTING text).
  const h3 = renderDiffHTML('He left.', 'He left. He went *quietly* away.', dmp());
  const stars3 = (h3.replace(/<[^>]*>/g, '').match(/\*/g) || []).length;
  check('insert with italics: no visible asterisks', stars3 === 0, h3);
  check('insert with italics: word italicized in green', /<em>quietly<\/em>/.test(h3), h3);
}

console.log('');
// ---- S9: footnotes in diffs (FOOTNOTES_PLAN.md §6) ----------------------
// A &footnote{…} is lifted to a placeholder token, the prose diffs around
// it, and the notes diff separately inside their .fn-body spans.
console.log('=== S9 footnotes-in-diffs ===');
{
  const same = renderDiffHTML('He left.&footnote{A note.} She stayed.', 'He left.&footnote{A note.} She stayed.', dmp());
  check('unchanged note → plain body, no diff marks, no literal token',
    same.includes('<span class="fn-body">A note.</span>') && !same.includes('<del>') && !same.includes('<strong>') && !same.includes('&footnote'), same);
  const inner = renderDiffHTML('He left.&footnote{A red note.} She stayed.', 'He left.&footnote{A blue note.} She stayed.', dmp());
  check('changed words INSIDE the note diff inside the body',
    /<span class="fn-body">A <del>red<\/del><strong>blue<\/strong> note\.<\/span>/.test(inner) && !inner.includes('&footnote'), inner);
  const both = renderDiffHTML('He left.&footnote{A note.} She stayed.', 'He went.&footnote{A remark.} She stayed.', dmp());
  check('prose and note diff independently',
    both.includes('<del>left.</del><strong>went.</strong>') && /fn-body">A <del>note\.<\/del><strong>remark\.<\/strong><\/span>/.test(both), both);
  const added = renderDiffHTML('He left. She stayed.', 'He left.&footnote{New.} She stayed.', dmp());
  check('note added → green fn-added body PLUS an added-command icon carrying the note; host word not struck',
    added.includes('<span class="fn-body fn-added"><strong>New.</strong></span><span class="cmd-diamond cmd-diamond-added fn-diamond" title="&#38;footnote{New.}">')
    && !added.includes('<del>'), added);
  const removed = renderDiffHTML('He left.&footnote{Old.} She stayed.', 'He left. She stayed.', dmp());
  check('note removed → red-struck fn-removed body PLUS a removed-command icon; nothing turns green',
    removed.includes('<span class="fn-body fn-removed"><del>Old.</del></span><span class="cmd-diamond cmd-diamond-removed fn-diamond" title="&#38;footnote{Old.}">')
    && !removed.includes('<strong>'), removed);
  const two = renderDiffHTML('A.&footnote{One.} B.&footnote{Two.}', 'A.&footnote{One.} B.&footnote{Three.}', dmp());
  check('two notes pair by order — only the second diffs',
    two.includes('<span class="fn-body">One.</span>') && /fn-body"><del>Two\.<\/del><strong>Three\.<\/strong><\/span>/.test(two), two);
  const tok = dmp().diff_linesToWords_('x. y', 'x. y');
  check('a lifted note is its own diff token (never glued to the host word)', tok.lineArray.includes('x.') && tok.lineArray.includes(''), JSON.stringify(tok.lineArray));
}

if (failed === 0) {
  console.log('✅ suggestions.js diff units: all checks pass');
  process.exit(0);
} else {
  console.log(`❌ ${failed} check(s) failed`);
  process.exit(1);
}
