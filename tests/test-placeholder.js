// &placeholder rendering end-to-end (PLACEHOLDER_PLAN.md v2): an inline
// sentences-unit placeholder renders as a grey lorem run inside its host
// sentence, a block paragraphs-unit placeholder renders N grey lorem
// paragraphs that are ONE sentence and lists in the outline exactly like an
// anchor, a mis-syntaxed placeholder prints as literal prose, and the old
// fourth {details} arg is ignored. Uses the suggestion preview path
// (same technique as test-structural-suggestion.js) so the fixture
// manuscript is untouched.
const { chromium } = require('playwright');
const {
  TEST_URL,
  cleanupTestAnnotations, loginAsTestUser,
  waitForPagination,
} = require('./test-utils');

(async () => {
  console.log('=== &placeholder rendering ===\n');
  let failed = 0;
  const check = (name, ok, detail = '') => {
    console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` (${detail})` : ''}`);
    if (!ok) failed++;
  };

  await cleanupTestAnnotations();

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1400, height: 1200 });
  page.on('dialog', async d => { try { await d.dismiss(); } catch (e) {} });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  const suggested = []; // sentence ids to clean up

  try {
    await loginAsTestUser(page);
    await page.goto(TEST_URL);
    await page.waitForSelector('.sentence', { timeout: 30000 });
    await waitForPagination(page);

    // Three distinct prose sentences to suggest on (document order: the
    // chapter must precede the block placeholder so the placeholder's
    // outline row attaches to it).
    const targets = await page.evaluate(() => {
      const spans = Array.from(document.querySelectorAll('p .sentence'))
        .filter(s => s.textContent.trim().length > 20);
      const ids = [];
      for (const s of spans) {
        if (!ids.includes(s.dataset.sentenceId)) ids.push(s.dataset.sentenceId);
        if (ids.length === 3) break;
      }
      return ids;
    });
    check('found three target sentences', targets.length === 3, targets.join(', '));
    if (targets.length < 3) throw new Error('not enough target sentences');
    const [chapterId, inlineId, blockId] = targets;

    const csrf = await page.evaluate(() => sessionStorage.getItem('csrf_token'));
    const put = async (id, text) => {
      const status = await page.evaluate(async ({ id, csrf, text }) => {
        const r = await fetch(`api/sentences/${id}/suggestion`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
          body: JSON.stringify({ text }),
        });
        return r.status;
      }, { id, csrf, text });
      if (status === 200) suggested.push(id);
      return status;
    };

    // A chapter above the placeholders, so the outline has a section row
    // whose page count must run PAST the anchor-style placeholder row.
    const st0 = await put(chapterId, '&chapter{The Keg Party}');
    check('chapter suggestion PUT accepted', st0 === 200, `status ${st0}`);

    // Inline: sentences-unit placeholder mid-sentence, a mis-syntaxed one
    // (bad unit) that must print as literal prose, and the old four-arg
    // form with {details}, which must render as a placeholder (never raw).
    const st1 = await put(inlineId,
      'She waited on the platform. &placeholder#reunion{sentences}{l}{Reunion beat} The end came quietly, and also &placeholder{words} stayed literal, as did &placeholder{sentences}{s}{}{legacy details}.');
    check('inline suggestion PUT accepted', st1 === 200, `status ${st1}`);

    // Block: paragraphs-unit placeholder as the sentence's whole text, WITH
    // a leading paragraph-indent marker — the first filler paragraph must
    // honor it (regression: markers were dropped for block placeholders).
    const st2 = await put(blockId,
      '\n\t&placeholder#the-argument{paragraphs}{s}{The argument}');
    check('block suggestion PUT accepted', st2 === 200, `status ${st2}`);

    await page.reload();
    await page.waitForSelector('.sentence', { timeout: 30000 });
    await waitForPagination(page);

    // --- inline form ---
    const inline = await page.evaluate((id) => {
      const span = document.querySelector(`.pagedjs_pages .sentence[data-sentence-id="${id}"]`);
      if (!span) return { found: false };
      const ph = span.querySelector('.ph');
      const phStyle = ph && getComputedStyle(ph);
      const text = ph ? ph.textContent : '';
      return {
        found: true,
        hasPh: !!ph,
        color: phStyle ? phStyle.color : '',
        lorem: /^Lorem ipsum dolor sit amet/.test(text),
        sentences: (text.match(/[.?](\s|$)/g) || []).length,
        unselectable: phStyle ? phStyle.userSelect === 'none' : false,
        chip: !!span.querySelector('.ph-chip'),
        literalUnit: /&placeholder\{words\}/.test(span.textContent),
        legacyRuns: span.querySelectorAll('.ph').length,
        legacyRaw: /legacy details|&placeholder\{sentences\}\{s\}/.test(span.textContent),
      };
    }, inlineId);
    check('inline .ph rendered inside host sentence', inline.found && inline.hasPh);
    // The host sentence is a suggestion preview, so the run reads suggested-blue.
    check('inline filler is visible lorem ipsum', inline.lorem === true);
    check('inline run has l = 5 sentences', inline.sentences === 5, String(inline.sentences));
    check('a suggested placeholder reads blue like other suggested text', inline.color === 'rgb(42, 111, 176)', inline.color);
    check('filler is unselectable', inline.unselectable === true);
    check('no details chip anywhere', inline.chip === false);
    check('mis-syntaxed &placeholder{words} prints as literal prose', inline.literalUnit === true);
    check('the old four-arg {details} form renders as a placeholder, never raw', inline.legacyRuns === 2 && inline.legacyRaw === false, `runs=${inline.legacyRuns} raw=${inline.legacyRaw}`);

    // --- block form ---
    const block = await page.evaluate((id) => {
      // paged.js may split the block across pages — query across fragments.
      const divs = Array.from(document.querySelectorAll('.pagedjs_pages .cmd-placeholder'));
      if (divs.length === 0) return { found: false };
      const phs = Array.from(document.querySelectorAll('.pagedjs_pages .cmd-placeholder p .ph'));
      const first = phs[0] ? getComputedStyle(phs[0]) : null;
      return {
        found: true,
        // A split paragraph clones its <p> across fragments, so >= 2.
        paragraphs: phs.length,
        color: first ? first.color : '',
        lorem: phs.every(p => /^(Lorem ipsum|Sed ut perspiciatis|At vero eos)/.test(p.textContent) || p.textContent.length > 0),
        firstLorem: phs[0] ? /^Lorem ipsum dolor/.test(phs[0].textContent) : false,
        oneSentence: phs.length > 0 && phs.every(p => p.dataset.sentenceId === id),
        overlay: !!document.querySelector('.pagedjs_pages .cmd-placeholder .ph-overlay, .pagedjs_pages .ph-chip-block'),
        carriesSentenceId: divs.some(d => !!d.querySelector(`.sentence[data-sentence-id="${id}"]`)),
      };
    }, blockId);
    check('block placeholder rendered', block.found === true);
    const indented = await page.evaluate(() =>
      !!document.querySelector('.pagedjs_pages .cmd-placeholder p:first-of-type.indented'));
    check('leading \\n\\t marker indents the first filler paragraph', indented === true);
    check('block has >= 2 lorem paragraphs (s = 2)', block.paragraphs >= 2, String(block.paragraphs));
    check('block starts at the start of the passage', block.firstLorem === true);
    check('suggested block reads blue', block.color === 'rgb(42, 111, 176)', block.color);
    check('every filler paragraph is the SAME sentence (one id)', block.oneSentence === true);
    check('no overlay chip', block.overlay === false);
    check('block region carries its sentence id', block.carriesSentenceId === true);

    // --- outline: placeholder lists exactly like an anchor ---
    const outline = await page.evaluate(() => {
      const item = Array.from(document.querySelectorAll('.outline-item.outline-anchor'))
        .find(n => /The argument/.test(n.textContent));
      return item ? { cls: item.className, text: item.textContent.trim() } : null;
    });
    check('outline lists the placeholder as an anchor row', !!outline, outline && outline.cls);

    // --- outline page count: a chapter's span runs PAST anchor rows ---
    await page.waitForTimeout(800); // updatePageInfo settles post-pagination
    const pageInfo = await page.evaluate(() => {
      const totalPages = document.querySelectorAll('.pagedjs_page').length;
      const ch = Array.from(document.querySelectorAll('.outline-item.outline-chapter'))
        .find(n => /The Keg Party/.test(n.textContent));
      const count = ch ? (ch.querySelector('.outline-count') || {}).textContent : null;
      const start = ch ? (ch.querySelector('.outline-page') || {}).textContent : null;
      return { totalPages, count, start };
    });
    // The chapter is the last section row, so its span must reach the final
    // page — the anchor-style placeholder row inside it must not cut it off.
    const expectedSpan = pageInfo.start
      ? `${Math.max(1, pageInfo.totalPages - parseInt(pageInfo.start, 10) + 1)}pp` : null;
    check('chapter page count runs past the placeholder row',
      !!pageInfo.count && pageInfo.count === expectedSpan,
      `count ${pageInfo.count}, start ${pageInfo.start}, ${pageInfo.totalPages} pages`);

    check('no page errors', errs.length === 0, errs.join('; '));
  } finally {
    try {
      const csrf = await page.evaluate(() => sessionStorage.getItem('csrf_token'));
      for (const id of suggested) {
        await page.evaluate(async ({ id, csrf }) => {
          await fetch(`api/sentences/${id}/suggestion`, { method: 'DELETE', headers: { 'X-CSRF-Token': csrf } });
        }, { id, csrf });
      }
    } catch (e) { /* best effort */ }
    await cleanupTestAnnotations();
    await browser.close();
  }

  console.log(failed === 0 ? '\n✅ Test passed' : `\n❌ ${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(err => { console.error('Test crashed:', err); process.exit(1); });
