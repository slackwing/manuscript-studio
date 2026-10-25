// Statistics refresh live (2026-10-25): the numbers come from the server's
// wordcount cron, which runs on the clock (interval_minutes); the pane
// re-fetches just after each run and when the tab comes back into view,
// re-renders only on a real change, and a changed number FLASHES — a quick
// highlight that decays at once. Changes that land while another pane is
// showing flash when you come back to Statistics.
// SHOT_DIR=<dir> saves a mid-flash screenshot.
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const { TEST_URL, TEST_MANUSCRIPT_ID, loginAsTestUser, waitForPagination } = require('./test-utils');
const psql = (sql) => execSync(`PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`, { encoding: 'utf8' }).trim();

(async () => {
  let failed = false;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed = true; };
  const M = TEST_MANUSCRIPT_ID;
  const browser = await chromium.launch({ headless: true });
  // A latest-day row to drive the WORDS number (restored at the end).
  const lastDay = psql(`SELECT max(day)::text FROM wordcount_history WHERE manuscript_id=${M}`);
  if (!lastDay) {
    psql(`INSERT INTO wordcount_history (manuscript_id, day, words_effective) VALUES (${M}, current_date, 1000)`);
  }
  const day = lastDay || psql(`SELECT current_date::text`);
  const orig = psql(`SELECT words_effective FROM wordcount_history WHERE manuscript_id=${M} AND day='${day}'`);
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    await page.addInitScript(() => localStorage.setItem('ms_pane', 'stats'));
    await loginAsTestUser(page);
    await page.goto(TEST_URL);
    await waitForPagination(page);
    await page.waitForSelector('#stats-words');
    const st = () => page.evaluate(() => ({
      words: document.getElementById('stats-words').textContent,
      flashing: [...document.querySelectorAll('.stats-flash')].map((e) => e.dataset.stat),
      node: document.getElementById('stats-words').dataset.mark || '',
    }));
    const before = await st();
    check('first render: nothing flashes', before.flashing.length === 0, JSON.stringify(before));

    // The refresh is scheduled just after the cron's next clock boundary.
    const sched = await page.evaluate(() => ({ at: window.WriteSysStats._nextRefreshAt, iv: window.WriteSysStats.data.interval_minutes }));
    const step = sched.iv * 60000;
    check('a refresh is scheduled just after the next cron run (on the clock)',
      sched.iv > 0 && sched.at % step === 20000 && sched.at > Date.now(), JSON.stringify(sched));

    // New numbers on the server → the refresh re-renders and the changed one flashes.
    psql(`UPDATE wordcount_history SET words_effective = words_effective + 123 WHERE manuscript_id=${M} AND day='${day}'`);
    await page.evaluate(() => window.WriteSysStats.load());
    const after = await st();
    check('the refresh shows the new number without a reload', after.words !== before.words, `${before.words} → ${after.words}`);
    check('…and flashes it (and only what changed)', after.flashing.includes('words') && !after.flashing.includes('goal') && !after.flashing.includes('birthday'), JSON.stringify(after.flashing));
    await page.waitForTimeout(200);
    await shot(page, 'stats-flash');
    await page.waitForFunction(() => !document.querySelector('.stats-flash'), null, { timeout: 4000 });
    check('the flash decays on its own', true);

    // Same data again → no re-render, no flash.
    await page.evaluate(() => { document.getElementById('stats-words').dataset.mark = 'same-node'; });
    await page.evaluate(() => window.WriteSysStats.load());
    const same = await st();
    check('an unchanged refresh leaves the pane alone (no re-render, no flash)', same.node === 'same-node' && same.flashing.length === 0, JSON.stringify(same));

    // A change while another pane shows flashes when you come back.
    await page.click('#pane-tabs .pane-tab[data-pane="outline"]');
    psql(`UPDATE wordcount_history SET words_effective = words_effective + 7 WHERE manuscript_id=${M} AND day='${day}'`);
    await page.evaluate(() => window.WriteSysStats.load());
    await page.click('#pane-tabs .pane-tab[data-pane="stats"]');
    const back = await st();
    check('a change that landed on another pane flashes when Statistics shows again', back.flashing.includes('words'), JSON.stringify(back));

    // Back to the tab after a while → it catches up.
    const refetched = await page.evaluate(async () => {
      const S = window.WriteSysStats;
      let n = 0;
      const orig = S.load.bind(S);
      S.load = () => { n++; return orig(); };
      S._loadedAt = Date.now() - 5 * 60000;
      S.onVisible();
      await new Promise((r) => setTimeout(r, 50));
      S.load = orig;
      return n;
    });
    check('coming back to the tab after a while catches up', refetched === 1, `loads=${refetched}`);
    await page.close();
  } catch (e) {
    check('run', false, e.message);
  } finally {
    if (lastDay) psql(`UPDATE wordcount_history SET words_effective=${orig} WHERE manuscript_id=${M} AND day='${day}'`);
    else psql(`DELETE FROM wordcount_history WHERE manuscript_id=${M} AND day='${day}'`);
  }
  await browser.close();
  console.log(failed ? '\n❌ some checks failed' : '\n✅ all passed');
  process.exit(failed ? 1 : 0);

  async function shot(p, name) { if (process.env.SHOT_DIR) await p.screenshot({ path: `${process.env.SHOT_DIR}/${name}.png` }); }
})();
