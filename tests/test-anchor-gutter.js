// Gutter-glyph invariant: every margin anchor ⚓ sits FULLY off the page
// sheet, in the grey gutter to its left — in Chromium AND Firefox, across
// window widths. This exact bug shipped three times ("the anchor is ON the
// page"): positioning by calc() guesses (page margin, font metrics, box
// width) instead of measurement. layoutMarginGlyphs() now pins by measuring
// the sheet edge; this test is the tripwire.
const { chromium, firefox } = require('playwright');
const {TEST_USERNAME, TEST_URL, loginAsTestUser, waitForPagination, paginationStamp, waitForRepagination} = require('./test-utils');
const { execSync } = require('child_process');

const psql = (sql) => execSync(
  `PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`,
  { encoding: 'utf-8' }).trim();

let failures = 0;
function check(name, ok, extra) {
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ` (${JSON.stringify(extra)})` : ''}`);
  if (!ok) failures++;
}

// `browser` may be passed in to reuse one launch across widths (a fresh
// page/context per width keeps the load-at-width coverage identical).
async function runIn(browserType, name, width, browser) {
  const ownBrowser = !browser;
  if (ownBrowser) browser = await browserType.launch();
  const page = await browser.newPage({ viewport: { width, height: 950 } });
  try {
    await loginAsTestUser(page);
    await page.goto(`${TEST_URL}/index.html`);
    await waitForPagination(page, 60000);
    // Place the probe suggestion (no render yet).
    const id = await page.evaluate(async () => {
      const r = window.WriteSysRenderer;
      const spans = [...document.querySelectorAll('p .sentence[data-sentence-id]')];
      let target = null;
      for (const s of spans) {
        const sibs = s.parentElement.querySelectorAll('.sentence[data-sentence-id]');
        if (sibs.length >= 3 && s === sibs[sibs.length - 1] && s.parentElement.nextElementSibling) { target = s; break; }
      }
      const id = target.dataset.sentenceId;
      // Tight canonize form: trailing inline &sketch promoted to a margin
      // glyph on the (indented) region paragraph.
      const text = r.sentenceMap[id].replace(/\s+$/, '') +
        '\n&sketch#gutterprobe1{}\n\tGutter probe region paragraph.\n&end#gutterprobe1';
      const csrf = localStorage.getItem('csrf_token') || sessionStorage.getItem('csrf_token');
      await fetch(`api/sentences/${encodeURIComponent(id)}/suggestion`, { method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ text }) });
      await window.WriteSysSuggestions.loadForMigration(r.currentMigrationID);
      return id;
    });
    // Re-render with the probe; renderManuscript resolves after pagination +
    // layoutMarginGlyphs, and the repagination counter guards the swap.
    const stamp = await paginationStamp(page);
    await page.evaluate((sid) => window.WriteSysRenderer.renderManuscript({ anchorSentenceId: sid }), id);
    await waitForRepagination(page, stamp, 60000);
    // Probe glyph appearing is also an assertion below — timeout falls
    // through so the check reports the failure instead of crashing.
    await page.waitForSelector('.cmd-anchor-margin[data-slug="gutterprobe1"]', { timeout: 15000 }).catch(() => {});
    const m = await page.evaluate(async (sid) => {
      // Webfonts landing after pagination re-pin the glyphs (renderer chains
      // layoutMarginGlyphs on fonts.ready before this handler runs) — wait
      // for that before measuring.
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
      const results = [];
      document.querySelectorAll('.cmd-anchor-margin').forEach((el) => {
        const gr = el.getBoundingClientRect();
        const sheet = el.closest('.pagedjs_sheet') || el.closest('.pagedjs_page');
        const sr = sheet.getBoundingClientRect();
        const regionP = el.offsetParent;
        results.push({
          slug: el.dataset.slug || '',
          rightVsSheet: Math.round(gr.right - sr.left), // must be < 0
          visible: gr.width > 0 && gr.height > 0,
          regionCls: regionP ? regionP.className : '',
        });
      });
      // clean up so widths don't compound suggestions
      const csrf = localStorage.getItem('csrf_token') || sessionStorage.getItem('csrf_token');
      await fetch(`api/sentences/${encodeURIComponent(sid)}/suggestion`, { method: 'DELETE',
        headers: { 'X-CSRF-Token': csrf } }).catch(() => {});
      return results;
    }, id);
    const probe = m.find((g) => g.slug === 'gutterprobe1');
    check(`${name}@${width}: probe glyph rendered + visible`, !!probe && probe.visible, probe);
    if (probe) {
      check(`${name}@${width}: glyph FULLY off the sheet (right edge in gutter)`, probe.rightVsSheet < 0, probe.rightVsSheet);
      check(`${name}@${width}: region paragraph is regular indented (no section break)`,
        /\bindented\b/.test(probe.regionCls) && !/section-break/.test(probe.regionCls), probe.regionCls);
    }
    for (const g of m.filter((x) => x.slug !== 'gutterprobe1')) {
      check(`${name}@${width}: pre-existing margin glyph off-sheet too (${g.slug || 'no-slug'})`, g.rightVsSheet < 0, g.rightVsSheet);
    }
  } finally {
    if (ownBrowser) await browser.close();
    else await page.close();
  }
}

(async () => {
  console.log('=== gutter glyph invariant (chromium + firefox, multi-width) ===');
  psql(`DELETE FROM suggested_change WHERE user_id='${TEST_USERNAME}'`);
  try {
    await runIn(chromium, 'chromium', 1400);
    // One firefox launch, fresh page per width (launch is the slow part).
    const ff = await firefox.launch();
    try {
      await runIn(firefox, 'firefox', 1400, ff);
      await runIn(firefox, 'firefox', 1000, ff);
    } finally {
      await ff.close();
    }
  } finally {
    psql(`DELETE FROM suggested_change WHERE user_id='${TEST_USERNAME}'`);
  }
  if (failures) { console.log(`\n❌ ${failures} check(s) failed`); process.exit(1); }
  console.log('\n✅ Test passed');
})();
