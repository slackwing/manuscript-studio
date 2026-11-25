// Manuscript chrome controls (2026-11-25): three rows, the SAME markup at
// desktop and mobile widths, each row centered in its container.
//   row 1  settings · daily · push pair · view
//   row 2  first suggested edit (speech bubble) · accept pair
//   row 3  markers (diamond) · attention (bell curve) · footnotes ("1")
const { chromium } = require('playwright');
const { TEST_URL, loginAsTestUser, waitForPagination, cleanupTestAnnotations } = require('./test-utils');

(async () => {
  console.log('=== manuscript chrome rows ===\n');
  let failed = 0;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed++; };
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  let suggested = null;
  try {
    await loginAsTestUser(page);
    await page.goto(TEST_URL);
    await page.waitForSelector('.sentence', { timeout: 30000 });
    await waitForPagination(page);
    // A suggestion so row 2 has its speech bubble.
    suggested = await page.evaluate(async () => {
      const span = [...document.querySelectorAll('p .sentence')].find((s) => s.textContent.trim().length > 20);
      const id = span.dataset.sentenceId;
      const csrf = sessionStorage.getItem('csrf_token');
      const r = await fetch(`api/sentences/${id}/suggestion`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ text: span.textContent.trim() + ' Chrome rows.' }) });
      return r.status === 200 ? id : null;
    });
    await page.reload();
    await page.waitForSelector('#first-edit-btn', { timeout: 30000 });
    await page.waitForSelector('#mc-footnotes', { timeout: 10000 });

    const probe = () => page.evaluate(() => {
      const rowIds = (n) => [...document.querySelectorAll(`#mc-row-${n} .mc-btn`)].map((b) => b.id || b.className.replace(/\s*mc-btn\s*/, '').trim());
      const centered = (n) => {
        const row = document.getElementById(`mc-row-${n}`).getBoundingClientRect();
        const bs = [...document.querySelectorAll(`#mc-row-${n} .mc-btn, #mc-row-${n} .mc-caret`)];
        const l = bs[0].getBoundingClientRect().left - row.left;
        const r = row.right - bs[bs.length - 1].getBoundingClientRect().right;
        return { l: Math.round(l), r: Math.round(r), ok: Math.abs(l - r) < 3 && l >= 0 };
      };
      const tops = [1, 2, 3].map((n) => Math.round(document.getElementById(`mc-row-${n}`).getBoundingClientRect().top));
      const first = document.getElementById('first-edit-btn');
      const chrome = document.getElementById('manuscript-chrome').getBoundingClientRect();
      return {
        rows: [rowIds(1), rowIds(2), rowIds(3)],
        centered: [centered(1), centered(2), centered(3)],
        stacked: tops[0] < tops[1] && tops[1] < tops[2],
        firstIsChat: !!(first && first.querySelector('svg')) && !/\d/.test(first.textContent),
        footnotesIsOne: (document.getElementById('mc-footnotes') || {}).textContent === '1',
        markersSvg: !!document.querySelector('#mc-markers svg'),
        attentionSvg: !!document.querySelector('#mc-attention svg'),
        noStatsToggles: !document.querySelector('.stats-toggles'),
        rowsInsideChrome: [1, 2, 3].every((n) => { const r = document.getElementById(`mc-row-${n}`).getBoundingClientRect(); return r.left >= chrome.left - 1 && r.right <= chrome.right + 1 && r.bottom <= chrome.bottom + 1; }),
        mobile: window.innerWidth <= 1239,
      };
    });

    for (const [label, width] of [['desktop', 1400], ['mobile (half pane)', 800]]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.waitForTimeout(600);
      const p = await probe();
      check(`${label}: row 1 = settings · daily · push · view`, JSON.stringify(p.rows[0]) === JSON.stringify(['mc-settings', 'mc-daily', 'push-btn', 'view-btn']), JSON.stringify(p.rows[0]));
      check(`${label}: row 2 = first suggested edit · accept`, JSON.stringify(p.rows[1]) === JSON.stringify(['first-edit-btn', 'accept-btn']), JSON.stringify(p.rows[1]));
      check(`${label}: row 3 = markers · attention · footnotes`, JSON.stringify(p.rows[2]) === JSON.stringify(['mc-markers', 'mc-attention', 'mc-footnotes']), JSON.stringify(p.rows[2]));
      check(`${label}: rows stack top to bottom inside the chrome`, p.stacked && p.rowsInsideChrome, JSON.stringify({ stacked: p.stacked, inside: p.rowsInsideChrome }));
      check(`${label}: every row is centered`, p.centered.every((c) => c.ok), JSON.stringify(p.centered));
      check(`${label}: layout mode as expected`, p.mobile === (width <= 1239));
    }
    const p = await probe();
    check('suggested edits wears the speech bubble, not a numeral', p.firstIsChat);
    check('footnotes wears the "1"; markers and attention wear drawn icons', p.footnotesIsOne && p.markersSvg && p.attentionSvg, JSON.stringify({ one: p.footnotesIsOne, m: p.markersSvg, a: p.attentionSvg }));
    check('the statistics pane no longer carries a toggle row', p.noStatsToggles);
  } finally {
    try {
      if (suggested) await page.evaluate(async (id) => { await fetch(`api/sentences/${id}/suggestion`, { method: 'DELETE', headers: { 'X-CSRF-Token': sessionStorage.getItem('csrf_token') } }); }, suggested);
    } catch (e) { /* best effort */ }
    await cleanupTestAnnotations();
    await browser.close();
  }
  console.log(failed ? `\n❌ ${failed} check(s) failed` : '\n✅ Test passed');
  process.exit(failed ? 1 : 0);
})();
