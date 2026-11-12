// Points grid (landing page, above Manuscripts) — tuft's grid-of-squares
// (vendored, web/vendor/tuft/) mounted with home.js's POINTS_GRID settings:
// columns = days, one square = 1 point, green (scored on a daily-tasks-board
// task, 049) stacks first, gold (any other) above; today ~80% across with
// future columns to its right. THE QUIRK: a day shows at most its column
// height; the excess is "bulldozed" rightward into following days (with a
// height of 14: 17,6,13 → 14,9,13), cascading even into the future, and a
// bulldozed-in square rides on TOP of a day's own (equal ranks) keeping its
// color. Heights: 14, and 21 from 2026-11-12 on — the test derives its
// expectations from the vendored heightOn() so it holds on any calendar day.
// The host note here has no manuscript → its points classify gold (the
// points API's lazy backfill of pre-049 rows).
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const { TEST_URL, TEST_USERNAME, cleanupTestNotes, loginAsTestUser } = require('./test-utils');
const GOS = require('../web/vendor/tuft/grid-of-squares.js');
const { WriteSysHome } = require('../web/js/home.js');
const HOME_URL = new URL('home.html', TEST_URL).href;
function psql(sql) {
  return execSync(
    `PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8' }).trim();
}
const DAY = 86400000;
const shift = (iso, days) => new Date(new Date(iso + 'T00:00:00Z').getTime() + days * DAY).toISOString().slice(0, 10);
const heightOn = (date) => GOS.heightOn(WriteSysHome.POINTS_GRID, date);

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  let failed = false;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed = true; };

  await cleanupTestNotes();
  await loginAsTestUser(page);
  // The server's tz-resolved today (the grid's `today`), before seeding.
  const today = (await (await page.request.get(new URL('api/points-daily', TEST_URL).href)).json()).today;
  const H2 = heightOn(shift(today, -2)), H1 = heightOn(shift(today, -1)), H0 = heightOn(today);
  console.log(`today=${today} heights: day-2=${H2} day-1=${H1} today=${H0}`);

  // One host note; the owner's example sequence (day-2 three over its
  // height, 6, 13 across day-2, day-1, today) → must display H2, 9, 13.
  const noteId = psql(`INSERT INTO note (user_id, color, body, priority, task_type, position)
    VALUES ('${TEST_USERNAME}', 'yellow', 'points host', 'can', 'write', 'pg0') RETURNING note_id`).split('\n')[0];
  psql(`INSERT INTO point_event (note_id, points, scored_at) VALUES
    (${noteId}, ${H2 + 3}, now() - interval '2 days'),
    (${noteId}, 6,  now() - interval '1 day'),
    (${noteId}, 13, now())`);

  await page.goto(HOME_URL);
  await page.waitForSelector('#points-grid .gos-col', { timeout: 8000 });

  // --- Section placement + geometry ---
  check('points section sits above Manuscripts', await page.evaluate(() => {
    const secs = [...document.querySelectorAll('#home-root section')];
    return secs.length > 1 && secs[0].id === 'points-section';
  }));
  const colCount = await page.locator('#points-grid .gos-col').count();
  check('columns fill the width', colCount >= 30, `cols=${colCount}`);
  // Heights: 14 before 2026-11-12, 21 from then on — bottom-aligned.
  const heights = await page.evaluate(() =>
    [...document.querySelectorAll('#points-grid .gos-col')].map(c => ({ date: c.dataset.date, n: c.children.length, bottom: c.getBoundingClientRect().bottom })));
  check('columns before 2026-11-12 are 14 squares tall, from then on 21',
    heights.every(h => h.n === (h.date < '2026-11-12' ? 14 : 21)),
    JSON.stringify(heights.filter((h, i, a) => i === 0 || i === a.length - 1 || h.n !== a[i - 1].n)));
  check('columns share a baseline', Math.max(...heights.map(h => h.bottom)) - Math.min(...heights.map(h => h.bottom)) <= 1);
  const todayIdx = await page.evaluate(() =>
    [...document.querySelectorAll('#points-grid .gos-col')].findIndex(c => c.classList.contains('is-today')));
  check('today sits ~80% across', todayIdx / colCount > 0.7 && todayIdx / colCount < 0.9,
    `${todayIdx}/${colCount}`);
  check('today column is the server’s today', await page.evaluate(() =>
    document.querySelector('#points-grid .gos-col.is-today')?.dataset.date) === today);
  // TODAY marker: black triangle + caption centered under today's column.
  const marker = await page.evaluate(() => {
    const m = document.querySelector('#points-grid .gos-mark');
    if (!m) return null;
    const today = document.querySelector('#points-grid .gos-col.is-today');
    const mr = m.getBoundingClientRect(), tr = today.getBoundingClientRect();
    return {
      caption: m.querySelector('.gos-caption')?.textContent,
      hasArrow: !!m.querySelector('.gos-arrow'),
      centerOff: Math.abs((mr.left + mr.right) / 2 - (tr.left + tr.right) / 2),
    };
  });
  check('TODAY marker present (arrow + caption)', marker && marker.hasArrow && marker.caption === 'TODAY',
    JSON.stringify(marker));
  check('marker centered under today’s column', marker && marker.centerOff <= 2, marker && `Δ=${marker.centerOff}`);
  check('no legend (the tooltip carries the counts)', await page.evaluate(() =>
    !document.querySelector('#points-grid .gos-legend')
    && /daily 3|other|—/.test(document.querySelector('#points-grid .gos-col.is-today').title)));
  // Bulldozed cells keep the SAME gold — the dark shade read as a today
  // highlight and is gone.
  const shades = await page.evaluate(() => {
    const lit = document.querySelector('#points-grid .gos-cell.is-lit[data-type="other"]:not(.is-carried)');
    const doze = document.querySelector('#points-grid .gos-cell.is-lit[data-type="other"].is-carried');
    return { lit: lit && getComputedStyle(lit).backgroundColor, doze: doze && getComputedStyle(doze).backgroundColor };
  });
  check('bulldozed cells same gold as natural', shades.doze && shades.doze === shades.lit, JSON.stringify(shades));
  const gridEdges = await page.evaluate(() => {
    const g = document.getElementById('points-grid').getBoundingClientRect();
    const sec = document.querySelector('#home-root section:nth-of-type(2) .card-grid, #home-root .card-grid').getBoundingClientRect();
    return { dl: Math.abs(g.left - sec.left), dr: Math.abs(g.right - sec.right) };
  });
  check('grid shares the cards’ left edge', gridEdges.dl <= 1, `Δ=${gridEdges.dl}`);
  check('grid right edge within one cell of the cards’', gridEdges.dr <= 12, `Δ=${gridEdges.dr}`);

  // --- The H2+3, 6, 13 → H2, 9, 13 example ---
  const colStats = async (date) => page.evaluate((d) => {
    const col = document.querySelector(`#points-grid .gos-col[data-date="${d}"]`);
    if (!col) return null;
    const cells = [...col.children];
    return {
      lit: cells.filter(c => c.classList.contains('is-lit')).length,
      bulldozed: cells.filter(c => c.classList.contains('is-carried')).length,
      daily: cells.filter(c => c.dataset.type === 'daily').length,
      other: cells.filter(c => c.dataset.type === 'other').length,
      litRows: cells.map((c, i) => c.classList.contains('is-lit') ? i : -1).filter(i => i >= 0),
      dozedRows: cells.map((c, i) => c.classList.contains('is-carried') ? i : -1).filter(i => i >= 0),
    };
  }, date);
  const d2 = await colStats(shift(today, -2));
  const d1 = await colStats(shift(today, -1));
  const d0 = await colStats(today);
  check(`${H2 + 3} → ${H2} (capped, all natural gold)`, d2 && d2.lit === H2 && d2.bulldozed === 0, JSON.stringify(d2));
  check('6 + 3 bulldozed-in → 9', d1 && d1.lit === 9 && d1.bulldozed === 3, JSON.stringify(d1));
  check('bulldozed blocks ride on top (rows 6-8)', d1 && d1.dozedRows.join(',') === '6,7,8', d1 && d1.dozedRows.join(','));
  check('stacks grow bottom-up (contiguous from row 0)', d1 && d1.litRows.join(',') === '0,1,2,3,4,5,6,7,8');
  check('13 today, untouched', d0 && d0.lit === 13 && d0.bulldozed === 0, JSON.stringify(d0));
  check('future columns empty so far', await page.evaluate((t) =>
    [...document.querySelectorAll('#points-grid .gos-col')].filter(c => c.dataset.date > t)
      .every(c => ![...c.children].some(x => x.classList.contains('is-lit'))), today));

  // --- Overflow into the FUTURE: +20 today (33 total) → today caps at its
  //     height, the rest lands on the days after; the spilled blocks keep
  //     their gold. (Height 21: 21 | 12 | 0.) ---
  psql(`INSERT INTO point_event (note_id, points, scored_at) VALUES (${noteId}, 20, now())`);
  await page.reload();
  await page.waitForSelector('#points-grid .gos-col', { timeout: 8000 });
  const n0 = await colStats(today);
  const f1 = await colStats(shift(today, 1));
  const f2 = await colStats(shift(today, 2));
  const e1 = Math.min(33 - H0, heightOn(shift(today, 1)));
  const e2 = 33 - H0 - e1;
  check(`today caps at ${H0}`, n0 && n0.lit === H0, JSON.stringify(n0));
  check(`tomorrow catches ${e1} — still gold, all carried`, f1 && f1.lit === e1 && f1.other === e1 && f1.daily === 0 && f1.bulldozed === e1, JSON.stringify(f1));
  check(`day after catches the last ${e2} — still gold`, f2 && f2.lit === e2 && f2.other === e2, JSON.stringify(f2));

  // --- GREEN = daily-board points: today 3 daily + 2 other → the daily
  //     three stack first (rows 0-2, green), the other two above (gold);
  //     yesterday's overflow lands ON TOP of both (equal ranks) ---
  psql(`DELETE FROM point_event WHERE note_id = ${noteId}`);
  psql(`INSERT INTO point_event (note_id, points, scored_at, from_daily) VALUES
    (${noteId}, ${H1 + 2}, now() - interval '1 day', true),
    (${noteId}, 3, now(), true), (${noteId}, 2, now(), false)`);
  await page.reload();
  await page.waitForSelector('#points-grid .gos-col', { timeout: 8000 });
  const mix = await page.evaluate((d) => {
    const cells = [...document.querySelector(`#points-grid .gos-col[data-date="${d}"]`).children];
    return {
      dailyRows: cells.map((c, i) => c.dataset.type === 'daily' ? i : -1).filter(i => i >= 0).join(','),
      otherRows: cells.map((c, i) => c.dataset.type === 'other' ? i : -1).filter(i => i >= 0).join(','),
      carriedRows: cells.map((c, i) => c.classList.contains('is-carried') ? i : -1).filter(i => i >= 0).join(','),
      green: getComputedStyle(cells[0]).backgroundColor,
      gold: getComputedStyle(cells[3]).backgroundColor,
    };
  }, today);
  check('daily points stack first, in green', mix.dailyRows === '0,1,2,5,6' && mix.green === 'rgb(116, 179, 85)', JSON.stringify(mix));
  check('other points above them, in gold', mix.otherRows === '3,4' && mix.gold === 'rgb(240, 196, 25)', JSON.stringify(mix));
  check('carried-in greens ride on top of today’s own gold', mix.carriedRows === '5,6', JSON.stringify(mix));

  // --- Split mode, Home in a WIDE left pane: chrome.css drops .home-main's
  //     1060px cap there, so the landing's own cap must hold — at most 4
  //     cards across, the points grid on the cards' edges ---
  await page.setViewportSize({ width: 2560, height: 900 });
  await page.evaluate(() => {
    document.documentElement.classList.add('ms-split');
    document.documentElement.style.setProperty('--split-x', '90vw');
    window.WriteSysHome.render();
  });
  await page.waitForSelector('#points-grid .gos-col');
  const wide = await page.evaluate(() => {
    const main = document.querySelector('.home-main').getBoundingClientRect();
    const grids = [...document.querySelectorAll('#home-root .card-grid')];
    const g = document.getElementById('points-grid').getBoundingClientRect();
    const c = grids[0].getBoundingClientRect();
    return {
      mainW: Math.round(main.width),
      tracks: grids.map((x) => getComputedStyle(x).gridTemplateColumns.split(' ').length),
      dl: Math.round(Math.abs(g.left - c.left)), dr: Math.round(Math.abs(g.right - c.right)),
      grids: document.querySelectorAll('#points-grid .gos').length,
    };
  });
  check('wide split pane: the landing column really is wide', wide.mainW > 1500, String(wide.mainW));
  check('…yet every landing grid stays 4 across', wide.tracks.length > 0 && wide.tracks.every((t) => t === 4), JSON.stringify(wide.tracks));
  check('…and the points grid keeps the cards’ edges', wide.dl <= 1 && wide.dr <= 12, JSON.stringify(wide));
  check('a re-render mounts exactly one grid', wide.grids === 1, String(wide.grids));
  await page.evaluate(() => {
    document.documentElement.classList.remove('ms-split');
    document.documentElement.style.removeProperty('--split-x');
  });

  psql(`DELETE FROM point_event WHERE note_id = ${noteId}`);
  await cleanupTestNotes();
  await browser.close();
  process.exit(failed ? 1 : 0);
})();
