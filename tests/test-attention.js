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
      green: paths[0], red: paths[1], curve: paths[2],
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
  check('negative attention dips left of the sheet edge (into the gutter)',
    info.anyNegative);
  check('clipped to the first line of text (plot starts at its top edge)',
    Math.abs(info.startY - info.firstLineTop) < 6,
    `start=${info.startY} firstLine=${info.firstLineTop}`);

  // The +10 marker's swell: the curve's widest point on page 1 sits at or
  // below the marker's line (attack peaks a few words AFTER the impulse).
  const align = await page.evaluate(() => {
    const svg = document.querySelector('.attention-overlay');
    const page0 = svg.closest('.pagedjs_page');
    const pr = page0.getBoundingClientRect();
    const s = pr.width / page0.offsetWidth;
    const mk = document.querySelector('.pagedjs_pages .inline-cmd[data-kind="marker"], .pagedjs_pages .cmd-diamond-marker');
    const mr = (mk.getClientRects()[0] || mk.parentElement.getBoundingClientRect());
    const markerY = (mr.top - pr.top) / s;
    const d = svg.querySelectorAll('path')[2].getAttribute('d');
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

  // ---- stats-pane HOLD button (the touch counterpart of Tab) ----------
  await page.evaluate(() => { window.currentSession = window.__saved; window.WriteSysAttention.rebuild(); });
  await page.evaluate(() => window.WriteSysStats && window.WriteSysStats.setPane && window.WriteSysStats.setPane('stats'));
  await page.waitForSelector('#stats-attention', { timeout: 8000 });
  await page.dispatchEvent('#stats-attention', 'pointerdown');
  await page.waitForFunction(() => document.documentElement.classList.contains('attention-held'));
  check('holding the stats button reveals the overlays', true);
  await page.dispatchEvent('#stats-attention', 'pointerup');
  await page.waitForFunction(() => !document.documentElement.classList.contains('attention-held'));
  check('releasing the stats button hides them', true);
  const gated = await page.evaluate(() => {
    window.currentSession = { accessible_manuscripts: [{ manuscript_id: 1, actions: ['see-manuscript'] }] };
    window.WriteSysStats.render();
    return !document.getElementById('stats-attention');
  });
  check('no see-attention → no stats button', gated);
  await page.evaluate(() => { window.currentSession = window.__saved; });

  await browser.close();
  console.log('');
  if (failed) { console.log(`❌ ${failed} check(s) failed`); process.exit(1); }
  console.log('✅ attention e2e: all checks pass');
})().catch((e) => { console.error(e); process.exit(1); });
