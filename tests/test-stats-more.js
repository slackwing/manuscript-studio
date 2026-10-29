// Statistics rows added 2026-10-26: "1Y RATE" reads "1Y FINISH"; below it
// the word count as it stood 1Y / 30D / 1W / 1D ago (the latest history
// row on or before that day), and NEW ACCEPTED — the words added by the
// edits accepted right now, not yet committed (one frequency counter per
// edit: new words +1, removed −1, positives summed — a moved word nets 0),
// which refreshes right after you accept. The graph's plot lines are 1 unit thinner.
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const { TEST_URL, TEST_USERNAME, TEST_MANUSCRIPT_ID, loginAsTestUser, waitForPagination, cleanupTestAnnotations } = require('./test-utils');
const psql = (sql) => execSync(`PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`, { encoding: 'utf8' }).trim();

(async () => {
  let failed = false;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed = true; };
  const M = TEST_MANUSCRIPT_ID;
  await cleanupTestAnnotations();
  // Known history (the pane's day keys are the viewer's local dates).
  const backup = psql(`SELECT coalesce(json_agg(w), '[]') FROM wordcount_history w WHERE manuscript_id=${M}`);
  // A birthday, so the graph draws (restored below).
  const bday = psql(`SELECT coalesce(birthday::text, '') FROM manuscript WHERE manuscript_id=${M}`);
  psql(`UPDATE manuscript SET birthday = current_date - 500 WHERE manuscript_id=${M}`);
  psql(`DELETE FROM wordcount_history WHERE manuscript_id=${M}`);
  const seed = [[400, 100], [31, 500], [8, 800], [1, 950], [0, 1000]];
  for (const [ago, n] of seed) {
    psql(`INSERT INTO wordcount_history (manuscript_id, day, words_effective, rate_average, rate_past_30d) VALUES (${M}, current_date - ${ago}, ${n}, ${n / 100}, ${n / 50})`);
  }
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    await page.addInitScript(() => localStorage.setItem('ms_pane', 'stats'));
    await loginAsTestUser(page);
    await page.goto(TEST_URL);
    await waitForPagination(page);
    await page.waitForSelector('[data-stat="ago-d1"]');
    const vals = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#stats-margin .stats-row')]
      .map((r) => [r.querySelector('.stats-row-label').textContent, r.querySelector('.stats-row-value').textContent])));
    const v = await vals();
    check('"1Y RATE" now reads "1Y FINISH"', '1Y FINISH' in v && !('1Y RATE' in v), Object.keys(v).join(', '));
    check('1Y AGO = the count a year back (latest row on or before)', v['1Y AGO'] === '100', v['1Y AGO']);
    check('30D AGO', v['30D AGO'] === '500', v['30D AGO']);
    check('1W AGO', v['1W AGO'] === '800', v['1W AGO']);
    check('1D AGO', v['1D AGO'] === '950', v['1D AGO']);
    const order = Object.keys(v);
    check('the new rows sit below 1Y FINISH, NEW ACCEPTED last',
      order.indexOf('1Y AGO') === order.indexOf('1Y FINISH') + 1 && order[order.length - 1] === 'NEW ACCEPTED', order.join(' > '));

    // NEW ACCEPTED: accept an edit → the pane refreshes on its own and flashes.
    const base = parseInt((v['NEW ACCEPTED'] || '0').replace(/,/g, ''), 10) || 0;
    const pick = await page.evaluate(() => {
      const R = window.WriteSysRenderer;
      const id = [...document.querySelectorAll('.pagedjs_pages p .sentence[data-sentence-id]')].map((e) => e.dataset.sentenceId)
        .find((sid) => /^[A-Z][^&{]*\.$/.test((R.sentenceMap[sid] || '').trim()) && (R.sentenceMap[sid] || '').trim().split(/\s+/).length > 5);
      return { id, text: R.sentenceMap[id] };
    });
    // Moves two words to the front (nets 0) and adds three new ones (+3).
    const words = pick.text.trim().replace(/\.$/, '').split(/\s+/);
    const edited = `${words.slice(-2).join(' ')} ${words.slice(0, -2).join(' ')} zephyr quixotic marmalade.`;
    await page.evaluate(async ({ id, text }) => {
      const S = window.WriteSysSuggestions, R = window.WriteSysRenderer;
      await S.putSuggestion(id, text);
      await S.loadForMigration(R.currentMigrationID);
      await S.acceptMany([id]);
    }, { id: pick.id, text: edited });
    await page.waitForFunction((want) => {
      const el = document.querySelector('[data-stat="accepted"]');
      return el && el.textContent.replace(/,/g, '') === String(want);
    }, base + 3, { timeout: 8000 }).then(() => check('accepting refreshes NEW ACCEPTED: +3 (moved words net 0)', true))
      .catch(async () => check('accepting refreshes NEW ACCEPTED: +3 (moved words net 0)', false, (await vals())['NEW ACCEPTED'] + ` (base ${base})`));
    check('…and it flashes', await page.evaluate(() => document.querySelector('[data-stat="accepted"]').classList.contains('stats-flash')));

    // Thinner plot lines.
    const widths = await page.evaluate(() => [...document.querySelectorAll('#stats-margin svg polyline')].map((p) => p.getAttribute('stroke-width')));
    check('plot lines are 1 unit thinner (0.6 actual / 0.4 rates)', widths.length && widths.every((w) => w === '0.6' || w === '0.4'), widths.join(','));

    // The background is shaded by season on both graphs (2026-10-26):
    // spring light green, summer deeper green, autumn gold, winter white.
    const seasons = await page.evaluate(() => [document.querySelector('#stats-margin .stats-graph:not(.stats-delta-graph):not(.stats-rate-graph) svg'), document.querySelector('#stats-margin .stats-rate-graph svg')].map((svg) => {
      const frame = svg.querySelector('rect[stroke="#cccccc"]').getBBox();
      const bands = [...svg.querySelectorAll('rect.stats-season')].map((r) => ({ s: r.dataset.season, x: +r.getAttribute('x'), w: +r.getAttribute('width'), fill: r.getAttribute('fill') }));
      const covered = bands.reduce((a, b) => a + b.w, 0);
      return { n: bands.length, last: bands[bands.length - 1], covered: Math.round(covered), frame: Math.round(frame.width),
        fills: [...new Set(bands.map((b) => `${b.s}:${b.fill}`))].sort(), noYearLines: !svg.querySelector('line.stats-year') };
    }));
    if (process.env.SHOT_DIR) await page.locator('#stats-margin').screenshot({ path: `${process.env.SHOT_DIR}/stats-seasons.png` });
    const palette = { spring: '#e9f3dd', summer: '#d3e8c4', autumn: '#f2e2b3', winter: '#ffffff' };
    check('both graphs are shaded by season (fixture)', seasons.length === 2 && seasons.every((g) => g.n >= 2 && g.noYearLines), JSON.stringify(seasons.map((g) => g.n)));
    check('the bands tile the whole plot width', seasons.every((g) => Math.abs(g.covered - g.frame) <= 2), JSON.stringify(seasons.map((g) => [g.covered, g.frame])));
    check('each season wears its color', seasons.every((g) => g.fills.every((f) => palette[f.split(':')[0]] === f.split(':')[1])), JSON.stringify(seasons[0].fills));
    const m = new Date().getMonth() + 1, d = new Date().getDate();
    const nowSeason = (m > 12 || (m === 12 && d >= 21) || m < 3 || (m === 3 && d < 20)) ? 'winter'
      : (m < 6 || (m === 6 && d < 21)) ? 'spring' : (m < 9 || (m === 9 && d < 22)) ? 'summer' : 'autumn';
    // The rate graph runs a season past today: today's dot sits clear of the
    // right edge, over the CURRENT season's band.
    const ahead = await page.evaluate(() => {
      const svg = document.querySelector('#stats-margin .stats-rate-graph svg');
      const frame = svg.querySelector('rect[stroke="#cccccc"]');
      const right = +frame.getAttribute('x') + +frame.getAttribute('width');
      const cx = +svg.querySelector('.stats-today circle:not(.stats-ping)').getAttribute('cx');
      const band = [...svg.querySelectorAll('rect.stats-season')].find((r) => +r.getAttribute('x') <= cx && cx < +r.getAttribute('x') + +r.getAttribute('width'));
      return { gap: Math.round(right - cx), width: Math.round(+frame.getAttribute('width')), season: band && band.dataset.season };
    });
    // Birthday 500 days back: a season (91.3 d) of 591 → ~15% of the width.
    check('the rate graph runs a season past today (dot clear of the right edge)', Math.abs(ahead.gap - ahead.width * 91.3 / 591.3) <= 3, JSON.stringify(ahead));
    check('…over the current season', ahead.season === nowSeason, `${ahead.season} vs ${nowSeason}`);

    // Today: a tiny blue pinging dot on each graph, at its line's latest point.
    const dots = await page.evaluate(() => [document.querySelector('#stats-margin .stats-graph:not(.stats-delta-graph):not(.stats-rate-graph) svg'), document.querySelector('#stats-margin .stats-rate-graph svg')].map((svg, i) => {
      const g = svg.querySelector('.stats-today');
      if (!g) return null;
      const c = g.querySelector('circle:not(.stats-ping)');
      const line = svg.querySelectorAll('polyline')[0]; // progress: actual; rate: past-30d (drawn first)
      const pts = line.getAttribute('points').trim().split(/\s+/);
      const [lx, ly] = pts[pts.length - 1].split(',').map(Number);
      const ping = g.querySelector('.stats-ping');
      return { onLine: Math.abs(+c.getAttribute('cx') - lx) < 0.2 && Math.abs(+c.getAttribute('cy') - ly) < 0.2,
        blue: c.getAttribute('fill') === '#2a6fb0', r: +c.getAttribute('r'),
        pinging: getComputedStyle(ping).animationName === 'stats-ping' && getComputedStyle(ping).animationIterationCount === 'infinite' };
    }));
    check('both graphs carry today\'s dot', dots.length === 2 && dots.every(Boolean), JSON.stringify(dots));
    check('…tiny and blue, on the line\'s latest point (actual words / current pace)', dots.every((d) => d && d.onLine && d.blue && d.r <= 3), JSON.stringify(dots));
    check('…and pinging (looping ring)', dots.every((d) => d && d.pinging), JSON.stringify(dots));

    // The daily-delta histogram (2026-10-29): between the two graphs, on
    // the BOTTOM graph's x-scale with the season shading; each day's bar its
    // ideal width; gray, over a blue tint on the last 30 days' region.
    const delta = await page.evaluate(() => {
      const graphs = [...document.querySelectorAll('#stats-margin .stats-graph')];
      const svg = document.querySelector('#stats-margin .stats-delta-graph svg');
      const rate = document.querySelector('#stats-margin .stats-rate-graph svg');
      const bands = (g) => [...g.querySelectorAll('rect.stats-season')].map((r) => `${r.getAttribute('x')}+${r.getAttribute('width')}`).join(' ');
      const frame = svg.querySelector('rect[stroke="#cccccc"]');
      const bars = [...svg.querySelectorAll('rect.stats-delta-bar')].map((b) => ({ x: +b.getAttribute('x'), w: +b.getAttribute('width'), sign: b.dataset.sign, fill: b.getAttribute('fill') }));
      const band = svg.querySelector('rect.stats-delta-recent');
      const kids = [...svg.children];
      const lastSeason = Math.max(...[...svg.querySelectorAll('rect.stats-season')].map((r) => kids.indexOf(r)));
      const firstBar = Math.min(...[...svg.querySelectorAll('rect.stats-delta-bar')].map((r) => kids.indexOf(r)));
      return { between: graphs.indexOf(svg.parentElement) === 1 && graphs.indexOf(rate.parentElement) === 2,
        sameScale: bands(svg) === bands(rate), frameW: +frame.getAttribute('width'), frameX: +frame.getAttribute('x'), bars,
        band: band && { x: +band.getAttribute('x'), w: +band.getAttribute('width'), y: +band.getAttribute('y'), h: +band.getAttribute('height'),
          fill: band.getAttribute('fill'), op: +band.getAttribute('fill-opacity'), overSeasons: kids.indexOf(band) > lastSeason, underBars: kids.indexOf(band) < firstBar },
        frameY: +frame.getAttribute('y'), frameH: +frame.getAttribute('height') };
    });
    check('a daily-delta graph sits between the two graphs', delta.between, JSON.stringify(delta.between));
    check('…on the bottom graph\'s x-scale (identical season bands)', delta.sameScale);
    // Seeded deltas: +400 (31 days ago), +300 (8), +150 (1), +50 (today).
    const slot = delta.frameW / (500 + 91.3125);
    check('…one bar per changed day, each the ideal day width', delta.bars.length === 4 && delta.bars.every((b) => Math.abs(b.w - slot) < 0.01), JSON.stringify(delta.bars.map((b) => b.w.toFixed(3))) + ` slot ${slot.toFixed(3)}`);
    check('…all dark gray', delta.bars.every((b) => b.fill === '#555555'), delta.bars.map((b) => b.fill).join(','));
    // The last 30 days' region tinted blue: the 30 day-slots ending with
    // today's (the domain runs birthday −500d → today + a season).
    const b30 = delta.band;
    check('…the last 30 days\' region tinted blue (translucent) over the season shading, under the bars',
      !!b30 && b30.fill === '#3b82f6' && b30.op > 0 && b30.op < 1 && b30.overSeasons && b30.underBars, JSON.stringify(b30));
    check('…spanning exactly the last 30 day-slots, full plot height',
      !!b30 && Math.abs(b30.w - 30 * slot) < 0.01 && Math.abs(b30.x - (delta.frameX + 471 * slot)) < 0.01 && b30.y === delta.frameY && Math.abs(b30.h - delta.frameH) < 0.01,
      b30 && `x ${b30.x.toFixed(3)} vs ${(delta.frameX + 471 * slot).toFixed(3)}, w ${b30.w.toFixed(3)} vs ${(30 * slot).toFixed(3)}`);
    check('…all gains here (no zero line without a cut)', delta.bars.every((b) => b.sign === 'up'));

    // The past-30d line only where a full 30 days of history stand behind
    // the point (pane fed synthetic data — no DB writes).
    const synth = (agos) => page.evaluate((agos) => {
      const S = window.WriteSysStats;
      const day = (ago) => { const d = new Date(); d.setDate(d.getDate() - ago); return d.toLocaleDateString('en-CA'); };
      S.data = { enabled: true, interval_minutes: 15, word_goal: 40000, new_accepted: 0, birthday: day(100),
        rows: agos.map((a, i) => ({ day: day(a), words_effective: 1000 + i * 100, words_sketches: 0, rate_average: 10 + i, rate_past_30d: 20 + i * 5 })) };
      S.render();
      const svg = document.querySelector('#stats-margin .stats-rate-graph svg');
      const [trend, avg] = [...svg.querySelectorAll('polyline')].map((p) => p.getAttribute('points').trim().split(/\s+/).filter(Boolean));
      const dot = svg.querySelector('.stats-today circle:not(.stats-ping)');
      const lastAvg = avg[avg.length - 1].split(',').map(Number);
      return { trend: trend.length, avg: avg.length, dotOnAvg: !!dot && Math.abs(+dot.getAttribute('cx') - lastAvg[0]) < 0.2 && Math.abs(+dot.getAttribute('cy') - lastAvg[1]) < 0.2 };
    }, agos);
    const young = await synth([20, 10, 5, 0]);
    check('history under 30 days: no past-30d points (average still drawn; dot on the average)', young.trend === 0 && young.avg === 4 && young.dotOnAvg, JSON.stringify(young));
    const older = await synth([60, 40, 20, 0]);
    check('60 days of history: only the points with 30 days behind them', older.trend === 2 && older.avg === 4 && !older.dotOnAvg, JSON.stringify(older));

    // Consecutive days tile edge to edge; a cut drops below the zero line.
    const tiled = await page.evaluate(() => {
      const S = window.WriteSysStats;
      const day = (ago) => { const d = new Date(); d.setDate(d.getDate() - ago); return d.toLocaleDateString('en-CA'); };
      const totals = [1000, 1100, 1150, 900, 950, 1000, 1080];
      S.data = { enabled: true, interval_minutes: 15, word_goal: 40000, new_accepted: 0, birthday: day(60),
        rows: totals.map((n, i) => ({ day: day(totals.length - 1 - i), words_effective: n, words_sketches: 0, rate_average: 10, rate_past_30d: 20 })) };
      S.render();
      const svg = document.querySelector('#stats-margin .stats-delta-graph svg');
      const bars = [...svg.querySelectorAll('rect.stats-delta-bar')].map((b) => ({ x: +b.getAttribute('x'), y: +b.getAttribute('y'), w: +b.getAttribute('width'), h: +b.getAttribute('height'), sign: b.dataset.sign }));
      const zero = svg.querySelector('.stats-delta-zero');
      const z = zero ? +zero.getAttribute('y1') : null;
      let maxGap = 0;
      for (let i = 1; i < bars.length; i++) maxGap = Math.max(maxGap, Math.abs(bars[i].x - (bars[i - 1].x + bars[i - 1].w)));
      const down = bars.filter((b) => b.sign === 'down');
      return { n: bars.length, maxGap, zero: z, down: down.length, downBelow: down.every((b) => Math.abs(b.y - z) < 0.05 && b.h > 0),
        upAbove: bars.filter((b) => b.sign === 'up').every((b) => Math.abs(b.y + b.h - z) < 0.05) };
    });
    check('consecutive days tile edge to edge (no gaps)', tiled.n === 6 && tiled.maxGap < 0.01, JSON.stringify(tiled));
    check('a day of cuts drops below the zero line; gains rise above it', tiled.zero != null && tiled.down === 1 && tiled.downBelow && tiled.upAbove, JSON.stringify(tiled));
    if (process.env.SHOT_DIR) await page.locator('#stats-margin').screenshot({ path: `${process.env.SHOT_DIR}/stats-delta-synth.png` });
    await page.close();
  } catch (e) {
    check('run', false, e.message);
  } finally {
    psql(`DELETE FROM wordcount_history WHERE manuscript_id=${M}`);
    psql(`INSERT INTO wordcount_history SELECT * FROM json_populate_recordset(NULL::wordcount_history, '${backup.replace(/'/g, "''")}')`);
    psql(`DELETE FROM suggested_change WHERE user_id='${TEST_USERNAME}'`);
    psql(`UPDATE manuscript SET birthday = ${bday ? `'${bday}'` : 'NULL'} WHERE manuscript_id=${M}`);
  }
  await browser.close();
  console.log(failed ? '\n❌ some checks failed' : '\n✅ all passed');
  process.exit(failed ? 1 : 0);
})();
