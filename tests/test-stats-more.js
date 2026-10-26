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

    // A thin gray vertical at each Jan 1, on both graphs, no label.
    const years = await page.evaluate(() => [...document.querySelectorAll('#stats-margin .stats-graph svg')].map((svg) => {
      const ls = [...svg.querySelectorAll('line.stats-year')];
      return { n: ls.length, vertical: ls.every((l) => l.getAttribute('x1') === l.getAttribute('x2')), gray: ls.every((l) => l.getAttribute('stroke') === '#dddddd'), texts: svg.querySelectorAll('text').length };
    }));
    const thisYear = new Date().getFullYear();
    check('both graphs draw (fixture)', years.length === 2, JSON.stringify(years));
    check('progress graph: a gray line at each Jan 1 in range (incl. next year\'s, the axis runs ahead)', years[0] && years[0].n >= 2 && years[0].vertical && years[0].gray, JSON.stringify(years[0]));
    if (process.env.SHOT_DIR) await page.locator('#stats-margin').screenshot({ path: `${process.env.SHOT_DIR}/stats-years.png` });
    check('rate graph: the Jan 1 that falls before today', years[1] && years[1].n === 1 && years[1].vertical && years[1].gray, JSON.stringify(years[1]) + ` (year ${thisYear})`);
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
