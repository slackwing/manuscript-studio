// Points grid (landing page, above Manuscripts): GitHub-style squares —
// columns = days, 14 rows = 14 points, gold bottom-up stacks, today ~80%
// across with future columns to its right. THE QUIRK: a day shows at most
// 14 points; the excess is "bulldozed" rightward into following days
// (17,6,13 → 14,9,13), cascading even into the future (green squares).
// Bulldozed-in blocks ride on TOP of a day's own points in darker gold.
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const { TEST_URL, TEST_USERNAME, cleanupTestNotes, loginAsTestUser } = require('./test-utils');
const HOME_URL = new URL('home.html', TEST_URL).href;
function psql(sql) {
  return execSync(
    `PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8' }).trim();
}
const DAY = 86400000;
const shift = (iso, days) => new Date(new Date(iso + 'T00:00:00Z').getTime() + days * DAY).toISOString().slice(0, 10);

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  let failed = false;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed = true; };

  await cleanupTestNotes();
  // One host note; the user's example sequence 17, 6, 13 across
  // day-2, day-1, today → must display 14, 9, 13.
  const noteId = psql(`INSERT INTO note (user_id, color, body, priority, task_type, position)
    VALUES ('${TEST_USERNAME}', 'yellow', 'points host', 'can', 'write', 'pg0') RETURNING note_id`).split('\n')[0];
  psql(`INSERT INTO point_event (note_id, points, scored_at) VALUES
    (${noteId}, 17, now() - interval '2 days'),
    (${noteId}, 6,  now() - interval '1 day'),
    (${noteId}, 13, now())`);

  await loginAsTestUser(page);
  await page.goto(HOME_URL);
  await page.waitForSelector('#points-grid .points-col', { timeout: 8000 });

  // --- Section placement + geometry ---
  check('points section sits above Manuscripts', await page.evaluate(() => {
    const secs = [...document.querySelectorAll('#home-root section')];
    return secs.length > 1 && secs[0].id === 'points-section';
  }));
  const colCount = await page.locator('.points-col').count();
  check('columns fill the width', colCount >= 30, `cols=${colCount}`);
  check('every column has 14 cells', await page.evaluate(() =>
    [...document.querySelectorAll('.points-col')].every(c => c.children.length === 14)));
  const todayIdx = await page.evaluate(() =>
    [...document.querySelectorAll('.points-col')].findIndex(c => c.classList.contains('today')));
  check('today sits ~80% across', todayIdx / colCount > 0.7 && todayIdx / colCount < 0.9,
    `${todayIdx}/${colCount}`);
  const gridEdges = await page.evaluate(() => {
    const g = document.getElementById('points-grid').getBoundingClientRect();
    const sec = document.querySelector('#home-root section:nth-of-type(2) .card-grid, #home-root .card-grid').getBoundingClientRect();
    return { dl: Math.abs(g.left - sec.left), dr: Math.abs(g.right - sec.right) };
  });
  check('grid shares the cards’ left edge', gridEdges.dl <= 1, `Δ=${gridEdges.dl}`);
  check('grid right edge within one cell of the cards’', gridEdges.dr <= 12, `Δ=${gridEdges.dr}`);

  // --- The 17, 6, 13 → 14, 9, 13 example ---
  const today = (await page.evaluate(() => fetch('api/points-daily', { credentials: 'same-origin' }).then(r => r.json()))).today;
  const colStats = async (date) => page.evaluate((d) => {
    const col = document.querySelector(`.points-col[data-date="${d}"]`);
    if (!col) return null;
    const cells = [...col.children];
    return {
      lit: cells.filter(c => c.classList.contains('lit')).length,
      bulldozed: cells.filter(c => c.classList.contains('bulldozed')).length,
      future: cells.filter(c => c.classList.contains('future')).length,
      litRows: cells.map((c, i) => c.classList.contains('lit') ? i : -1).filter(i => i >= 0),
      dozedRows: cells.map((c, i) => c.classList.contains('bulldozed') ? i : -1).filter(i => i >= 0),
    };
  }, date);
  const d2 = await colStats(shift(today, -2));
  const d1 = await colStats(shift(today, -1));
  const d0 = await colStats(today);
  check('17 → 14 (capped, all natural gold)', d2 && d2.lit === 14 && d2.bulldozed === 0, JSON.stringify(d2));
  check('6 + 3 bulldozed-in → 9', d1 && d1.lit === 9 && d1.bulldozed === 3, JSON.stringify(d1));
  check('bulldozed blocks ride on top (rows 6-8)', d1 && d1.dozedRows.join(',') === '6,7,8', d1 && d1.dozedRows.join(','));
  check('stacks grow bottom-up (contiguous from row 0)', d1 && d1.litRows.join(',') === '0,1,2,3,4,5,6,7,8');
  check('13 today, untouched', d0 && d0.lit === 13 && d0.bulldozed === 0, JSON.stringify(d0));
  check('future columns empty so far', await page.evaluate((t) =>
    [...document.querySelectorAll('.points-col')].filter(c => c.dataset.date > t)
      .every(c => ![...c.children].some(x => x.classList.contains('lit'))), today));

  // --- Overflow into the FUTURE: +20 today (33 total) → 14 | 14 | 5,
  //     with everything past today green ---
  psql(`INSERT INTO point_event (note_id, points, scored_at) VALUES (${noteId}, 20, now())`);
  await page.reload();
  await page.waitForSelector('#points-grid .points-col', { timeout: 8000 });
  const n0 = await colStats(today);
  const f1 = await colStats(shift(today, 1));
  const f2 = await colStats(shift(today, 2));
  check('today caps at 14', n0 && n0.lit === 14, JSON.stringify(n0));
  check('tomorrow catches 14 — all green', f1 && f1.lit === 14 && f1.future === 14, JSON.stringify(f1));
  check('day after catches the last 5 — green', f2 && f2.lit === 5 && f2.future === 5, JSON.stringify(f2));

  psql(`DELETE FROM point_event WHERE note_id = ${noteId}`);
  await cleanupTestNotes();
  await browser.close();
  process.exit(failed ? 1 : 0);
})();
