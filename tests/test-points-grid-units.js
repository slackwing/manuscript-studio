// Points grid SETTINGS (home.js POINTS_GRID) against the vendored
// grid-of-squares (web/vendor/tuft/) — pure, no browser. The settings must
// reproduce the hand-rolled grid they replaced (2026-11-12):
//   - greens (daily-board points) stack first, golds above, a carried-in
//     square on TOP of a day's own — equal ranks, skim bulldozing;
//   - a day shows at most its height; the top squares roll right,
//     cascading into the future (14: 17, 6, 13 → 14, 9, 13);
//   - height 14, and 21 from 2026-11-12 on (bottom-aligned growth);
//   - `today` is whatever the caller (the API) says.
const GOS = require('../web/vendor/tuft/grid-of-squares.js');
const { WriteSysHome } = require('../web/js/home.js');

let failed = false;
const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed = true; };
const S = (today) => WriteSysHome.pointsGridSettings(today);
const col = (vm, date) => vm.cols.find((c) => c.date === date);
const types = (c) => c.cells.map((x) => x.type).join(',');
const carried = (c) => c.cells.map((x, i) => (x.carried ? i : -1)).filter((i) => i >= 0).join(',');

// --- settings shape ---
const base = S('2026-11-12');
const norm = GOS.normalizeSettings(base);
check('two types, daily then other, both bulldozing', norm.schema.map((t) => t.type).join(',') === 'daily,other'
  && norm.schema.every((t) => t.bulldoze));
check('equal ranks (a carried square rides on top of a day’s own)', norm.schema[0].rank === norm.schema[1].rank);
check('daily is the grid green, other the daily check’s gold',
  norm.byType.daily.color === '#74b355' && norm.byType.other.color === '#f0c419');
check('skim bulldozing, 20% lookahead, 10px cells, 2px gaps, ≥10 columns',
  norm.bulldozeMode === 'skim' && norm.lookahead === 0.2 && norm.cellSize === 10 && norm.gap === 2 && norm.minColumns === 10);
check('today marker on, no legend, counts tooltip', norm.todayMarker && !norm.legend && norm.tooltip === 'counts');
check('today is the caller’s (the API’s), not the browser’s', norm.today === '2026-11-12'
  && GOS.layout(S('2026-01-05'), [], 20).today === '2026-01-05');
check('POINTS_GRID itself carries no today (a fresh settings object per render)', WriteSysHome.POINTS_GRID.today === undefined
  && S('2026-11-12') !== S('2026-11-12'));

// --- heights: 14, then 21 from 2026-11-12 ---
check('14 tall through 2026-11-11', GOS.heightOn(base, '2026-11-11') === 14 && GOS.heightOn(base, '2025-01-01') === 14);
check('21 tall from 2026-11-12 on', GOS.heightOn(base, '2026-11-12') === 21 && GOS.heightOn(base, '2027-06-30') === 21);
{
  const vm = GOS.layout(S('2026-11-12'), [], 20);
  check('a window straddling the change: 14-cell columns before, 21 after, max 21',
    vm.cols.every((c) => c.height === (c.date < '2026-11-12' ? 14 : 21)) && vm.maxHeight === 21,
    vm.cols.map((c) => c.height).join(','));
}

// --- the bulldozer, at height 14 (all three days before the change) ---
{
  const today = '2026-11-10';
  const vm = GOS.layout(S(today), [
    { date: '2026-11-08', type: 'other', count: 17 },
    { date: '2026-11-09', type: 'other', count: 6 },
    { date: '2026-11-10', type: 'other', count: 13 },
  ], 40);
  const [d2, d1, d0] = ['2026-11-08', '2026-11-09', '2026-11-10'].map((d) => col(vm, d));
  check('17, 6, 13 → 14, 9, 13', d2.cells.length === 14 && d1.cells.length === 9 && d0.cells.length === 13,
    `${d2.cells.length}, ${d1.cells.length}, ${d0.cells.length}`);
  check('the 3 carried squares ride on top (rows 6-8)', carried(d1) === '6,7,8', carried(d1));
  check('17, 12, 14 → 14, 14, 14, 1 (the trailing 1 lands in the future)', (() => {
    const v = GOS.layout(S(today), [
      { date: '2026-11-08', type: 'other', count: 17 },
      { date: '2026-11-09', type: 'other', count: 12 },
      { date: '2026-11-10', type: 'other', count: 14 },
    ], 40);
    return ['2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11'].map((d) => col(v, d).cells.length).join(',') === '14,14,14,1'
      && col(v, '2026-11-11').cells[0].carried;
  })());
  check('today ~80% across (8 future columns of 40)', vm.future === 8 && vm.todayIndex === 31, `${vm.todayIndex}/${vm.columns}`);
}

// --- colors + order: greens first, golds above, carried on top of both ---
{
  const today = '2026-11-10';
  const vm = GOS.layout(S(today), [
    { date: '2026-11-09', type: 'daily', count: 15 },   // 1 green rolls into today
    { date: '2026-11-10', type: 'daily', count: 3 },    // added first, as home.js does
    { date: '2026-11-10', type: 'other', count: 2 },
  ], 40);
  const d0 = col(vm, today);
  check('greens stack first, golds above, the carried green on top of both',
    types(d0) === 'daily,daily,daily,other,other,daily' && carried(d0) === '5', `${types(d0)} carried=${carried(d0)}`);
  check('a carried square keeps its color', d0.cells[5].type === 'daily' && d0.cells[5].color === '#74b355');
  check('the tooltip counts both kinds', d0.counts.daily === 4 && d0.counts.other === 2);
}

// --- history left of the window still spills into view ---
{
  const today = '2026-11-10';
  // 40 columns, 8 of them future → the window opens 31 days before today.
  const vm = GOS.layout(S(today), [{ date: '2026-09-01', type: 'other', count: 14 * 70 + 5 }], 40);
  const first = vm.cols[0];
  check('a monster day long before the window cascades into it',
    first.date === '2026-10-10' && first.cells.length === 14 && first.cells.every((c) => c.carried),
    `${first.date}: ${first.cells.length}`);
}

// --- the height change mid-cascade: 33 today (2026-11-12) → 21 | 12 ---
{
  const vm = GOS.layout(S('2026-11-12'), [{ date: '2026-11-12', type: 'other', count: 33 }], 40);
  check('33 on the first 21-tall day → 21 today, 12 tomorrow',
    col(vm, '2026-11-12').cells.length === 21 && col(vm, '2026-11-13').cells.length === 12
    && (col(vm, '2026-11-14') || { cells: [] }).cells.length === 0);
}

// --- the rendered HTML carries what the e2e test and the page rely on ---
{
  const vm = GOS.layout(S('2026-11-12'), [{ date: '2026-11-12', type: 'daily', count: 1 }], 20);
  const html = GOS.renderHTML(vm, S('2026-11-12'));
  check('columns carry data-date, today is-today, cells data-type + is-lit, marker reads TODAY',
    /class="gos-col is-today" data-date="2026-11-12"/.test(html)
    && /class="gos-cell is-lit" data-type="daily" style="background:#74b355"/.test(html)
    && /gos-caption">TODAY</.test(html) && !/gos-legend/.test(html));
}

process.exit(failed ? 1 : 0);
