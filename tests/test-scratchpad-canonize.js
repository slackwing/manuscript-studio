// Scratchpad + Canonize end-to-end (SCRATCHPAD_PLAN.md): create a scratchpad,
// add a snippet (preview-first widget; click flips it into the monospace
// editor), canonize it into the test manuscript from the book view's +
// affordance, verify the ONE suggested edit renders as anchor + content +
// (hidden) end in the book, and that the scratchpad widget flips to a
// Canon Live view resolved from the effective manuscript, with the
// As-canonized snapshot tab intact. Also uploads a >1MiB image — a
// regression guard for the global request-body cap that used to truncate
// multipart uploads ("Invalid multipart form").
const { chromium } = require('playwright');
const zlib = require('zlib');

// A real, valid PNG of random noise (incompressible → ~w*h*4 bytes) to
// exercise the raised body limit on api/scratchpad-images.
function noisyPng(w, h) {
  const CRC_TABLE = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    CRC_TABLE[n] = c >>> 0;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    const row = raw.subarray(y * (1 + w * 4) + 1, (y + 1) * (1 + w * 4));
    for (let i = 0; i < row.length; i++) row[i] = (Math.random() * 256) | 0;
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 0 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
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
    await page.evaluate(() => window.WriteSysScratchpad.insertSnippet());
    // Preview-first: a fresh draft shows its (empty) preview; a single
    // click flips it into the monospace editor.
    await page.waitForSelector('.sn-widget .sn-render .sn-empty', { timeout: 5000 });
    const draftStatus = await page.textContent('.sn-widget .sn-status');
    check('draft status reads Manuscript Snippet · draft', /Manuscript Snippet · draft/.test(draftStatus), draftStatus);
    await page.click('.sn-widget .sn-render');
    await page.waitForSelector('.sn-widget .sn-text', { timeout: 5000 });
    await page.fill('.sn-widget .sn-text', BLOCK_TEXT);
    await page.locator('.sn-widget .sn-text').blur();
    await page.waitForFunction(() => document.querySelector('#spm-status').textContent === 'Saved', null, { timeout: 10000 });
    check('snippet text autosaved', true);

    // Blur returns the widget to preview, rendered through the book
    // pipeline (shadow root).
    await page.waitForSelector('.sn-widget .sn-render', { timeout: 5000 });
    const previewText = await page.evaluate(() => {
      const host = document.querySelector('.sn-widget .sn-render');
      return host && host.shadowRoot ? host.shadowRoot.textContent : '';
    });
    check('draft preview renders book-style after blur', /keg arrived at noon/.test(previewText));

    // Table + image machinery smoke checks. Selection sits ON the freshly
    // inserted snippet atom — park it at doc end first so the image
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
    // >1MiB PNG: would have been truncated by the old global body cap.
    const png = noisyPng(840, 840);
    check('test image exceeds the old 1MiB cap', png.length > (1 << 20), `${png.length} bytes`);
    await page.setInputFiles('#spm-image-input', { name: 'big.png', mimeType: 'image/png', buffer: png });
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
    await page.waitForSelector('.spm-overlay .sn-widget', { timeout: 20000 });
    await page.waitForFunction(() => {
      const el = document.querySelector('.sn-widget .sn-status');
      return el && /Canon · #/.test(el.textContent) && el.classList.contains('sn-canonized');
    }, null, { timeout: 10000 });
    check('widget shows Canon status', true);
    const canonBlue = await page.evaluate(() =>
      document.querySelector('.sn-widget').classList.contains('sn-canon'));
    check('canonized widget wears the blue bar', canonBlue === true);
    await page.waitForFunction(() => {
      const host = document.querySelector('.sn-widget .sn-render');
      return host && host.shadowRoot && /keg arrived at noon/i.test(host.shadowRoot.textContent);
    }, null, { timeout: 15000 });
    check('Live view resolves region from effective manuscript', true);
    const note = await page.evaluate(() => document.querySelector('.sn-widget .sn-note').textContent);
    check('Live note confirms effective source', /effective manuscript/i.test(note), note);

    await page.click('.sn-widget [data-tab="snapshot"]');
    const snap = await page.evaluate(() => {
      const host = document.querySelector('.sn-widget .sn-render');
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
