// The book's insert affordances (the between-paragraph "+" and the
// end-of-book "+") draw their plus as an SVG centered in the circle by
// geometry — never a font glyph, which sat off-center under some fallback
// fonts (owner's report, 2026-10-18).
const { chromium } = require('playwright');
const { TEST_URL, loginAsTestUser, waitForPagination } = require('./test-utils');

(async () => {
  let failed = false;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed = true; };
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    await loginAsTestUser(page);
    await page.goto(TEST_URL);
    await waitForPagination(page);
    await page.waitForSelector('.import-zone .import-tab', { state: 'attached', timeout: 10000 });
    const off = await page.evaluate(() => ['.import-zone .import-tab', '.import-endzone .import-end-tab'].map((sel) => {
      const b = document.querySelector(sel);
      if (!b) return { sel, missing: true };
      b.closest('.import-zone, .import-endzone').classList.add('import-hot');
      const svg = b.querySelector('svg');
      const r = b.getBoundingClientRect(), g = svg ? svg.getBoundingClientRect() : null;
      return {
        sel, svg: !!svg, text: b.textContent.trim(),
        dx: g ? Math.abs((g.left + g.right) / 2 - (r.left + r.right) / 2) : 99,
        dy: g ? Math.abs((g.top + g.bottom) / 2 - (r.top + r.bottom) / 2) : 99,
      };
    }));
    for (const o of off) {
      if (o.missing) { check(`${o.sel} present`, false); continue; }
      check(`${o.sel}: the plus is a drawn SVG, not a "+" glyph`, o.svg && o.text === '', JSON.stringify(o));
      check(`${o.sel}: centered in its circle (≤0.5px)`, o.dx <= 0.5 && o.dy <= 0.5, `dx=${o.dx} dy=${o.dy}`);
    }
  } catch (e) {
    console.log(`❌ Test errored: ${e.message}`);
    failed = true;
  } finally {
    await browser.close();
  }
  console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS');
  process.exit(failed ? 1 : 0);
})();
