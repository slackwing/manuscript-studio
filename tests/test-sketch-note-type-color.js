// Picking a colored TYPE on a sketch note recolors the open float AT ONCE
// (2026-10-24). The float re-renders after the pick; for a sketch note that
// re-render re-fetched the note (to show a body derived server-side), and
// the fetch raced the color save — the float came back in the OLD color
// until closed and reopened.
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const { TEST_URL, loginAsTestUser, cleanupTestAnnotations } = require('./test-utils');
const HOME_URL = new URL('home.html', TEST_URL).href;
const psql = (sql) => execSync(`PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`, { encoding: 'utf8' }).trim();

(async () => {
  let failed = false;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed = true; };
  const T = `red-${Date.now().toString(36)}`;
  const browser = await chromium.launch({ headless: true });
  try {
    await cleanupTestAnnotations();
    psql(`INSERT INTO task_type (name, built_in, is_task, color, position) VALUES ('${T}', false, false, 'red', 0)`);
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    // Slow the save down so the race is deterministic: the color PUT
    // reaches the server only after the float has re-rendered.
    await page.route('**/api/notes/*', async (route) => {
      if (route.request().method() === 'PUT') await new Promise((r) => setTimeout(r, 700));
      return route.continue();
    });
    await loginAsTestUser(page);
    await page.goto(HOME_URL);
    await page.waitForSelector('.card-ghost[data-ghost="scratchpad"]');
    await page.click('.card-ghost[data-ghost="scratchpad"]');
    await page.waitForSelector('.spm-overlay .ProseMirror');
    await page.evaluate(() => window.WriteSysScratchpad.insertSketch());
    const sq = page.locator('.sn-widget .sn-note-solo').first();
    await sq.waitFor();
    await sq.dispatchEvent('mousedown');
    await page.waitForSelector('.sn-note-float .sticky-note.color-yellow');
    await page.locator('.sn-note-float .dim-chip.dim-type').click();
    await page.waitForSelector(`.dim-pop button[data-v="${T}"]`);
    await page.locator(`.dim-pop button[data-v="${T}"]`).click();
    const red = await page.waitForSelector('.sn-note-float .sticky-note.color-red', { timeout: 1500 }).then(() => true).catch(() => false);
    check('the open float turns red right away (no close/reopen)', red,
      await page.evaluate(() => (document.querySelector('.sn-note-float .sticky-note') || {}).className));
    await page.waitForTimeout(900); // past the slowed save
    check('…and stays red once the save lands', await page.locator('.sn-note-float .sticky-note.color-red').count() === 1);
    check('the sketch square is red too', await page.evaluate(() => /color-red/.test(document.querySelector('.sn-widget .sn-note-solo').className)));
    check('the type stuck', await page.locator('.sn-note-float .dim-chip.dim-type').innerText().then((t) => t.includes(T)));
  } catch (e) {
    check('run', false, e.message);
  } finally {
    psql(`UPDATE note SET task_type = NULL WHERE task_type='${T}'`);
    psql(`DELETE FROM task_type WHERE name='${T}'`);
  }
  await browser.close();
  console.log(failed ? '\n❌ some checks failed' : '\n✅ all passed');
  process.exit(failed ? 1 : 0);
})();
