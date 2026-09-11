// Attention envelope e2e (ATTENTION_PLAN.md): real pagination, real
// overlays. Injects committed sentences with valued markers into the
// renderer's local state (renderManuscript re-paginates; the afterRendered
// hook pre-generates the SVGs), then exercises Tab-hold, fills, clipping,
// z-order and the see-attention gate.
const { chromium } = require('playwright');
const { TEST_URL, loginAsTestUser, waitForPagination } = require('./test-utils');

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail !== '' ? ` (${detail})` : ''}`);
  if (!ok) failed++;
};

(async () => {
  console.log('=== attention envelope e2e ===\n');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  await loginAsTestUser(page);
  await page.goto(TEST_URL);
  await waitForPagination(page);

  // Inject a small manuscript: a +10 marker early, a −15 dip later.
  const prose = 'The evening settled over the valley like a long held breath. ';
  await page.evaluate(async (prose) => {
    window.WriteSysMarkerSymbols.map = {
      vivid: { symbol: 'default', attention: 10 },
      digression: { symbol: 'triangle-down', attention: -15 },
    };
    const R = window.WriteSysRenderer;
    const sentences = [];
    for (let i = 0; i < 30; i++) {
      let text = prose + `Sentence number ${i} carries the paragraph onward. `;
      if (i === 3) text += '&marker#vivid ';
      if (i === 18) text += '&marker#digression ';
      sentences.push({ id: `att-${i}`, sentence_id: `att-${i}`, text });
    }
    R.currentSentences = sentences;
    R.sentenceMap = Object.fromEntries(sentences.map((s) => [s.id, s.text]));
    await R.renderManuscript();
  }, prose);
  await page.waitForFunction(() => document.querySelectorAll('.attention-overlay').length > 0,
    null, { timeout: 30000 });

  const info = await page.evaluate(() => {
    const svgs = [...document.querySelectorAll('.attention-overlay')];
    const first = svgs[0];
    const page0 = first.closest('.pagedjs_page');
    const paths = [...first.querySelectorAll('path')].map((p) => p.getAttribute('d'));
    const firstLineTop = (() => {
      const r = page0.querySelector('.sentence').getClientRects()[0];
      const pr = page0.getBoundingClientRect();
      const s = pr.width / page0.offsetWidth;
      return (r.top - pr.top) / s;
    })();
    return {
      count: svgs.length,
      display: getComputedStyle(first).display,
      z: first.style.zIndex,
      pageZ: page0.style.zIndex,
      pos: getComputedStyle(page0).position,
      green: paths[0], red: paths[1], pathCount: paths.length,
      hasStroke: [...first.querySelectorAll('path')].some((p) => (p.getAttribute('stroke') || 'none') !== 'none'),
      anyNegative: svgs.some((s2) => (s2.querySelectorAll('path')[1].getAttribute('d') || '').includes('L-')),
      firstLineTop,
      startY: parseFloat((paths[0].match(/^M0 ([\d.]+)/) || [])[1]),
    };
  });
  check('one overlay per rendered page', info.count >= 1, String(info.count));
  check('hidden until Tab is held', info.display === 'none');
  check('behind the text: svg z-index −1 inside a page stacking context',
    info.z === '-1' && info.pageZ === '0' && info.pos === 'relative',
    `z=${info.z} pageZ=${info.pageZ} pos=${info.pos}`);
  check('green (positive) area path present', !!info.green && info.green.length > 40);
  check('shading only — two area paths, no stroked plot line',
    info.pathCount === 2 && !info.hasStroke,
    `paths=${info.pathCount} stroke=${info.hasStroke}`);
  check('negative attention dips left of the sheet edge (into the gutter)',
    info.anyNegative);
  check('clipped to the first line of text (plot starts at its top edge)',
    Math.abs(info.startY - info.firstLineTop) < 6,
    `start=${info.startY} firstLine=${info.firstLineTop}`);

  // The +10 marker's swell: the green area's widest point on page 1 sits at
  // or below the marker's line (attack peaks a few words AFTER the impulse).
  const align = await page.evaluate(() => {
    const svg = document.querySelector('.attention-overlay');
    const page0 = svg.closest('.pagedjs_page');
    const pr = page0.getBoundingClientRect();
    const s = pr.width / page0.offsetWidth;
    const mk = document.querySelector('.pagedjs_pages .inline-cmd[data-kind="marker"], .pagedjs_pages .cmd-diamond-marker');
    const mr = (mk.getClientRects()[0] || mk.parentElement.getBoundingClientRect());
    const markerY = (mr.top - pr.top) / s;
    const d = svg.querySelectorAll('path')[0].getAttribute('d');
    let best = { x: -1, y: 0 };
    for (const m of d.matchAll(/([\d.-]+) ([\d.]+)/g)) {
      const x = parseFloat(m[1]);
      if (x > best.x) best = { x, y: parseFloat(m[2]) };
    }
    return { markerY, peakY: best.y, peakX: best.x };
  });
  check('envelope peaks at/just below the +10 marker line',
    align.peakX > 0 && align.peakY >= align.markerY - 4 && align.peakY < align.markerY + 150,
    JSON.stringify(align));

  // Hold Tab → visible; release → hidden.
  await page.keyboard.down('Tab');
  await page.waitForFunction(() => document.documentElement.classList.contains('attention-held'));
  check('holding Tab reveals the overlays', await page.evaluate(() =>
    getComputedStyle(document.querySelector('.attention-overlay')).display === 'block'));
  await page.keyboard.up('Tab');
  await page.waitForFunction(() => !document.documentElement.classList.contains('attention-held'));
  check('releasing Tab hides them', await page.evaluate(() =>
    getComputedStyle(document.querySelector('.attention-overlay')).display === 'none'));

  // Gate: without see-attention there is NO overlay and Tab is inert.
  await page.evaluate(async () => {
    window.__saved = window.currentSession;
    window.currentSession = { accessible_manuscripts: [{ manuscript_id: 1, actions: ['see-manuscript'] }] };
    window.WriteSysAttention.rebuild();
  });
  check('no see-attention → no overlays', await page.evaluate(() =>
    document.querySelectorAll('.attention-overlay').length === 0));
  await page.keyboard.down('Tab');
  await page.waitForTimeout(150);
  check('no see-attention → Tab is inert', await page.evaluate(() =>
    !document.documentElement.classList.contains('attention-held')));
  await page.keyboard.up('Tab');
  await page.evaluate(() => { window.currentSession = window.__saved; });

  // ---- stats-pane TOGGLE button (the touch counterpart of Tab) --------
  // Click pins the envelope on; it stays through pointer-leave, Tab
  // release and re-renders; a second click releases.
  await page.evaluate(() => { window.currentSession = window.__saved; window.WriteSysAttention.rebuild(); });
  await page.evaluate(() => window.WriteSysStats && window.WriteSysStats.setPane && window.WriteSysStats.setPane('stats'));
  await page.waitForSelector('#stats-attention', { timeout: 8000 });
  const pressed = () => page.evaluate(() =>
    document.getElementById('stats-attention').getAttribute('aria-pressed'));
  check('button starts unpressed', (await pressed()) === 'false');
  await page.click('#stats-attention');
  await page.waitForFunction(() => document.documentElement.classList.contains('attention-held'));
  check('clicking the stats button pins the overlays on', true);
  check('button reads pressed', (await pressed()) === 'true');
  await page.mouse.move(5, 5); // pointer leaves the button
  await page.keyboard.down('Tab');
  await page.keyboard.up('Tab');
  await page.waitForTimeout(100);
  check('pinned: pointer-leave and Tab release do not hide it', await page.evaluate(() =>
    document.documentElement.classList.contains('attention-held')
    && getComputedStyle(document.querySelector('.attention-overlay')).display === 'block'));
  await page.evaluate(() => window.WriteSysAttention.rebuild()); // a re-render
  check('pin survives a rebuild (overlays shown, button still pressed)', await page.evaluate(() =>
    document.documentElement.classList.contains('attention-held')
    && getComputedStyle(document.querySelector('.attention-overlay')).display === 'block')
    && (await pressed()) === 'true');
  await page.click('#stats-attention');
  await page.waitForFunction(() => !document.documentElement.classList.contains('attention-held'));
  check('second click releases', (await pressed()) === 'false');
  // Losing the action while pinned drops the pin with the overlays.
  await page.click('#stats-attention');
  await page.waitForFunction(() => document.documentElement.classList.contains('attention-held'));
  const denied = await page.evaluate(() => {
    window.currentSession = { accessible_manuscripts: [{ manuscript_id: 1, actions: ['see-manuscript'] }] };
    window.WriteSysAttention.rebuild();
    const r = { held: document.documentElement.classList.contains('attention-held'),
      pinned: window.WriteSysAttention.pinned };
    window.currentSession = window.__saved;
    window.WriteSysAttention.rebuild();
    return r;
  });
  check('gate denied while pinned → pin dropped, overlays hidden', !denied.held && !denied.pinned, JSON.stringify(denied));

  // Pending state: before the overlays exist the button renders disabled
  // (spinner); the ms:attention-rebuilt dispatch flips it live in place.
  const pending = await page.evaluate(() => {
    window.WriteSysAttention.teardown();
    window.WriteSysStats.render();
    const b1 = document.getElementById('stats-attention');
    const wasDisabled = !!(b1 && b1.disabled);
    window.WriteSysAttention.rebuild(); // synchronous event → stats re-render
    const b2 = document.getElementById('stats-attention');
    return { wasDisabled, enabledAfter: !!(b2 && !b2.disabled) };
  });
  check('button disabled while overlays are pending', pending.wasDisabled);
  check('ms:attention-rebuilt enables the button', pending.enabledAfter);
  const gated = await page.evaluate(() => {
    window.currentSession = { accessible_manuscripts: [{ manuscript_id: 1, actions: ['see-manuscript'] }] };
    window.WriteSysStats.render();
    return !document.getElementById('stats-attention');
  });
  check('no see-attention → no stats button', gated);
  await page.evaluate(() => { window.currentSession = window.__saved; });

  // ---- Suggested edits: the envelope follows the EFFECTIVE text -------
  // A suggestion swaps sentence 3's +10 #vivid for the −15 #digression.
  // The rendered diff carries BOTH markers (struck old, green new); only
  // the added one may fire. Winner per sentence = accepted, else the
  // People-order first — the top person in the People tab.
  const sug = await page.evaluate(async () => {
    const R = window.WriteSysRenderer;
    const S = window.WriteSysSuggestions;
    const A = window.WriteSysAttention;
    const s3 = R.sentenceMap['att-3'];
    const swapped = s3.replace('&marker#vivid', '&marker#digression');
    const rerender = async () => {
      const before = document.body.dataset.paginated;
      S.rebuildMaps();
      await R.renderManuscript();
      // The afterRendered hook bumps data-paginated, then rebuilds the
      // overlays in the same tick — wait for the bump.
      await new Promise((res) => {
        const tick = () => (document.body.dataset.paginated !== before ? res() : setTimeout(tick, 50));
        tick();
      });
      return A._harvest().markers.map((m) => m.v);
    };
    const saved = { rows: S.rows, viewer: S.viewer, rank: S.peopleRank };
    S.viewer = 'test';
    // Two people suggest on sentence 3: alice swaps the marker, bob only
    // rewords. People order decides which one the page shows.
    S.rows = [
      { sentence_id: 'att-3', user_id: 'alice', text: swapped },
      { sentence_id: 'att-3', user_id: 'bob', text: s3.replace('carries', 'still carries') },
    ];
    S.peopleRank = { bob: 0, alice: 1 };
    const bobOnTop = await rerender();
    S.peopleRank = { alice: 0, bob: 1 };
    const aliceOnTop = await rerender();
    const dom = {
      struck: !!document.querySelector('.pagedjs_pages .cmd-diamond-removed[data-kind="marker"][data-slug="vivid"][data-diff="removed"]'),
      added: !!document.querySelector('.pagedjs_pages .cmd-diamond-added[data-kind="marker"][data-slug="digression"][data-diff="added"]'),
    };
    // An ACCEPTED suggestion beats People order.
    S.rows[1].review_status = 'accepted';
    const bobAccepted = await rerender();
    delete S.rows[1].review_status;
    // Without manage-suggestions (an alpha-reader) the diff shows no
    // glyph, yet the added marker still shapes the envelope.
    window.currentSession = {
      ...window.__saved,
      accessible_manuscripts: (window.__saved.accessible_manuscripts || []).map((m) => ({
        ...m, actions: ['see-manuscript', 'see-attention', 'see-others-edits'],
      })),
    };
    const alphaReader = await rerender();
    const alphaDom = {
      glyphs: document.querySelectorAll('.pagedjs_pages .cmd-diamond-added, .pagedjs_pages .cmd-diamond-removed').length,
      invisibleAdded: !!document.querySelector('.pagedjs_pages .inline-cmd[data-kind="marker"][data-slug="digression"][data-diff="added"]'),
    };
    window.currentSession = window.__saved;
    S.rows = saved.rows; S.viewer = saved.viewer; S.peopleRank = saved.rank;
    const restored = await rerender();
    return { bobOnTop, aliceOnTop, dom, bobAccepted, alphaReader, alphaDom, restored };
  });
  const vals = (a) => JSON.stringify(a);
  check('People order: bob (reword only) on top → committed +10 still fires',
    vals(sug.bobOnTop) === '[10,-15]', vals(sug.bobOnTop));
  check('People order: alice (marker swap) on top → suggested −15 fires, struck +10 does not',
    vals(sug.aliceOnTop) === '[-15,-15]', vals(sug.aliceOnTop));
  check('diff carries both markers with data-diff (struck one present but skipped)',
    sug.dom.struck && sug.dom.added, JSON.stringify(sug.dom));
  check('accepted suggestion beats People order', vals(sug.bobAccepted) === '[10,-15]', vals(sug.bobAccepted));
  check('no manage-suggestions → no diff glyph, added marker still fires',
    vals(sug.alphaReader) === '[-15,-15]' && sug.alphaDom.glyphs === 0 && sug.alphaDom.invisibleAdded,
    `${vals(sug.alphaReader)} ${JSON.stringify(sug.alphaDom)}`);
  check('suggestions withdrawn → committed markers again', vals(sug.restored) === '[10,-15]', vals(sug.restored));

  await browser.close();
  console.log('');
  if (failed) { console.log(`❌ ${failed} check(s) failed`); process.exit(1); }
  console.log('✅ attention e2e: all checks pass');
})().catch((e) => { console.error(e); process.exit(1); });
