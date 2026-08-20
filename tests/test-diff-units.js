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
  check('mid-content § → glyph + <br> + pindent',
    mid === 'Hello<span class="suggested-marker">§</span><br><span class="suggested-pindent">    </span>world', mid);
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
  const paired = pairItalicsAcrossInserts('<strong>*A</strong> tesselated <strong>away*</strong>');
  check('pair spans two <strong> blocks',
    paired === '<strong><em>A</strong> tesselated <strong>away</em></strong>', paired);

  const delMix = pairItalicsAcrossInserts('<del>*x*</del><strong>*y*</strong>');
  check('in-del asterisks excluded from pairing',
    delMix === '<del>*x*</del><strong><em>y</em></strong>', delMix);

  const odd = pairItalicsAcrossInserts('a * b');
  check('odd count: unpaired star untouched', odd === 'a * b', odd);

  const two = pairItalicsAcrossInserts('*one* and *two*');
  check('multiple pairs greedily 0+1, 2+3',
    two === '<em>one</em> and <em>two</em>', two);

  const three = pairItalicsAcrossInserts('*a* b *c');
  check('three stars: first pair matched, third left',
    three === '<em>a</em> b *c', three);
}


// ---- S10-md: markdown-aware diffs (moved markers, underscores) ----------
console.log('=== S10-md markdown-aware diffs ===');
{
  const h = renderDiffHTML('*So it was*—the epidemic of silence.', '*So it was—the epidemic of silence.*', dmp());
  check('moved star: no whole word struck', !/<del[^>]*>[^<]*[a-zA-Z]{2}/.test(h), h);
  check('moved star: old marker is a subdued del', /<del class="md-marker">\*<\/del>/.test(h), h);
  check('moved star: whole new range italicized, no husk',
    /<em>So it was<del class="md-marker">\*<\/del>—the epidemic of silence\.<\/em>/.test(h), h);
  const h2 = renderDiffHTML('the red cat', 'the blue cat', dmp());
  check('word change has no md-marker class', !/md-marker/.test(h2), h2);
  const h3 = renderDiffHTML('the *red* cat', 'the blue cat', dmp());
  check('word+marker change keeps full-weight diff', /<del>\*red\*<\/del>/.test(h3) && /<strong>blue<\/strong>/.test(h3), h3);
}
{
  const h = renderDiffHTML('plain words here.', '_plain words here._', dmp());
  check('underscore pair renders <em>', /<em>/.test(h) && !/md-marker">\s*<\//.test(h), h);
  const h2 = renderDiffHTML('use snake_case here', 'use snake_case there', dmp());
  check('snake_case never italicizes', !/<em>/.test(h2), h2);
  const h3 = renderDiffHTML('a b c', '*a _b* c_', dmp());
  check('crossing pairs leave well-formed HTML',
    !/<[a-z]*</.test(h3) && (h3.match(/<em>/g) || []).length === (h3.match(/<\/em>/g) || []).length, h3);
}

console.log('');
if (failed === 0) {
  console.log('✅ suggestions.js diff units: all checks pass');
  process.exit(0);
} else {
  console.log(`❌ ${failed} check(s) failed`);
  process.exit(1);
}
