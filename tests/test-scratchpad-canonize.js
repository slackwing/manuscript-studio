// Variations + Canonize end-to-end (VARIATIONS_PLAN.md): create a pad and a
// sketch (variation A), write via the preview-first click-to-edit widget,
// link/unlink the GROUP, branch variation B (freezing A), then dub B canon
// from the book view's + affordance — one suggested edit wrapping B's text
// in &sketch#<id>{label} … &end#<id> (&snippet# stays a legacy alias).
// Verify the region renders in the
// book (anchor-like marker + outline label), and that the widgets show the
// parent/child letter tabs, the snowflake freeze state, and the blue Canon
// tab that live-resolves from the effective manuscript with the
// as-canonized snapshot behind an in-body toggle.
//
// Also uploads a >1MiB image — regression guard for the global body cap.
const { chromium } = require('playwright');
const zlib = require('zlib');
const {
  TEST_URL,
  cleanupTestAnnotations, loginAsTestUser,
  waitForPagination, paginationStamp, waitForRepagination,
} = require('./test-utils');

const HOME_URL = new URL('home.html', TEST_URL).href;

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

(async () => {
  console.log('=== variations + canonize e2e ===\n');
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
  let sketchId = null;
  let varA = null;
  let varB = null;
  const BLOCK_TEXT = 'The keg arrived at noon. Nobody signed for it.\n\n\tBy dusk the yard was full.';

  try {
    await loginAsTestUser(page);

    // --- home page: create a pad (opens THE modal), insert variation A ---
    await page.goto(HOME_URL);
    await page.waitForSelector('#home-new-pad', { timeout: 20000 });
    await page.click('#home-new-pad');
    await page.waitForSelector('.spm-overlay .ProseMirror', { timeout: 20000 });
    const hash = await page.evaluate(() => window.location.hash);
    padId = parseInt((hash.match(/scratchpad=(\d+)/) || [])[1], 10);
    check('pad created + modal editor loaded (hash carries id)', Number.isInteger(padId), `id ${padId}`);

    await page.fill('#spm-title', 'E2E pad');
    const ctxA = await page.evaluate(() => window.WriteSysScratchpad.insertSketch());
    varA = ctxA.variation.variation_id;
    sketchId = ctxA.sketch.sketch_id;
    check('sketch group + variation A created', ctxA.variation.ordinal === 1 && /^[a-z0-9]{10}$/.test(sketchId), `#${sketchId}`);

    // Preview-first: fresh variation shows its (empty) preview; a single
    // click flips into the monospace editor; blur returns to preview.
    await page.waitForSelector('.sn-widget .sn-render .sn-empty', { timeout: 10000 });
    const draftStatus = await page.textContent('.sn-widget .sn-status');
    check('status reads Sketch · A · draft', /Sketch · A · draft/.test(draftStatus), draftStatus.trim());
    await page.click('.sn-widget .sn-render');
    await page.waitForSelector('.sn-widget .sn-text', { timeout: 5000 });
    await page.fill('.sn-widget .sn-text', BLOCK_TEXT);
    await page.locator('.sn-widget .sn-text').blur();
    await page.waitForFunction(() => {
      const host = document.querySelector('.sn-widget .sn-render');
      return host && host.shadowRoot && /keg arrived at noon/i.test(host.shadowRoot.textContent);
    }, null, { timeout: 10000 });
    check('variation text autosaved; preview renders book-style after blur', true);

    // --- link / unlink the GROUP via the SHARED chip (manuscript-chip.js) ---
    await page.click('.sn-widget .sn-linkchip.unlinked'); // icon-only circle
    await page.waitForSelector('.note-linkpop button[data-mid]', { timeout: 5000 });
    await page.click('.note-linkpop button[data-mid]');
    await page.waitForSelector('.sn-widget .sn-linkchip.linked', { timeout: 5000 });
    // Icon-only chip: the manuscript name reveals on hover (title attr).
    const chipName = await page.getAttribute('.sn-widget .sn-linkchip.linked', 'title');
    check('link picker links the group (chip shows name)', !!chipName.trim(), chipName.trim());
    await page.click('.sn-widget .sn-linkchip.linked'); // picker holds the unlink row now
    await page.waitForSelector('.note-linkpop .note-linkpop-unlink', { timeout: 5000 });
    await page.click('.note-linkpop .note-linkpop-unlink');
    await page.waitForSelector('.sn-widget .sn-linkchip.unlinked', { timeout: 5000 });
    check('chip × unlinks (bare chip back)', true);

    // --- image machinery: >1MiB PNG (old body cap regression) ---
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

    // --- based on: variation B is a NEW SIBLING of A (text copied, A untouched,
    // no lineage) ---
    const ctxB = await page.evaluate((src) => window.WriteSysScratchpad.insertVariationOf(src), varA);
    varB = ctxB.variation.variation_id;
    check('variation B minted from A (next letter, text copied, no parent)',
      ctxB.variation.ordinal === 2 && ctxB.variation.text.includes('keg arrived')
      && ctxB.variation.parent_variation_id === undefined);
    await page.waitForFunction(() => document.querySelectorAll('.sn-widget').length === 2, null, { timeout: 10000 });
    const bWidget = page.locator(`.sn-widget[data-variation-id="${varB}"]`);

    // B's rail: B on top (its own variation), then A below (no label).
    await bWidget.locator('.sn-rail-self').waitFor({ timeout: 10000 });
    check('B letter on top of the rail (self)', (await bWidget.locator('.sn-rail-self').textContent()).trim() === 'B');
    check('rail lists sibling A (no label)',
      (await bWidget.locator('.sn-rail-peer').allTextContents()).join('').includes('A'));

    // Click A's sibling tab → read-only PEER preview with navigate-to-source.
    await bWidget.locator('.sn-rail-peer', { hasText: 'A' }).first().click(); // split compare
    await page.waitForFunction((vid) => {
      const w = document.querySelector(`.sn-widget[data-variation-id="${vid}"]`);
      const host = w && w.querySelector('.sn-render.sn-peer');
      return host && host.shadowRoot && /keg arrived/i.test(host.shadowRoot.textContent);
    }, varB, { timeout: 10000 });
    check('sibling tab shows A read-only (peer preview)', true);
    check('peer preview offers navigate-to-source (split-header ↗)',
      await bWidget.locator('.sn-head-right .sn-goto-ext').count() === 1);

    // A was NOT frozen by the based-on (siblings don't freeze sources).
    await page.waitForFunction(() => document.querySelector('#spm-status').textContent === 'Saved', null, { timeout: 10000 });
    const aWidget = page.locator(`.sn-widget[data-variation-id="${varA}"]`);
    check('A stays editable (not frozen by based-on)', await aWidget.locator('.sn-freeze.pressed').count() === 0);

    // --- book view: canonize B via the + affordance ---
    await page.goto(TEST_URL);
    await page.waitForSelector('.sentence', { timeout: 30000 });
    await page.waitForSelector('.import-zone .import-tab', { timeout: 15000 });
    await page.evaluate(() => document.querySelector('.import-zone .import-tab').click());
    await page.waitForSelector('#import-modal', { timeout: 5000 });
    await page.waitForSelector('input[name="im-block"]', { timeout: 10000 });
    const picked = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('.im-block'));
      const b = rows.find(r => r.querySelector('.im-block-letter').textContent === 'B');
      if (!b) return false;
      b.querySelector('input').click();
      return true;
    });
    check('canonize modal lists variations; B picked', picked === true);
    await page.fill('#im-label', 'Keg Party');
    const stamp = await paginationStamp(page);
    await page.click('#im-go');
    await page.waitForSelector('#import-modal', { state: 'detached', timeout: 20000 });
    check('canonize modal completed', true);
    await waitForRepagination(page, stamp);
    const book = await page.evaluate((sid) => {
      const opener = document.querySelector(`.pagedjs_pages .cmd-anchor-glyph[data-slug="${sid}"], .pagedjs_pages .inline-anchor[data-slug="${sid}"]`);
      // Trailing &end tokens are stripped from the render entirely (they
      // exist only in the raw text) — assert nothing &end-shaped is VISIBLE.
      const endVisible = Array.from(document.querySelectorAll('.pagedjs_pages *'))
        .some(n => n.children.length === 0 && /&end#/.test(n.textContent) &&
                   n.offsetParent !== null && !n.hidden);
      const content = Array.from(document.querySelectorAll('.pagedjs_pages .sentence'))
        .some(s => /keg arrived at noon/i.test(s.textContent));
      const outlineRow = Array.from(document.querySelectorAll('.outline-item.outline-anchor'))
        .find(n => /Keg Party/.test(n.textContent));
      return {
        openerFound: !!opener,
        endVisibleWhileSuggested: endVisible,
        content,
        outlineRow: !!outlineRow,
      };
    }, sketchId);
    check('&snippet region opener renders in book (suggested)', book.openerFound);
    check('sketch label lists in the outline', book.outlineRow);
    check('canonized prose renders in book', book.content === true);
    check('&end NEVER visible in the book (raw-text only)', !book.endVisibleWhileSuggested);

    const boundary = await page.evaluate((sid) => {
      const opener = document.querySelector(`.pagedjs_pages .cmd-anchor-glyph[data-slug="${sid}"]`);
      if (!opener) return null;
      const host = opener.dataset.sentenceId ? opener : opener.closest('.sentence');
      return host ? host.dataset.sentenceId : null;
    }, sketchId);
    boundaryId = boundary;
    check('one suggestion carries the region', !!boundaryId, boundaryId);

    // --- widgets after canonize: Canon tab everywhere, blue state ---
    await page.goto(`${HOME_URL}#scratchpad=${padId}`);
    await page.waitForFunction(() => document.querySelectorAll('.sn-widget .sn-rail-canon').length === 2, null, { timeout: 20000 });
    check('Canon tab appears on BOTH variations of the group', true);
    check('canonized group wears the leather state', await page.locator('.sn-widget.sn-canon').count() === 2);

    // Canon tab: live view resolves the region from the effective manuscript.
    await page.locator(`.sn-widget[data-variation-id="${varB}"] .sn-rail-canon`).click();
    await page.waitForFunction(() => {
      const notes = Array.from(document.querySelectorAll('.sn-widget .sn-note'));
      const live = notes.find(n => /effective manuscript/i.test(n.textContent));
      if (!live) return false;
      const host = live.parentElement.querySelector('.sn-render');
      return host && host.shadowRoot && /keg arrived at noon/i.test(host.shadowRoot.textContent);
    }, null, { timeout: 15000 });
    check('Canon tab live-resolves region from effective manuscript', true);

    // In-body toggle to the as-canonized snapshot.
    await page.click('.sn-canonswap');
    await page.waitForFunction(() => {
      const note = Array.from(document.querySelectorAll('.sn-widget .sn-note'))
        .find(n => /As canonized/i.test(n.textContent));
      if (!note) return false;
      const host = note.parentElement.querySelector('.sn-render');
      return host && host.shadowRoot && /keg arrived at noon/i.test(host.shadowRoot.textContent);
    }, null, { timeout: 10000 });
    check('as-canonized snapshot behind the in-body toggle', true);

    // Canonized group's link chip is permanent (no unlink ×).
    const linkState = await page.evaluate(() => ({
      chips: document.querySelectorAll('.sn-widget .sn-linkchip').length,
      unlinks: document.querySelectorAll('.sn-widget .sn-unlink').length,
    }));
    check('canonize auto-linked the group (chips, no unlink ×)',
      linkState.chips === 2 && linkState.unlinks === 0, JSON.stringify(linkState));

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
