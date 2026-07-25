// &placeholder rendering end-to-end (PLACEHOLDER_PLAN.md): an inline
// sentences-unit placeholder renders as an invisible hatched run inside its
// host sentence (details chip on hover), a block paragraphs-unit placeholder
// renders N hatched paragraphs with a persistent overlay chip and lists in
// the outline exactly like an anchor, and a mis-syntaxed placeholder prints
// as literal prose. Uses the suggestion preview path (same technique as
// test-structural-suggestion.js) so the fixture manuscript is untouched.
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

    // Inline: sentences-unit placeholder mid-sentence, plus a mis-syntaxed
    // one that must print as literal prose.
    const st1 = await put(inlineId,
      'She waited on the platform. &placeholder#reunion{sentences}{l}{Reunion beat}{They finally meet. Keep it wordless.} The end came quietly, and also &placeholder{words} stayed literal.');
    check('inline suggestion PUT accepted', st1 === 200, `status ${st1}`);

    // Block: paragraphs-unit placeholder as the sentence's whole text.
    const st2 = await put(blockId,
      '&placeholder#the-argument{paragraphs}{s}{The argument}{Mara confronts him. Three beats, escalating.}');
    check('block suggestion PUT accepted', st2 === 200, `status ${st2}`);

    await page.reload();
    await page.waitForSelector('.sentence', { timeout: 30000 });
    await waitForPagination(page);

    // --- inline form ---
    const inline = await page.evaluate((id) => {
      const span = document.querySelector(`.pagedjs_pages .sentence[data-sentence-id="${id}"]`);
      if (!span) return { found: false };
      const ph = span.querySelector('.ph');
      const chip = ph && ph.querySelector('.ph-chip');
      const phStyle = ph && getComputedStyle(ph);
      return {
        found: true,
        hasPh: !!ph,
        transparent: phStyle ? phStyle.color === 'rgba(0, 0, 0, 0)' : false,
        hatched: phStyle ? /svg/.test(phStyle.backgroundImage) : false,
        unselectable: phStyle ? phStyle.userSelect === 'none' : false,
        chipHidden: chip ? getComputedStyle(chip).visibility === 'hidden' : null,
        literal: /&placeholder\{words\}/.test(span.textContent),
        fillerVisibleText: ph ? /Lorem ipsum/.test(span.innerText) : null,
        padVar: getComputedStyle(document.documentElement).getPropertyValue('--ph-pad').trim(),
      };
    }, inlineId);
    check('inline .ph rendered inside host sentence', inline.found && inline.hasPh);
    check('filler text is invisible (transparent)', inline.transparent === true);
    check('hatch tile background applied', inline.hatched === true);
    check('filler is unselectable', inline.unselectable === true);
    check('details chip suppressed until hover', inline.chipHidden === true);
    check('mis-syntaxed &placeholder{words} prints as literal prose', inline.literal === true);
    check('row-bridge --ph-pad measured', /px$/.test(inline.padVar || ''), inline.padVar);

    // Hover reveals the chip.
    const phBox = await page.evaluate((id) => {
      const ph = document.querySelector(`.pagedjs_pages .sentence[data-sentence-id="${id}"] .ph`);
      if (!ph) return null;
      const r = ph.getClientRects()[0];
      return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
    }, inlineId);
    if (phBox) {
      await page.mouse.move(phBox.x, phBox.y);
      await page.waitForTimeout(300);
      const chipShown = await page.evaluate((id) => {
        const chip = document.querySelector(`.pagedjs_pages .sentence[data-sentence-id="${id}"] .ph .ph-chip`);
        return chip ? getComputedStyle(chip).visibility === 'visible' : false;
      }, inlineId);
      check('hovering the region reveals the details chip', chipShown === true);
    } else {
      check('hovering the region reveals the details chip', false, 'no .ph rect');
    }

    // --- block form ---
    const block = await page.evaluate((id) => {
      // paged.js may split the block across pages — query across fragments.
      const divs = Array.from(document.querySelectorAll('.pagedjs_pages .cmd-placeholder'));
      if (divs.length === 0) return { found: false };
      const chip = document.querySelector('.pagedjs_pages .cmd-placeholder .ph-chip-block');
      const phs = Array.from(document.querySelectorAll('.pagedjs_pages .cmd-placeholder p .ph'));
      // Regression guards: (a) a suggested placeholder's filler must stay
      // invisible even under the blue .cmd-suggested affordance; (b) hatched
      // rows must butt-joint with no gap, INCLUDING inside the halves of a
      // paragraph paged.js split across pages (it zeroes padding on split
      // elements, which used to open --ph-pad-sized gaps).
      const first = phs[0] ? getComputedStyle(phs[0]) : null;
      let maxGap = 0;
      for (const ph of phs) {
        const rows = Array.from(ph.getClientRects())
          .filter(r => r.width > 1).sort((a, b) => a.top - b.top);
        for (let i = 1; i < rows.length; i++) {
          maxGap = Math.max(maxGap, rows[i].top - rows[i - 1].bottom);
        }
      }
      return {
        found: true,
        // A split paragraph clones its <p> across fragments, so >= 2.
        paragraphs: phs.length,
        transparent: first ? first.color === 'rgba(0, 0, 0, 0)' : false,
        suggestedBlueHatch: first ? /2a6fb0/.test(first.backgroundImage) : false,
        maxGap: +maxGap.toFixed(3),
        overlayText: chip ? chip.textContent : '',
        overlayVisible: chip ? getComputedStyle(chip).visibility !== 'hidden' : false,
        carriesSentenceId: divs.some(d => !!d.querySelector(`.sentence[data-sentence-id="${id}"]`)),
      };
    }, blockId);
    check('block placeholder rendered', block.found === true);
    check('block has >= 2 hatched paragraphs (s = 2)', block.paragraphs >= 2, String(block.paragraphs));
    check('suggested block filler stays invisible (no blue text)', block.transparent === true);
    check('suggested placeholder hatch carries the blue affordance', block.suggestedBlueHatch === true);
    check('no gaps between hatched rows (split halves included)', block.maxGap < 0.5, `maxGap ${block.maxGap}px`);
    check('overlay chip persistent with slug — label + details', block.overlayVisible === true
      && /#the-argument — The argument/.test(block.overlayText || '')
      && /Three beats, escalating/.test(block.overlayText || ''), block.overlayText);
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
