// Gutter-glyph invariant: every margin anchor ⚓ sits FULLY off the page
// sheet, in the grey gutter to its left — in Chromium AND Firefox, across
// window widths. This exact bug shipped three times ("the anchor is ON the
// page"): positioning by calc() guesses (page margin, font metrics, box
// width) instead of measurement. layoutMarginGlyphs() now pins by measuring
// the sheet edge; this test is the tripwire.
const { chromium, firefox } = require('playwright');
const {TEST_USERNAME, TEST_URL, loginAsTestUser} = require('./test-utils');
const { execSync } = require('child_process');

const psql = (sql) => execSync(
  `PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`,
  { encoding: 'utf-8' }).trim();

let failures = 0;
function check(name, ok, extra) {
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ` (${JSON.stringify(extra)})` : ''}`);
  if (!ok) failures++;
}

async function runIn(browserType, name, width) {
  const browser = await browserType.launch();
  const page = await browser.newPage({ viewport: { width, height: 950 } });
  try {
    await loginAsTestUser(page);
    await page.goto(`${TEST_URL}/index.html`);
    await page.waitForSelector('.sentence[data-sentence-id]', { timeout: 60000 });
    await page.waitForTimeout(3500);
    const m = await page.evaluate(async () => {
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
      await r.renderManuscript({ anchorSentenceId: id });
      await new Promise((res) => setTimeout(res, 3000));
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
      await fetch(`api/sentences/${encodeURIComponent(id)}/suggestion`, { method: 'DELETE',
        headers: { 'X-CSRF-Token': csrf } }).catch(() => {});
      return results;
    });
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
    await browser.close();
  }
}

(async () => {
  console.log('=== gutter glyph invariant (chromium + firefox, multi-width) ===');
  psql(`DELETE FROM suggested_change WHERE user_id='${TEST_USERNAME}'`);
  try {
    await runIn(chromium, 'chromium', 1400);
    await runIn(firefox, 'firefox', 1400);
    await runIn(firefox, 'firefox', 1000);
  } finally {
    psql(`DELETE FROM suggested_change WHERE user_id='${TEST_USERNAME}'`);
  }
  if (failures) { console.log(`\n❌ ${failures} check(s) failed`); process.exit(1); }
  console.log('\n✅ Test passed');
})();
