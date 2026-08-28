/**
 * Render + suggestion pipeline units evaluated on the REAL book page
 * (CODE_REVIEW_AUG_2026.md §3.4 rows R1–R16, R19, R22, S1, S12, P4, D7).
 *
 * Pattern: like test-anchor-inline.js — load the app, then drive
 * renderSentencesToHTML / renderInlineCommand / etc. via page.evaluate on
 * SYNTHETIC sentences, temporarily swapping WriteSysSuggestions.bySentenceId
 * and restoring it. READ-ONLY against the fixture: no suggestion PUTs reach
 * the server (S12 stubs authenticatedFetch; everything else is local render).
 */
const { chromium } = require('playwright');
const path = require('path');
const { TEST_URL, loginAsTestUser, waitForPagination } = require('./test-utils');
const { suggestEditor } = require('./test-utils');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  let failed = false;
  const check = (name, ok, extra) => {
    console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
    if (!ok) failed = true;
  };

  await loginAsTestUser(page);
  await page.goto(TEST_URL);
  await waitForPagination(page);

  // Render synthetic sentences through the real pipeline with a temporary
  // suggestion map; the live map is restored before returning.
  const render = (sentences, sug = {}) => page.evaluate(({ sentences, sug }) => {
    const R = window.WriteSysRenderer;
    const S = window.WriteSysSuggestions;
    const prev = S.bySentenceId;
    const prevRender = S.renderBySentenceId;
    S.bySentenceId = sug;
    S.renderBySentenceId = sug; // v3 render map
    let html;
    try { html = R.renderSentencesToHTML(sentences); }
    finally { S.bySentenceId = prev; S.renderBySentenceId = prevRender; }
    return html;
  }, { sentences, sug });

  // ---- R1: paragraph grouping ------------------------------------------
  {
    const html = await render([
      { id: 'r1a', text: 'One.' }, { id: 'r1b', text: 'Two.' },
      { id: 'r1c', text: '\n\tThree.' }, { id: 'r1d', text: '\n\nFour.' },
    ]);
    const paras = html.split('\n');
    check('R1: no-marker sentences join one <p> (space-joined)',
      paras[0] === '<p><span class="sentence" data-sentence-id="r1a">One.</span> <span class="sentence" data-sentence-id="r1b">Two.</span></p>', paras[0]);
    check('R1: \\n\\t opens an indented paragraph, marker stripped from text',
      paras[1] === '<p class="indented"><span class="sentence" data-sentence-id="r1c">Three.</span></p>', paras[1]);
    check('R1: \\n\\n opens a section-break paragraph',
      paras[2] === '<p class="section-break"><span class="sentence" data-sentence-id="r1d">Four.</span></p>', paras[2]);
  }

  // ---- R2: delete proposal renders committed text struck ----------------
  {
    const html = await render([{ id: 'r2', text: 'Keep me.' }], { r2: '' });
    check('R2: empty suggestion → suggested-delete class',
      /class="sentence has-suggestion suggested-delete"/.test(html), html);
    check('R2: committed text still visible (not blank)', html.includes('Keep me.'), html);
  }

  // ---- R3: lone-prose diffs; multi-fragment doesn't ---------------------
  {
    const lone = await render([{ id: 'r3a', text: 'The red cat.' }], { r3a: 'The blue cat.' });
    check('R3: single-prose suggestion word-diffs',
      lone.includes('<del>red</del>') && lone.includes('<strong>blue</strong>'), lone);
    const multi = await render([{ id: 'r3b', text: 'Base.' }], { r3b: 'One.\n\nTwo.' });
    // 2026-08-24: an all-prose multi-paragraph rewrite collapses to ONE
    // whole-text diff (¶/§ preview inline) — the placed-region case.
    check('R3: multi-paragraph prose suggestion DOES word-diff now',
      multi.includes('<del>Base.</del>') && multi.includes('<strong>')
      && multi.includes('suggested-marker'), multi);
    check('R3: collapsed to a single has-suggestion span',
      (multi.match(/has-suggestion/g) || []).length === 1, multi);
    const cmdSug = await render([{ id: 'r3c', text: 'Base.' }], { r3c: '&title{X}' });
    check('R3: command-from-suggestion marked blue (cmd-suggested), no diff',
      cmdSug.includes('cmd-title cmd-suggested') && !cmdSug.includes('<del'), cmdSug);
    // A structural command riding along with ONE prose fragment no longer
    // suppresses the prose's word diff (2026-08-17 enhancement): the command
    // renders blue as before, the prose keeps green/red words.
    const anchored = await render(
      [{ id: 'r3d', text: 'One night five of us met.' }],
      { r3d: '&anchor{camp}\nOne night five of us gathered.' });
    check('R3: anchor+prose suggestion still word-diffs the prose',
      anchored.includes('<del>met.') && anchored.includes('<strong>gathered.'), anchored);
    check('R3: the riding anchor is marked suggested', /cmd-suggested/.test(anchored), anchored);
    // Two prose fragments (added paragraph break) still take the no-diff
    // path — there is no single sound baseline to diff each against.
    const twoProse = await render([{ id: 'r3e', text: 'Base.' }], { r3e: '&anchor{x}\nOne.\n\nTwo.' });
    check('R3: command + TWO prose fragments still does not diff',
      !twoProse.includes('<del'), twoProse);
  }

  // ---- R4: marker glyph diff (4 branches + integrated) ------------------
  {
    const g = await page.evaluate(() => {
      const R = window.WriteSysRenderer;
      return {
        added: R.markerGlyphDiff('', '\n\n'),
        removed: R.markerGlyphDiff('\n\n', ''),
        changed: R.markerGlyphDiff('\n\n', '\n\t'),
        same: R.markerGlyphDiff('\n\t', '\n\t'),
      };
    });
    check('R4: break added → green §', g.added === '<span class="marker-added">§</span>', g.added);
    check('R4: break removed → struck §', g.removed === '<span class="marker-removed">§</span>', g.removed);
    check('R4: type change → struck old + green new',
      g.changed === '<span class="marker-removed">§</span><span class="marker-added">¶</span>', g.changed);
    check('R4: unchanged → empty', g.same === '');
    const integ = await render([{ id: 'r4', text: 'Hello.' }], { r4: '\n\tHello.' });
    check('R4: integrated — added ¶ glyph rides the diffed span',
      integ.includes('marker-added">¶</span>') && /<p class="indented"/.test(integ), integ);
  }

  // ---- R5: meta fragment hidden vs suggested ----------------------------
  {
    const quiet = await render([{ id: 'r5a', text: '&meta{chapter-align}{left}' }]);
    check('R5: unchanged &meta renders hidden', /<div class="cmd-meta" hidden>/.test(quiet), quiet);
    const loud = await render([{ id: 'r5b', text: '&meta{chapter-align}{left}' }],
      { r5b: '&meta{chapter-align}{center}' });
    check('R5: suggested &meta renders visible ⚙ marked cmd-suggested',
      loud.includes('cmd-meta cmd-suggested') && loud.includes('⚙') && !loud.includes('hidden'), loud);
  }

  // ---- R6: &end renders nothing in all three paths ----------------------
  {
    const blockPath = await render([{ id: 'r6a', text: '&end#reg' }]);
    check('R6: block &end sentence renders nothing at all', blockPath === '', JSON.stringify(blockPath));
    const fragPath = await page.evaluate(() =>
      window.WriteSysRenderer.renderBlockCommandFrag({ kind: 'end', slug: 'x', args: [], raw: '&end#x' }, 'id1', false, ''));
    check('R6: renderBlockCommandFrag(end) → hidden cmd-end div',
      fragPath === '<div class="cmd-end" data-slug="x" hidden><span class="sentence" data-sentence-id="id1"></span></div>', fragPath);
    const inlinePath = await page.evaluate(() =>
      window.WriteSysRenderer.renderInlineCommand({ kind: 'end', slug: 'x', notes: '', args: [], raw: '&end#x' }));
    check('R6: renderInlineCommand(end) → invisible inline-end span',
      inlinePath === '<span class="inline-end" data-slug="x" aria-hidden="true"></span>', inlinePath);
    const mid = await render([{ id: 'r6b', text: 'before &end#x after' }]);
    check('R6: mid-text &end invisible but present as inline-end',
      mid.includes('inline-end') && mid.includes('before') && mid.includes('after') && !mid.includes('&amp;end'), mid);
  }

  // ---- R7: placeholder block branches -----------------------------------
  {
    const invalid = await render([{ id: 'r7a', text: '&placeholder#p{bogus}' }]);
    check('R7: mis-syntaxed placeholder prints as literal prose',
      invalid.includes('&amp;placeholder#p{bogus}'), invalid);
    const paras = await render([{ id: 'r7b', text: '&placeholder#pp{paragraphs}{s}' }]);
    check('R7: paragraphs unit → blockHTML region',
      paras.includes('cmd-placeholder') && (paras.match(/<p/g) || []).length >= 2, paras.slice(0, 120));
    const line = await render([{ id: 'r7c', text: '&placeholder#ps{sentences}' }]);
    check('R7: sentences unit alone → one-run ph-line paragraph',
      /<p class="ph-line"/.test(line) && line.includes('class="ph"'), line.slice(0, 120));
  }

  // ---- R8: carried marker strength --------------------------------------
  {
    const indent = await render([{ id: 'r8a', text: 'x' }], { r8a: '\n\n&snippet#ab{}\n\tPara' });
    check('R8: explicit \\n\\t indent beats carried \\n\\n section',
      /<p class="indented has-anchor-margin"/.test(indent) && !indent.includes('section-break'), indent);
    const carry = await render([
      { id: 'r8b', text: 'First.' }, { id: 'r8c', text: '\n\n&anchor#z{lbl}' }, { id: 'r8d', text: 'Prose.' },
    ]);
    check('R8: carried section marker sections the NEXT sentence (cross-sentence)',
      /<p class="section-break has-anchor-margin"/.test(carry), carry);
  }

  // ---- R9: margin-glyph attachment, 3 ways ------------------------------
  {
    // (a) glyphs open the NEXT paragraph (indent case covered in R8a): glyph
    // markup precedes the sentence span inside the same <p>.
    const a = await render([{ id: 'r9a', text: 'x' }], { r9a: '\n\t&anchor{L} Prose.' });
    check('R9a: glyph precedes the prose span at paragraph start',
      /has-anchor-margin"><span class="sentence cmd-anchor-glyph cmd-anchor-margin[^>]*>.*<span class="sentence has-suggestion"/.test(a), a);
    // (b) mid-flow: anchor between two same-paragraph sentences joins the
    // OPEN paragraph — never forces a break.
    const b = await render([
      { id: 'r9b1', text: 'First.' }, { id: 'r9b2', text: '&anchor#m{lbl}' }, { id: 'r9b3', text: 'Continues.' },
    ]);
    check('R9b: mid-flow glyph joins the open paragraph (exactly one <p>)',
      (b.match(/<p/g) || []).length === 1 && b.includes('data-slug="m"')
      && b.includes('has-anchor-margin') && b.indexOf('data-slug="m"') < b.indexOf('Continues.'), b);
    // (c) promoted glyph in the same piece that attaches mid-flow is
    // RE-QUEUED for the following paragraph (the :583 duplicated line).
    const c = await render([
      { id: 'r9c1', text: 'First.' }, { id: 'r9c2', text: '&anchor#g1{}' },
      { id: 'r9c3', text: 'tail prose.\n&anchor#g2{}' }, { id: 'r9c4', text: '\n\tNext para.' },
    ]);
    const paras = c.split('\n');
    check('R9c: pending glyph lands mid-flow, promoted glyph re-queued to next <p>',
      paras.length === 2 && paras[0].includes('data-slug="g1"') && !paras[0].includes('data-slug="g2"')
      && paras[1].includes('data-slug="g2"') && paras[1].includes('indented'), c);
  }

  // ---- R10: trailing-glyph promotion ------------------------------------
  {
    const multi = await render([
      { id: 'r10a', text: 'prose.\n&anchor#x1{}\n&anchor#x2{}' }, { id: 'r10b', text: '\n\tNext.' },
    ]);
    const p2 = multi.split('\n')[1] || '';
    check('R10: BOTH trailing anchors promote to the next paragraph',
      p2.includes('data-slug="x1"') && p2.includes('data-slug="x2"'), multi);
    check('R10: previous paragraph keeps no dangling glyph',
      !multi.split('\n')[0].includes('cmd-anchor-glyph'), multi);
    const endGone = await render([{ id: 'r10c', text: 'prose.\n&end#r' }]);
    check('R10: trailing &end just vanishes',
      endGone.includes('prose.') && !endGone.includes('end') && !endGone.includes('inline-end'), endGone);
    const refStays = await render([{ id: 'r10d', text: 'prose &reference#nowhere{see}' }]);
    check('R10: trailing &reference stays in the flow (never promoted)',
      refStays.includes('inline-ref broken') && refStays.includes('see'), refStays);
    const midText = await render([{ id: 'r10e', text: 'a &anchor#mid{} b' }]);
    check('R10: genuinely mid-text anchor rides IN the prose (inline glyph)',
      midText.includes('cmd-anchor-inline') && !midText.includes('cmd-anchor-margin-inline')
      && / b<\/span>/.test(midText), midText);
  }

  // ---- R11: orphan-glyph fallbacks --------------------------------------
  {
    const intoLast = await render([{ id: 'r11a', text: 'Prose.' }, { id: 'r11b', text: '&anchor#tail{lbl}' }]);
    check('R11: anchor after last prose unshifts into the last <p>',
      /<p class="has-anchor-margin"><span class="sentence cmd-anchor-glyph[^>]*data-slug="tail"/.test(intoLast), intoLast);
    const standalone = await render([{ id: 'r11c', text: '&anchor#only{lbl}' }]);
    check('R11: no prose anywhere → quiet standalone cmd-anchor line, non-margin',
      /<div class="cmd-anchor">/.test(standalone) && !standalone.includes('cmd-anchor-margin'), standalone);
  }

  // ---- R12: applyInlineFormatting segmentation --------------------------
  {
    const out = await page.evaluate(() => {
      const R = window.WriteSysRenderer;
      return {
        em: R.applyInlineFormatting('a *b* c'),
        esc: R.applyInlineFormatting('5 < 6 & "q"'),
        astral: R.applyInlineFormatting('\u{1D49C} *i* &reference#tgt-none{n} tail'),
        anchor: R.applyInlineFormatting('a &anchor#s{} b'),
      };
    });
    check('R12: *x* → <em>', out.em === 'a <em>b</em> c', out.em);
    check('R12: escapes entities', out.esc === '5 &lt; 6 &amp; &quot;q&quot;', out.esc);
    check('R12: multibyte offsets — text before/after command intact',
      out.astral.startsWith('\u{1D49C} <em>i</em> ') && out.astral.endsWith(' tail')
      && out.astral.includes('inline-ref broken'), out.astral);
    check('R12: inline anchor renders target + in-prose glyph',
      out.anchor.includes('inline-anchor') && out.anchor.includes('cmd-anchor-inline'), out.anchor);
  }

  // ---- R13: renderInlineCommand all kinds -------------------------------
  {
    const out = await page.evaluate(() => {
      const R = window.WriteSysRenderer;
      window.WriteSysOutline = window.WriteSysOutline || {};
      const prevMap = window.WriteSysOutline.slugMap;
      window.WriteSysOutline.slugMap = { tgt: 'sent-9' };
      const r = {
        phValid: R.renderInlineCommand({ kind: 'placeholder', slug: 'p', notes: '', args: ['sentences', 's'], raw: '&placeholder#p{sentences}{s}' }),
        phInvalid: R.renderInlineCommand({ kind: 'placeholder', slug: 'p', notes: '', args: ['paragraphs'], raw: '&placeholder#p{paragraphs}' }),
        anchor: R.renderInlineCommand({ kind: 'anchor', slug: 's', notes: '', args: [], raw: '&anchor#s{}' }),
        snippet: R.renderInlineCommand({ kind: 'snippet', slug: 's', notes: '', args: [], raw: '&snippet#s{}' }),
        refOk: R.renderInlineCommand({ kind: 'reference', slug: 'tgt', notes: 'see here', args: ['see here'], raw: '&reference#tgt{see here}' }),
        refBroken: R.renderInlineCommand({ kind: 'reference', slug: 'nope', notes: '', args: [], raw: '&reference#nope{}' }),
      };
      window.WriteSysOutline.slugMap = prevMap;
      return r;
    });
    check('R13: valid sentences-placeholder → ph run', out.phValid.includes('class="ph"'), out.phValid.slice(0, 80));
    check('R13: paragraphs-form riding inline → literal prose',
      out.phInvalid === '&amp;placeholder#p{paragraphs}', out.phInvalid);
    check('R13: inline anchor → ⚓ aria-label anchor',
      out.anchor.includes('⚓') && out.anchor.includes('aria-label="anchor"') && out.anchor.includes('inline-anchor'), out.anchor);
    check('R13: inline snippet → sketch glyph', out.snippet.includes('cmd-sketch-glyph') && out.snippet.includes('aria-label="sketch"'), out.snippet);
    check('R13: resolvable reference → link with target',
      out.refOk === '<a class="inline-ref" data-ref-target="sent-9" title="tgt">see here</a>', out.refOk);
    check('R13: dangling reference → broken marker with ↪ slug fallback',
      out.refBroken.includes('inline-ref broken') && out.refBroken.includes('↪ nope'), out.refBroken);
  }

  // ---- R14: renderInlineCommandsInHtml regex over escaped diff HTML -----
  {
    const out = await page.evaluate(() => {
      const R = window.WriteSysRenderer;
      window.WriteSysOutline = window.WriteSysOutline || {};
      const prevMap = window.WriteSysOutline.slugMap;
      window.WriteSysOutline.slugMap = { tgt: 'sent-9' };
      const r = {
        ref: R.renderInlineCommandsInHtml('foo &amp;reference#tgt{see} bar'),
        sketch: R.renderInlineCommandsInHtml('x &amp;sketch#ab{lbl} y'),
        straddle: R.renderInlineCommandsInHtml('x &amp;refer<del>ence#a{n}</del>'),
        end: R.renderInlineCommandsInHtml('x &amp;end#zz y'),
        ph: R.renderInlineCommandsInHtml('&amp;placeholder#p{sentences}{s}'),
      };
      window.WriteSysOutline.slugMap = prevMap;
      return r;
    });
    check('R14: escaped reference token → link',
      out.ref.includes('<a class="inline-ref" data-ref-target="sent-9"') && out.ref.startsWith('foo '), out.ref);
    check('R14: sketch alias → snippet kind (sketch glyph)', out.sketch.includes('cmd-sketch-glyph'), out.sketch);
    check('R14: token straddling a <del> boundary left as text',
      out.straddle === 'x &amp;refer<del>ence#a{n}</del>', out.straddle);
    check('R14: escaped &end#slug form → inline-end', out.end.includes('inline-end') && out.end.includes('data-slug="zz"'), out.end);
    check('R14: escaped placeholder → ph run', out.ph.includes('class="ph"'), out.ph.slice(0, 80));
  }

  // ---- R15: applyEffectiveSettings overlay ------------------------------
  {
    const out = await page.evaluate(() => {
      const R = window.WriteSysRenderer;
      const S = window.WriteSysSuggestions;
      const prevSent = R.currentSentences;
      const prevSug = S.bySentenceId;
      const read = () => ({
        chapter: document.body.getAttribute('data-chapter-align'),
        font: document.documentElement.style.getPropertyValue('--book-font') || null,
      });
      const r = {};
      try {
        R.currentSentences = [{ id: 'm1', text: '&meta{chapter-align}{left}' },
                              { id: 'm2', text: '&meta{font}{Baskerville}' }];
        S.bySentenceId = {};
        S.renderBySentenceId = {}; // v3: settings overlay reads the render map
        R.applyEffectiveSettings();
        r.committed = read();
        S.bySentenceId = { m1: '&meta{chapter-align}{center}' };
        S.renderBySentenceId = { m1: '&meta{chapter-align}{center}' };
        R.applyEffectiveSettings();
        r.suggested = read();
        S.bySentenceId = { m1: '', m2: '' }; // suggested removal of both metas
        S.renderBySentenceId = { m1: '', m2: '' };
        R.applyEffectiveSettings();
        r.removed = read();
      } finally {
        R.currentSentences = prevSent;
        S.bySentenceId = prevSug;
        S.renderBySentenceId = prevSug || {};
        R.applyEffectiveSettings(); // restore the real fixture settings
      }
      return r;
    });
    check('R15: committed &meta lands on body/documentElement',
      out.committed.chapter === 'left' && out.committed.font === 'Baskerville', JSON.stringify(out.committed));
    check('R15: suggested &meta wins over committed', out.suggested.chapter === 'center', JSON.stringify(out.suggested));
    check('R15: suggested removal drops attr and custom property',
      out.removed.chapter === null && out.removed.font === null, JSON.stringify(out.removed));
  }

  // ---- S1: loadForMigration map + failure -------------------------------
  {
    const out = await page.evaluate(async () => {
      const S = window.WriteSysSuggestions;
      const prevFetch = window.fetchJSON;
      const prevMap = S.bySentenceId;
      const r = {};
      try {
        S.bySentenceId = { pre: 'x' };
        await S.loadForMigration(null);
        r.nullIdKeepsMap = JSON.stringify(S.bySentenceId);
        window.fetchJSON = async () => ({ viewer: 'unit', suggestions: [
          { sentence_id: 's1', user_id: 'unit', text: 't1' },
          { sentence_id: 's2', user_id: 'unit', text: '' }] });
        await S.loadForMigration(42);
        r.map = JSON.stringify(S.bySentenceId);
        window.fetchJSON = async () => { throw new Error('boom'); };
        await S.loadForMigration(42);
        r.afterFailure = JSON.stringify(S.bySentenceId);
        window.fetchJSON = async () => ({}); // no suggestions field
        await S.loadForMigration(42);
        r.noField = JSON.stringify(S.bySentenceId);
      } finally {
        window.fetchJSON = prevFetch;
        S.rows = [];
        S.rebuildMaps();
        S.bySentenceId = prevMap;
      }
      return r;
    });
    check('S1: falsy migration id leaves the map untouched', out.nullIdKeepsMap === '{"pre":"x"}', out.nullIdKeepsMap);
    check('S1: response keyed into sentence_id → text map (empty text kept)',
      out.map === '{"s1":"t1","s2":""}', out.map);
    check('S1: endpoint failure → empty map, non-fatal', out.afterFailure === '{}', out.afterFailure);
    check('S1: missing suggestions field → empty map', out.noField === '{}', out.noField);
  }

  // ---- S2: winner selection — rejected never renders; accepted wins ------
  {
    const out = await page.evaluate(() => {
      const S = window.WriteSysSuggestions;
      const prev = { rows: S.rows, viewer: S.viewer, rank: S.peopleRank };
      const r = {};
      try {
        S.viewer = 'me';
        S.peopleRank = { alice: 0, me: 1, zed: 2 };
        // Own rejected suggestion: nothing renders (no owner exception).
        S.rows = [{ sentence_id: 'w1', user_id: 'me', text: 'M', review_status: 'rejected', stale: false }];
        S.rebuildMaps();
        r.ownRejectedHidden = !('w1' in S.renderRowBySentence);
        // A rejected suggestion loses to ANY live one, rank regardless.
        S.rows = [
          { sentence_id: 'w1', user_id: 'alice', text: 'A', review_status: 'rejected', stale: false },
          { sentence_id: 'w1', user_id: 'zed', text: 'Z', review_status: null, stale: false },
        ];
        S.rebuildMaps();
        r.rejectedLoses = S.renderRowBySentence.w1 && S.renderRowBySentence.w1.user_id === 'zed';
        // Accepted beats a better People rank.
        S.rows = [
          { sentence_id: 'w1', user_id: 'alice', text: 'A', review_status: null, stale: false },
          { sentence_id: 'w1', user_id: 'zed', text: 'Z', review_status: 'accepted', stale: false },
        ];
        S.rebuildMaps();
        r.acceptedWins = S.renderRowBySentence.w1 && S.renderRowBySentence.w1.user_id === 'zed';
        // No verdicts: People order picks.
        S.rows = [
          { sentence_id: 'w1', user_id: 'zed', text: 'Z', review_status: null, stale: false },
          { sentence_id: 'w1', user_id: 'alice', text: 'A', review_status: null, stale: false },
        ];
        S.rebuildMaps();
        r.rankPicks = S.renderRowBySentence.w1 && S.renderRowBySentence.w1.user_id === 'alice';
        // suggestedOrder: a rejected-only sentence leaves the nav space.
        S.rows = [{ sentence_id: 'w1', user_id: 'me', text: 'M', review_status: 'rejected', stale: false }];
        S.rebuildMaps();
        const R = window.WriteSysRenderer;
        const hadW1 = R.currentSentences.some(x => x.id === 'w1');
        r.orderSkipsRejected = hadW1 || !S.suggestedOrder().includes('w1');
      } finally {
        S.rows = prev.rows; S.viewer = prev.viewer; S.peopleRank = prev.rank;
        S.rebuildMaps();
      }
      return r;
    });
    check('S2: own rejected suggestion never renders', out.ownRejectedHidden);
    check('S2: rejected loses to any live suggestion', out.rejectedLoses);
    check('S2: accepted wins over People rank', out.acceptedWins);
    check('S2: no verdicts → People order picks', out.rankPicks);
    check('S2: rejected-only sentence leaves the nav space', out.orderSkipsRejected);
  }

  // ---- S3: review button — ✓✗ pair, SENTENCE-level reviewed/total;
  // acceptedCount counts only PUSHABLE acceptances (fully-reviewed
  // sentences), mirroring the server's push gate. ------------------------
  {
    const out = await page.evaluate(() => {
      const S = window.WriteSysSuggestions;
      const P = window.WriteSysPush;
      const prev = { rows: S.rows, canReview: S.canReview, viewer: S.viewer };
      const r = {};
      try {
        S.viewer = S.viewer || 'unit';
        S.canReview = true;
        S.rows = [
          // w1: fully reviewed (accepted mine + rejected other) → pushable
          { sentence_id: 'w1', user_id: S.viewer, text: 'a', review_status: 'accepted', stale: false },
          { sentence_id: 'w1', user_id: 'someone-else', text: 'b', review_status: 'rejected', stale: false },
          // w2: accepted BUT an unreviewed sibling → pending, not pushable
          { sentence_id: 'w2', user_id: S.viewer, text: 'c', review_status: 'accepted', stale: false },
          { sentence_id: 'w2', user_id: 'someone-else', text: 'd', review_status: null, stale: false },
          // w3: sole pending
          { sentence_id: 'w3', user_id: S.viewer, text: 'e', review_status: null, stale: false },
        ];
        S.rebuildMaps();
        r.sentences = S.reviewedSentences();
        r.accOwn = S.acceptedCount('own');
        r.accAll = S.acceptedCount('all');
        P.refresh();
        const btn = document.getElementById('accept-btn');
        r.count = btn && btn.querySelector('.mc-count') ? btn.querySelector('.mc-count').textContent : null;
        r.greens = btn ? btn.querySelectorAll('path[stroke="#2e7d32"]').length : -1;
        r.reds = btn ? btn.querySelectorAll('path[stroke="#b03030"]').length : -1;
      } finally {
        S.rows = prev.rows; S.canReview = prev.canReview; S.viewer = prev.viewer;
        S.rebuildMaps();
        P.refresh();
      }
      return r;
    });
    check('S3: reviewedSentences counts fully-reviewed sentences only',
      out.sentences.reviewed === 1 && out.sentences.total === 3, JSON.stringify(out.sentences));
    check('S3: acceptedCount skips sentences with pending siblings',
      out.accOwn === 1 && out.accAll === 1, `own=${out.accOwn} all=${out.accAll}`);
    check('S3: button counter reads reviewedSentences/total', out.count === '1/3', String(out.count));
    check('S3: icon is ONE green check + ONE red x', out.greens === 1 && out.reds === 1, JSON.stringify(out));
  }

  // ---- R16: patchSentenceInPlace guards ---------------------------------
  // Uses a REAL rendered sentence; suggestions are set only in the local map
  // (never PUT) and removed again, with a final restoring patch.
  {
    const simple = await page.evaluate(() => {
      const R = window.WriteSysRenderer;
      for (const s of R.currentSentences || []) {
        if (s.text.includes('&') || s.text.includes('*') || /['"]/.test(s.text)) continue;
        const spans = document.querySelectorAll(
          `.pagedjs_pages .sentence[data-sentence-id="${CSS.escape(s.id)}"]`);
        if (spans.length === 1 && spans[0].closest('p')) return { id: s.id, text: s.text };
      }
      return null;
    });
    check('R16: found a simple single-span fixture sentence', !!simple);
    if (simple) {
      const out = await page.evaluate(({ id }) => {
        const R = window.WriteSysRenderer;
        const S = window.WriteSysSuggestions;
        const span = () => document.querySelector(
          `.pagedjs_pages .sentence[data-sentence-id="${CSS.escape(id)}"]`);
        const committedHTML = span().innerHTML;
        const r = {};
        const base = R.sentenceMap[id];
        // Success: local suggestion → patch applies diff markup in place.
        S.bySentenceId[id] = base + ' EDITEDWORD';
        S.renderBySentenceId[id] = base + ' EDITEDWORD'; // v3 render map
        r.patched = R.patchSentenceInPlace(id);
        r.patchedHTML = span().innerHTML;
        r.patchedClass = span().className;
        // Restore: remove the suggestion, patch again → committed markup back.
        delete S.bySentenceId[id];
        delete S.renderBySentenceId[id];
        r.restored = R.patchSentenceInPlace(id);
        r.restoredHTML = span().innerHTML;
        r.restoredClass = span().className;
        r.committedHTML = committedHTML;
        // Refusal: unknown id (zero spans).
        r.unknown = R.patchSentenceInPlace('no-such-sentence-id');
        // Multi-PARAGRAPH prose suggestion: collapses to one diffable span
        // (2026-08-24) — patches in place with the ¶/§ inline preview.
        S.bySentenceId[id] = 'Alpha.\n\nBeta.';
        S.renderBySentenceId[id] = 'Alpha.\n\nBeta.';
        r.multi = R.patchSentenceInPlace(id);
        r.multiHTML = span().innerHTML;
        delete S.bySentenceId[id];
        delete S.renderBySentenceId[id];
        R.patchSentenceInPlace(id); // back to committed before the next probe
        // Refusal: structural (non-<p>) suggestion → DOM untouched.
        S.bySentenceId[id] = '&title{Synthetic}';
        S.renderBySentenceId[id] = '&title{Synthetic}';
        r.structural = R.patchSentenceInPlace(id);
        r.structuralHTML = span().innerHTML;
        delete S.bySentenceId[id];
        delete S.renderBySentenceId[id];
        return r;
      }, { id: simple.id });
      check('R16: simple suggestion patches in place (true)',
        out.patched === true && out.patchedHTML.includes('<strong>')
        && out.patchedClass.includes('has-suggestion'), out.patchedClass);
      check('R16: removing the suggestion patches back to committed markup',
        out.restored === true && !out.restoredHTML.includes('<strong>')
        && !out.restoredClass.includes('has-suggestion'), out.restoredHTML.slice(0, 80));
      check('R16: unknown id refused', out.unknown === false);
      check('R16: multi-paragraph prose suggestion patches in place (diff + ¶ preview)',
        out.multi === true && out.multiHTML.includes('<strong>')
        && out.multiHTML.includes('suggested-marker'), (out.multiHTML || '').slice(0, 80));
      check('R16: structural (non-p) suggestion refused, DOM untouched',
        out.structural === false && out.structuralHTML === out.restoredHTML);
    }

    // ---- S12: modal save mirrors the server's delete-collapse ------------
    // authenticatedFetch is stubbed, so no PUT ever reaches the server; the
    // local bySentenceId mirror is what we're testing (suggestions.js:244–248).
    if (simple) {
      await page.evaluate(({ id }) => {
        window.__putCount = 0;
        window.__realAuthFetch = window.authenticatedFetch;
        window.authenticatedFetch = async () => { window.__putCount++; return { ok: true }; };
        localStorage.removeItem(`ms-draft-suggest-${id}`);
        window.WriteSysSuggestions.openModal(id);
      }, { id: simple.id });
      await page.waitForSelector('#suggestion-modal');
      await (await suggestEditor(page)).fill(simple.text + ' PLUSEDIT');
      await page.waitForFunction(({ id, want }) =>
        window.WriteSysSuggestions.bySentenceId[id] === want,
        { id: simple.id, want: simple.text + ' PLUSEDIT' }, { timeout: 10000 });
      check('S12: differing text saved into the local suggestion map', true);
      await (await suggestEditor(page)).fill(simple.text);
      await page.waitForFunction(({ id }) =>
        window.WriteSysSuggestions.bySentenceId[id] === undefined,
        { id: simple.id }, { timeout: 10000 });
      check('S12: text == original collapses to a local delete', true);
      const puts = await page.evaluate(() => window.__putCount);
      check('S12: both saves went through the stub (server untouched)', puts >= 2, `puts=${puts}`);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.getElementById('suggestion-modal'), null, { timeout: 10000 });
      check('S12: modal closes clean with no net change (no re-render needed)', true);
      await page.evaluate(({ id }) => {
        window.authenticatedFetch = window.__realAuthFetch;
        delete window.__realAuthFetch;
        localStorage.removeItem(`ms-draft-suggest-${id}`);
      }, { id: simple.id });
    }
  }

  // ---- R22: info-line format --------------------------------------------
  {
    const out = await page.evaluate(() => {
      const R = window.WriteSysRenderer;
      const el = document.getElementById('mc-info');
      const prev = el.textContent;
      const r = {};
      R.renderInfoLine({ processed_at: '2026-08-01T15:30:00Z', commit_hash: 'abcdef1234', word_count: 12345 });
      r.full = el.textContent;
      R.renderInfoLine({ processed_at: '2026-08-01T15:30:00Z', commit_hash: 'abcdef1234' });
      r.noCount = el.textContent;
      R.renderInfoLine(null);
      r.cleared = el.textContent;
      el.textContent = prev; // restore
      return r;
    });
    check('R22: "Updated <ts> · <short7>" shape (word count lives in Statistics)',
      /^Updated [^·]+ · abcdef1$/.test(out.full), out.full);
    check('R22: no word count in the info line', !/words/.test(out.full), out.full);
    check('R22: missing commit still renders Updated', /· abcdef1$/.test(out.noCount), out.noCount);
    check('R22: null migration clears the line', out.cleared === '');
  }

  // ---- D7: range-delete orderedIds field contract ----------------------
  {
    const out = await page.evaluate(() => {
      const RD = window.WriteSysRangeDelete;
      const R = window.WriteSysRenderer;
      const prev = R.currentSentences;
      const r = {};
      try {
        // PINNED (review D7): orderedIds maps `s.sentence_id || s.id` — the
        // sentence_id fallback wins over id when both are present. The fix
        // phase may remove the fallback (renderer rows only carry `id`);
        // update this pin then.
        R.currentSentences = [{ sentence_id: 'sid-1' }, { id: 'id-2' }, { sentence_id: 'sid-3', id: 'shadowed' }];
        r.mixed = JSON.stringify(RD.orderedIds());
        R.currentSentences = null;
        r.absent = JSON.stringify(RD.orderedIds());
      } finally {
        R.currentSentences = prev;
      }
      return r;
    });
    check('D7: sentence_id preferred, id fallback honored (pinned contract)',
      out.mixed === '["sid-1","id-2","sid-3"]', out.mixed);
    check('D7: missing sentence list → empty array', out.absent === '[]');
  }

  // ---- R19: no-Paged fallback path -------------------------------------
  // Temporarily hides window.Paged and renders synthetic sentences: the
  // fallback must write the HTML into #manuscript-content (not crash, not
  // touch the paginated tree). Everything is restored afterwards.
  {
    const out = await page.evaluate(async () => {
      const R = window.WriteSysRenderer;
      const container = document.getElementById('manuscript-content');
      const prevPaged = window.Paged;
      const prevSent = R.currentSentences;
      const prevHTML = container.innerHTML;
      const pagesBefore = document.querySelectorAll('.pagedjs_pages').length;
      const r = {};
      try {
        window.Paged = undefined;
        R.currentSentences = [{ id: 'r19', text: 'Fallback sentence.' }];
        await R.renderManuscript();
        r.containerHTML = container.innerHTML;
        r.pagesAfter = document.querySelectorAll('.pagedjs_pages').length;
        r.pagesBefore = pagesBefore;
      } finally {
        window.Paged = prevPaged;
        R.currentSentences = prevSent;
        container.innerHTML = prevHTML;
        R.applyEffectiveSettings();
        if (window.WriteSysOutline) window.WriteSysOutline.refresh();
      }
      return r;
    });
    check('R19: fallback writes rendered HTML into #manuscript-content',
      out.containerHTML.includes('data-sentence-id="r19"') && out.containerHTML.includes('Fallback sentence.'),
      out.containerHTML.slice(0, 100));
    check('R19: fallback leaves the paginated tree alone',
      out.pagesAfter === out.pagesBefore, `${out.pagesBefore} → ${out.pagesAfter}`);
  }

  // ---- P4: pagedjs-config late-load retry -------------------------------
  // A FRESH page (no app, no real Paged — setContent on the app page keeps
  // the window and its Paged global, defeating the late-load scenario).
  {
    const p4 = await browser.newPage();
    await p4.setContent('<!DOCTYPE html><html><body></body></html>');
    await p4.addScriptTag({ path: path.join(__dirname, '..', 'web', 'js', 'pagedjs-config.js') });
    await p4.waitForTimeout(250); // let the 100ms poll spin while Paged is absent
    const before = await p4.evaluate(() => typeof Paged);
    check('P4: nothing to register while Paged is absent', before === 'undefined', before);
    await p4.evaluate(() => {
      window.__regCount = 0;
      window.Paged = {
        Handler: class {},
        registerHandlers() { window.__regCount++; },
      };
    });
    await p4.waitForFunction(() => window.__regCount === 1, null, { timeout: 5000 });
    check('P4: handler registered once Paged appears (100ms poll)', true);
    await p4.waitForTimeout(400); // < 1s: give the poll time to (wrongly) re-fire
    const after = await p4.evaluate(() => window.__regCount);
    check('P4: no double registration after the poll stops', after === 1, String(after));
    await p4.close();
  }

  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
