// Scratchpad + Canonize end-to-end (SCRATCHPAD_PLAN.md): create a scratchpad,
// add a book-content block (monospace text), canonize it into the test
// manuscript from the book view's + affordance, verify the ONE suggested
// edit renders as anchor + content + (hidden) end in the book, and that the
// scratchpad widget flips to a canonized Live view resolved from the
// effective manuscript, with the As-canonized snapshot tab intact.
const { chromium } = require('playwright');
const {
  TEST_URL,
  cleanupTestAnnotations, loginAsTestUser,
  waitForPagination, paginationStamp, waitForRepagination,
} = require('./test-utils');

const HOME_URL = new URL('home.html', TEST_URL).href;

(async () => {
  console.log('=== scratchpad + canonize e2e ===\n');
  let failed = 0;
  const check = (name, ok, detail = '') => {
    console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` (${detail})` : ''}`);
    if (!ok) failed++;
  };

  await cleanupTestAnnotations();

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1400, height: 1200 });
  page.on('dialog', async d => { try { await d.accept(); } catch (e) {} });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));

  let padId = null;
  let boundaryId = null;
  const SLUG = 'e2e-keg';
  const BLOCK_TEXT = 'The keg arrived at noon. Nobody signed for it.\n\n\tBy dusk the yard was full.';

  try {
    await loginAsTestUser(page);

    // --- home page: create a pad (opens THE modal), add a block, autosave ---
    await page.goto(HOME_URL);
    await page.waitForSelector('#home-new-pad', { timeout: 20000 });
    await page.click('#home-new-pad');
    await page.waitForSelector('.spm-overlay .ProseMirror', { timeout: 20000 });
    const hash = await page.evaluate(() => window.location.hash);
    padId = parseInt((hash.match(/scratchpad=(\d+)/) || [])[1], 10);
    check('pad created + modal editor loaded (hash carries id)', Number.isInteger(padId), `id ${padId}`);

    await page.fill('#spm-title', 'E2E pad');
    await page.evaluate(() => window.WriteSysScratchpad.insertBookContent());
    await page.waitForSelector('.bc-widget .bc-text', { timeout: 5000 });
    await page.fill('.bc-widget .bc-text', BLOCK_TEXT);
    await page.locator('.bc-widget .bc-text').blur();
    await page.waitForFunction(() => document.querySelector('#spm-status').textContent === 'Saved', null, { timeout: 10000 });
    check('block text autosaved', true);

    // Preview tab renders through the book pipeline (shadow root).
    await page.click('.bc-widget [data-tab="preview"]');
    const previewText = await page.evaluate(() => {
      const host = document.querySelector('.bc-widget .bc-render');
      return host && host.shadowRoot ? host.shadowRoot.textContent : '';
    });
    check('draft Preview renders book-style', /keg arrived at noon/.test(previewText));

    // Table + image machinery smoke checks. Selection sits ON the freshly
    // inserted book_content atom — park it at doc end first so the image
    // insert (replaceSelectionWith) can't swallow the block.
    await page.evaluate(() => {
      const sp = window.WriteSysScratchpad;
      const { table, table_row, table_cell } = sp.schema.nodes;
      const cell = () => table_cell.createAndFill();
      const rows = [0, 1].map(() => table_row.create(null, [cell(), cell()]));
      sp.view.dispatch(sp.view.state.tr.insert(0, table.create(null, rows)));
      const st = sp.view.state;
      sp.view.dispatch(st.tr.setSelection(sp.pm.Selection.atEnd(st.doc)));
    });
    check('table inserted', await page.locator('.ProseMirror table').count() === 1);
    // 1x1 transparent PNG.
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    await page.setInputFiles('#spm-image-input', { name: 'dot.png', mimeType: 'image/png', buffer: png });
    await page.waitForSelector('.ProseMirror img.scratch-image', { timeout: 10000 });
    const imgOk = await page.evaluate(async () => {
      const img = document.querySelector('.ProseMirror img.scratch-image');
      const r = await fetch(img.getAttribute('src'));
      return r.ok && (r.headers.get('content-type') || '').startsWith('image/');
    });
    check('image uploaded and served', imgOk === true);
    await page.waitForFunction(() => document.querySelector('#spm-status').textContent === 'Saved', null, { timeout: 10000 });

    // --- book view: canonize via the + affordance ---
    await page.goto(TEST_URL);
    await page.waitForSelector('.sentence', { timeout: 30000 });
    await page.waitForSelector('.import-zone .import-tab', { timeout: 15000 });
    await page.evaluate(() => document.querySelector('.import-zone .import-tab').click());
    await page.waitForSelector('#import-modal', { timeout: 5000 });
    await page.selectOption('#im-pad', String(padId));
    await page.waitForSelector('input[name="im-block"]', { timeout: 10000 });
    await page.check('input[name="im-block"]');
    await page.fill('#im-slug', SLUG);
    await page.fill('#im-label', 'Keg Party');
    const stamp = await paginationStamp(page);
    await page.click('#im-go');
    await page.waitForSelector('#import-modal', { state: 'detached', timeout: 20000 });
    check('canonize modal completed', true);
    await waitForRepagination(page, stamp); // suggestion re-render completed
    const book = await page.evaluate((slug) => {
      const anchor = document.querySelector(`.pagedjs_pages .cmd-anchor[data-slug="${slug}"], .pagedjs_pages .inline-anchor[data-slug="${slug}"]`);
      const end = document.querySelector(`.pagedjs_pages .cmd-end[data-slug="${slug}"]`);
      const content = Array.from(document.querySelectorAll('.pagedjs_pages .sentence'))
        .some(s => /keg arrived at noon/i.test(s.textContent));
      const outlineRow = Array.from(document.querySelectorAll('.outline-item.outline-anchor'))
        .find(n => /Keg Party/.test(n.textContent));
      return {
        anchorFound: !!anchor,
        endFound: !!end,
        endVisibleWhileSuggested: end ? !end.hidden : false,
        content,
        outlineRow: !!outlineRow,
      };
    }, SLUG);
    check('anchor renders in book (suggested)', book.anchorFound);
    check('anchor label lists in the outline', book.outlineRow);
    check('imported prose renders in book', book.content === true);
    check('&end present, visible as blue marker while suggested', book.endFound && book.endVisibleWhileSuggested);

    const boundary = await page.evaluate((slug) => {
      const anchor = document.querySelector(`.pagedjs_pages .cmd-anchor[data-slug="${slug}"] .sentence`);
      return anchor ? anchor.dataset.sentenceId : null;
    }, SLUG);
    boundaryId = boundary;
    check('one suggestion carries the region (anchor shares boundary sentence id)', !!boundaryId, boundaryId);

    // --- widget via URL hash restore: canonized state, Live + snapshot ---
    await page.goto(`${HOME_URL}#scratchpad=${padId}`);
    await page.waitForSelector('.spm-overlay .bc-widget', { timeout: 20000 });
    await page.waitForFunction(() => {
      const el = document.querySelector('.bc-widget .bc-status');
      return el && /canonized|#/.test(el.textContent) && el.classList.contains('bc-canonized');
    }, null, { timeout: 10000 });
    check('widget shows canonized status', true);
    await page.waitForFunction(() => {
      const host = document.querySelector('.bc-widget .bc-render');
      return host && host.shadowRoot && /keg arrived at noon/i.test(host.shadowRoot.textContent);
    }, null, { timeout: 15000 });
    check('Live view resolves region from effective manuscript', true);
    const note = await page.evaluate(() => document.querySelector('.bc-widget .bc-note').textContent);
    check('Live note confirms effective source', /effective manuscript/i.test(note), note);

    await page.click('.bc-widget [data-tab="snapshot"]');
    const snap = await page.evaluate(() => {
      const host = document.querySelector('.bc-widget .bc-render');
      return host && host.shadowRoot ? host.shadowRoot.textContent : '';
    });
    check('As-canonized snapshot preserved', /keg arrived at noon/i.test(snap));

    check('no page errors', errs.length === 0, errs.slice(0, 3).join('; '));
  } finally {
    try {
      const csrf = await page.evaluate(() => sessionStorage.getItem('csrf_token'));
      if (boundaryId) {
        await page.evaluate(async ({ id, csrf }) => {
          await fetch(`api/sentences/${id}/suggestion`, { method: 'DELETE', headers: { 'X-CSRF-Token': csrf } });
        }, { id: boundaryId, csrf });
      }
      if (padId) {
        await page.evaluate(async ({ id, csrf }) => {
          await fetch(`api/scratchpads/${id}`, { method: 'DELETE', headers: { 'X-CSRF-Token': csrf } });
        }, { id: padId, csrf });
      }
    } catch (e) { /* best effort */ }
    await cleanupTestAnnotations();
    await browser.close();
  }

  console.log(failed === 0 ? '\n✅ Test passed' : `\n❌ ${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(err => { console.error('Test crashed:', err); process.exit(1); });
