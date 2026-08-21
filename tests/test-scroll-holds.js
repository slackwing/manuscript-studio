// Scroll engine e2e (CODE_REVIEW_AUG_2026 Area 1, "Scroll engine" — all 4 E
// rows — plus edit-pane's autogrow-pin E row):
//   holdscroll-single-pin       — programmatic scroll during an active hold is
//                                 pinned back; after the window it sticks
//                                 (listener removed / hold released);
//   holdscroll-above-viewport-delta — a widget ABOVE the viewport growing on
//                                 refresh moves scrollTop by its height delta
//                                 so the content in view stays put;
//   holdscroll-suspension-rebase — the deep-link settle-scroll wins over
//                                 widget-mount holds (rebase, not fight) and
//                                 actually lands centered on the widget;
//   scrolldiag-ring             — the flight recorder caps at 100 events and
//                                 dumps on a >300px jump;
//   autogrow-pin                — keystrokes in a sketch textarea near the
//                                 scroll bottom don't clamp scrollTop.
const { chromium } = require('playwright');
const { TEST_URL, cleanupTestNotes, loginAsTestUser } = require('./test-utils');
const HOME_URL = new URL('home.html', TEST_URL).href;

(async () => {
  console.log('=== scroll engine e2e ===\n');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('dialog', d => d.accept());
  const consoleLines = [];
  page.on('console', (m) => { const t = m.text(); if (t.includes('[ms-scrolldiag]')) consoleLines.push(t); });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  let failed = 0;
  const check = (n, ok, extra) => {
    console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`);
    if (!ok) failed++;
  };

  await cleanupTestNotes();
  await loginAsTestUser(page);
  await page.goto(HOME_URL);
  await page.waitForSelector('.card-ghost[data-ghost="scratchpad"]');

  try {
    // Build the tall pad via the API: widget A at the TOP, ~40 paragraphs,
    // widget B near the BOTTOM (same sketch group so sibling refresh works).
    const seed = await page.evaluate(async () => {
      const csrf = (localStorage.getItem('csrf_token') || sessionStorage.getItem('csrf_token')) || '';
      const H = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf };
      const pad = (await (await fetch('api/scratchpads', { method: 'POST', headers: H, body: JSON.stringify({ title: 'scroll pad' }) })).json()).scratchpad_id;
      const a = await (await fetch('api/sketches', { method: 'POST', headers: H, body: JSON.stringify({ mode: 'new', scratchpad_id: pad }) })).json();
      const b = await (await fetch('api/sketches', { method: 'POST', headers: H, body: JSON.stringify({ mode: 'variation', source_variation_id: a.variation.variation_id, scratchpad_id: pad }) })).json();
      await fetch(`api/variations/${a.variation.variation_id}`, { method: 'PUT', headers: H, body: JSON.stringify({ text: 'Short top text.' }) });
      await fetch(`api/variations/${b.variation.variation_id}`, { method: 'PUT', headers: H, body: JSON.stringify({ text: 'Bottom widget text. '.repeat(30) }) });
      const para = (i) => ({ type: 'paragraph', content: [{ type: 'text', text: `Filler paragraph ${i}: the quick brown fox jumps over the lazy dog again and again.` }] });
      const content = [
        { type: 'snippet', attrs: { variationId: a.variation.variation_id } },
        ...Array.from({ length: 40 }, (_, i) => para(i)),
        { type: 'snippet', attrs: { variationId: b.variation.variation_id } },
        { type: 'paragraph' },
      ];
      await fetch(`api/scratchpads/${pad}`, { method: 'PUT', headers: H, body: JSON.stringify({ title: 'scroll pad', doc: { type: 'doc', content } }) });
      return { pad, sketchId: a.sketch.sketch_id, varA: a.variation.variation_id, varB: b.variation.variation_id };
    });
    await page.evaluate((id) => window.WriteSysScratchpadModal.open(id), seed.pad);
    await page.waitForSelector('.spm-overlay .ProseMirror');
    await page.waitForFunction(() => document.querySelectorAll('.sn-widget .sn-render').length === 2);
    const wB = page.locator(`.sn-widget[data-variation-id="${seed.varB}"]`);
    const scrollable = await page.evaluate(() => {
      const h = document.querySelector('.spm-editor');
      return h.scrollHeight - h.clientHeight;
    });
    check('pad is tall enough to scroll', scrollable > 800, `scrollable=${scrollable}`);

    // ---- autogrow-pin -----------------------------------------------------
    await wB.scrollIntoViewIfNeeded();
    await wB.locator('.sn-render').click();
    await page.waitForSelector('.sn-widget textarea.sn-text');
    // Park the reader near the BOTTOM of the host, then type.
    await page.evaluate(() => {
      const h = document.querySelector('.spm-editor');
      h.scrollTop = h.scrollHeight - h.clientHeight - 8;
    });
    // Let any click-time holds lapse so only the keystroke path is measured.
    for (let i = 0; i < 3; i++) await page.waitForTimeout(400);
    const grow = await page.evaluate(() => {
      const h = document.querySelector('.spm-editor');
      return { before: h.scrollTop };
    });
    await page.keyboard.type('xy');
    await page.waitForTimeout(150);
    const growAfter = await page.evaluate(() => document.querySelector('.spm-editor').scrollTop);
    check('keystroke near the scroll bottom does not clamp scrollTop (autogrow pin)',
      Math.abs(growAfter - grow.before) <= 2, `before=${grow.before} after=${growAfter}`);
    await page.keyboard.press('Escape'); // exit edit
    await page.waitForFunction((vid) =>
      document.querySelector(`.sn-widget[data-variation-id="${vid}"] .sn-render`), seed.varB);

    // ---- holdscroll-above-viewport-delta ---------------------------------
    // W1 (A) sits far above the viewport. Grow it hard via the API, then
    // trigger a sibling refresh from W2 — the delta must be folded into
    // scrollTop so the paragraph in view doesn't move.
    await page.evaluate(async (a) => {
      const csrf = (localStorage.getItem('csrf_token') || sessionStorage.getItem('csrf_token')) || '';
      await fetch(`api/variations/${a.varA}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ text: ('Grown paragraph of sketch A. '.repeat(12) + '\n\n\t').repeat(14) }),
      });
    }, seed);
    const before = await page.evaluate((vid) => {
      const h = document.querySelector('.spm-editor');
      const wA = document.querySelector(`.sn-widget[data-variation-id="${vid}"]`);
      const marker = [...document.querySelectorAll('.spm-editor p')].find(p => /Filler paragraph 38/.test(p.textContent));
      return {
        scrollTop: h.scrollTop,
        aAbove: wA.getBoundingClientRect().bottom <= h.getBoundingClientRect().top + 1,
        aHeight: wA.offsetHeight,
        markerTop: marker.getBoundingClientRect().top,
      };
    }, seed.varA);
    check('widget A sits fully above the viewport before the refresh', before.aAbove);
    // A state toggle on W2 refreshes W2 AND its siblings (incl. W1).
    await wB.locator('[data-act="freeze"]').click();
    await page.waitForSelector(`.sn-widget[data-variation-id="${seed.varB}"] [data-act="freeze"].pressed`);
    // Wait out the 700ms hold window, then measure.
    for (let i = 0; i < 3; i++) await page.waitForTimeout(400);
    const after = await page.evaluate((vid) => {
      const h = document.querySelector('.spm-editor');
      const wA = document.querySelector(`.sn-widget[data-variation-id="${vid}"]`);
      const marker = [...document.querySelectorAll('.spm-editor p')].find(p => /Filler paragraph 38/.test(p.textContent));
      return { scrollTop: h.scrollTop, aHeight: wA.offsetHeight, markerTop: marker.getBoundingClientRect().top };
    }, seed.varA);
    const deltaH = after.aHeight - before.aHeight;
    check('the above-viewport widget actually grew', deltaH > 150, `deltaH=${deltaH}`);
    check('scrollTop absorbed the height delta', after.scrollTop - before.scrollTop > deltaH * 0.7,
      `scrolled ${Math.round(after.scrollTop - before.scrollTop)} for deltaH ${deltaH}`);
    check('the paragraph in view stayed put (±40px)',
      Math.abs(after.markerTop - before.markerTop) <= 40,
      `markerTop ${Math.round(before.markerTop)} → ${Math.round(after.markerTop)}`);

    // ---- holdscroll-single-pin (fight while active, release after) --------
    await wB.locator('[data-act="freeze"].pressed').click(); // unfreeze → refresh → fresh hold
    // The refresh (and its preserveScroll hold) arms only after the state PUT
    // round-trips — wait for the rebuilt (un-pressed) widget, THEN fight the
    // hold inside its 700ms window.
    await page.waitForFunction((vid) =>
      document.querySelector(`.sn-widget[data-variation-id="${vid}"] [data-act="freeze"]:not(.pressed)`), seed.varB);
    const fight = await page.evaluate(async () => {
      const h = document.querySelector('.spm-editor');
      const held = h.scrollTop;
      h.scrollTop = held - 300; // fight the active hold
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      await new Promise(r => requestAnimationFrame(r));
      return { held, after: h.scrollTop };
    });
    check('programmatic scroll during an active hold is pinned back',
      Math.abs(fight.after - fight.held) <= 2, `held=${fight.held} after=${fight.after}`);
    // Wait out the hold window; a scroll must then STICK (listener removed).
    for (let i = 0; i < 4; i++) await page.waitForTimeout(400);
    const release = await page.evaluate(async () => {
      const h = document.querySelector('.spm-editor');
      const start = h.scrollTop;
      h.scrollTop = start - 300;
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      await new Promise(r => setTimeout(r, 120));
      return { start, after: h.scrollTop };
    });
    check('after the hold window the scroll sticks (hold released)',
      Math.abs(release.after - (release.start - 300)) <= 2, `start=${release.start} after=${release.after}`);

    // ---- scrolldiag-ring --------------------------------------------------
    const diag = await page.evaluate(() => {
      const d = window.msScrollDiag;
      if (!d) return null;
      for (let i = 0; i < 150; i++) d.push('test-event', { i });
      return { len: d.buf.length, host: !!d.host };
    });
    check('scrolldiag installed on the pad host', !!(diag && diag.host));
    check('ring buffer caps at 100 events', diag && diag.len === 100, `len=${diag && diag.len}`);
    consoleLines.length = 0;
    await page.evaluate(() => {
      const h = document.querySelector('.spm-editor');
      h.scrollTop = Math.max(0, h.scrollTop - 400); // >300px jump in one event
    });
    let dumped = false;
    for (let i = 0; i < 30 && !dumped; i++) {
      dumped = consoleLines.some(l => /JUMP/.test(l));
      if (!dumped) await page.waitForTimeout(100);
    }
    check('>300px jump dumps the flight recorder to the console', dumped,
      `${consoleLines.length} diag lines`);

    // ---- holdscroll-suspension-rebase (deep-link settle-scroll wins) ------
    await page.waitForFunction(() => document.querySelector('#spm-status').textContent === 'Saved');
    await page.click('#spm-close');
    await page.waitForSelector('.spm-overlay', { state: 'detached' });
    await page.evaluate((a) => {
      window.location.hash = `#scratchpad=${a.pad}&sketch=${a.sketchId}&variation=2`;
    }, seed);
    await page.waitForSelector('.spm-overlay .ProseMirror');
    await page.waitForFunction((vid) =>
      document.querySelector(`.sn-widget[data-variation-id="${vid}"]`), seed.varB);
    // Poll until the position is STABLE (settle passes + widget mounts done),
    // then require the target widget to overlap the middle of the viewport —
    // without the suspension rebase, mounting widgets yank the pad to the top.
    let landed = false, lastTop = -1e9, stable = 0, finalPos = null;
    for (let i = 0; i < 40; i++) {
      const pos = await page.evaluate((vid) => {
        const h = document.querySelector('.spm-editor');
        const el = document.querySelector(`.sn-widget[data-variation-id="${vid}"]`);
        const hr = h.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, hostTop: hr.top, hostBottom: hr.bottom };
      }, seed.varB);
      stable = Math.abs(pos.top - lastTop) < 2 ? stable + 1 : 0;
      lastTop = pos.top;
      finalPos = pos;
      if (stable >= 4) {
        // Landed = the widget overlaps the middle band of the host viewport
        // (block:center on a tall widget can put its top just past middle).
        const h = pos.hostBottom - pos.hostTop;
        const bandTop = pos.hostTop + h * 0.25;
        const bandBottom = pos.hostTop + h * 0.75;
        landed = pos.top < bandBottom && pos.bottom > bandTop;
        break;
      }
      await page.waitForTimeout(250);
    }
    check('deep-link settle-scroll LANDS on the widget (holds rebase, not fight)',
      landed, JSON.stringify(finalPos && { top: Math.round(finalPos.top), hostTop: Math.round(finalPos.hostTop), hostBottom: Math.round(finalPos.hostBottom) }));

    check('no page errors', errs.length === 0, errs.slice(0, 3).join('; '));
  } finally {
    await cleanupTestNotes();
    await browser.close();
  }

  console.log(failed === 0 ? '\n✅ Test passed' : `\n❌ ${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('Test crashed:', e); process.exit(1); });
