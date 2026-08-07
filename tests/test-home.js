// Landing page + global search + THE scratchpad modal (HOME_PLAN.md):
// cards render, search finds manuscripts (navigate) and scratchpads (modal),
// only one modal at a time, and #scratchpad=N restores across reload.
// Replaces test-manuscript-picker (the dropdown died with the redesign).
const { chromium } = require('playwright');
const {
  TEST_URL, TEST_MANUSCRIPT_NAME,
  cleanupTestAnnotations, loginAsTestUser,
} = require('./test-utils');

// Cards show the human display name (config slug prettified as fallback).
const DISPLAY_NAME = TEST_MANUSCRIPT_NAME.split('-')
  .map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

const HOME_URL = new URL('home.html', TEST_URL).href;

(async () => {
  console.log('=== home page + search + modal ===\n');
  let failed = 0;
  const check = (name, ok, detail = '') => {
    console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` (${detail})` : ''}`);
    if (!ok) failed++;
  };

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1400, height: 1000 });
  page.on('dialog', async d => { try { await d.accept(); } catch (e) {} });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  const pads = [];

  try {
    await loginAsTestUser(page);
    await page.goto(HOME_URL);
    await page.waitForSelector('.home-section', { timeout: 20000 });

    // --- cards ---
    const cards = await page.evaluate((name) => ({
      sections: document.querySelectorAll('.home-section').length,
      manuscriptCard: !!Array.from(document.querySelectorAll('.card-manuscript .card-title'))
        .find(t => t.textContent === name),
      homeLink: (document.getElementById('home-link') || {}).getAttribute
        ? document.getElementById('home-link').getAttribute('href') : null,
      brandLink: document.getElementById('brand').getAttribute('href'),
    }), DISPLAY_NAME);
    check('three card sections render (Manuscripts / Scratchpads / Notes)', cards.sections === 3, String(cards.sections));
    check('test manuscript card present', cards.manuscriptCard);
    check('home icon and wordmark both link home',
      cards.homeLink === 'home.html' && cards.brandLink === 'home.html');

    // --- create pad via + New (opens the modal) ---
    await page.click('#home-new-pad');
    await page.waitForSelector('.spm-overlay .ProseMirror', { timeout: 20000 });
    const pad1 = parseInt(((await page.evaluate(() => location.hash)).match(/=(\d+)/) || [])[1], 10);
    pads.push(pad1);
    await page.fill('#spm-title', 'SearchMe42');
    await page.waitForFunction(() => document.querySelector('#spm-status').textContent !== 'Saved', null, { timeout: 5000 });
    await page.waitForFunction(() => document.querySelector('#spm-status').textContent === 'Saved', null, { timeout: 10000 });
    await page.click('#spm-close');
    await page.waitForSelector('.spm-overlay', { state: 'detached', timeout: 10000 });
    check('modal closes and clears the URL hash',
      await page.evaluate(() => location.hash === ''));
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll('.card-scratchpad .card-title'))
        .some(t => t.textContent === 'SearchMe42'), null, { timeout: 10000 });
    check('new pad card appears after close (title saved)', true);
    // The pad card's preview must wear its clamped small-serif style — the
    // class emitted by home.js and the rule in home.css drifted apart once
    // (rename fallout) and previews blew up to full-size body text.
    const previewStyle = await page.evaluate(() => {
      const el = document.querySelector('.card-scratchpad .card-sketch');
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { size: cs.fontSize, clamp: cs.webkitLineClamp, overflow: cs.overflow };
    });
    check('pad preview styled (12px, clamped)',
      !!previewStyle && previewStyle.size === '12px' && String(previewStyle.clamp) === '6' && previewStyle.overflow === 'hidden',
      JSON.stringify(previewStyle));

    // --- search: manuscript navigates ---
    await page.fill('#gs-input', TEST_MANUSCRIPT_NAME.slice(0, 6));
    await page.waitForSelector('.gs-item', { timeout: 10000 });
    const kinds = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.gs-item .gs-kind')).map(k => k.textContent));
    check('search lists the manuscript', kinds.includes('Book'), kinds.join(','));
    await page.click('.gs-item');
    await page.waitForSelector('.sentence', { timeout: 30000 });
    check('picking a manuscript opens it', /manuscript_id=/.test(page.url()), page.url());

    // --- search from the BOOK page: scratchpad opens the modal here too ---
    await page.fill('#gs-input', 'SearchMe42');
    await page.waitForSelector('.gs-item', { timeout: 10000 });
    await page.click('.gs-item');
    await page.waitForSelector('.spm-overlay .ProseMirror', { timeout: 20000 });
    const overBook = await page.evaluate(() => ({
      title: document.querySelector('#spm-title').value,
      overlays: document.querySelectorAll('.spm-overlay').length,
      stillOnBook: /manuscript_id=/.test(location.search),
    }));
    check('scratchpad modal opens OVER the manuscript', overBook.stillOnBook && overBook.title === 'SearchMe42');
    check('exactly one modal', overBook.overlays === 1);

    // --- single-modal invariant: opening another replaces it ---
    const pad2 = await page.evaluate(async () => {
      const r = await fetch('api/scratchpads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': sessionStorage.getItem('csrf_token') },
        body: JSON.stringify({ title: 'SecondPad' }),
      });
      return (await r.json()).scratchpad_id;
    });
    pads.push(pad2);
    await page.evaluate((id) => window.WriteSysScratchpadModal.open(id), pad2);
    await page.waitForFunction(() =>
      document.querySelector('#spm-title') && document.querySelector('#spm-title').value === 'SecondPad',
      null, { timeout: 15000 });
    const single = await page.evaluate(() => document.querySelectorAll('.spm-overlay').length);
    check('opening another pad replaces the modal (still one)', single === 1);

    // --- hash restore across reload ---
    await page.reload();
    await page.waitForSelector('.spm-overlay .ProseMirror', { timeout: 20000 });
    check('reload restores the open pad from #scratchpad=N',
      await page.evaluate(() => document.querySelector('#spm-title').value === 'SecondPad'));

    check('no page errors', errs.length === 0, errs.slice(0, 3).join('; '));
  } finally {
    try {
      const csrf = await page.evaluate(() => sessionStorage.getItem('csrf_token'));
      for (const id of pads) {
        await page.evaluate(async ({ id, csrf }) => {
          await fetch(`api/scratchpads/${id}`, { method: 'DELETE', headers: { 'X-CSRF-Token': csrf } });
        }, { id, csrf });
      }
    } catch (e) { /* best effort */ }
    await cleanupTestAnnotations();
    await browser.close();
  }

  console.log(failed === 0 ? '\n✅ Test passed' : `\n❌ ${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(err => { console.error('Test crashed:', err); process.exit(1); });
