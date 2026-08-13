// Tag autocomplete: typing in any +tag input suggests EXISTING tags matching
// the prefix, most-used first, each with its live count (×N). ArrowDown/Up
// cycle (wrapping), Enter confirms the highlighted tag. Source = GET
// /api/tag-counts, cached in localStorage and busted on tag add/remove.
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const { TEST_URL, TEST_USERNAME, loginAsTestUser } = require('./test-utils');
const HOME_URL = new URL('home.html', TEST_URL).href;
const psql = (sql) => execSync(
  `PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`,
  { encoding: 'utf-8' }).trim().split('\n')[0];

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  let failed = false;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed = true; };

  // Fixture: tags "ideas" on 3 notes, "imagery" on 1, "plot" on 1.
  const wipe = () => {
    psql(`DELETE FROM note_tag WHERE tag_id IN (SELECT tag_id FROM tag WHERE user_id='${TEST_USERNAME}' AND tag_name IN ('ideas','imagery','plot'))`);
    psql(`DELETE FROM tag WHERE user_id='${TEST_USERNAME}' AND tag_name IN ('ideas','imagery','plot')`);
    psql(`DELETE FROM note WHERE user_id='${TEST_USERNAME}' AND body LIKE 'tagac fixture%'`);
  };
  wipe();
  const noteIds = [1, 2, 3].map((i) =>
    psql(`INSERT INTO note (user_id, color, body, position) VALUES ('${TEST_USERNAME}','yellow','tagac fixture note ${i}','a${i}') RETURNING note_id`));
  const tagId = (name) => psql(`INSERT INTO tag (tag_name, user_id) VALUES ('${name}','${TEST_USERNAME}') RETURNING tag_id`);
  const ideas = tagId('ideas'), imagery = tagId('imagery'), plot = tagId('plot');
  noteIds.forEach((n) => psql(`INSERT INTO note_tag (note_id, tag_id) VALUES (${n},${ideas})`));
  psql(`INSERT INTO note_tag (note_id, tag_id) VALUES (${noteIds[0]},${imagery})`);
  psql(`INSERT INTO note_tag (note_id, tag_id) VALUES (${noteIds[1]},${plot})`);

  await loginAsTestUser(page);
  await page.goto(HOME_URL);
  await page.waitForSelector('#home-root');

  // API shape: ranked by live-note usage.
  const counts = await page.evaluate(async () => (await (await fetch('api/tag-counts', { credentials: 'same-origin' })).json()).tags);
  const mine = counts.filter((t) => ['ideas', 'imagery', 'plot'].includes(t.tag_name));
  check('tag-counts ranks by usage', mine[0] && mine[0].tag_name === 'ideas' && mine[0].count === 3,
    JSON.stringify(mine));

  // All-notes filter row: type "i" → dropdown [ideas ×3, imagery ×1].
  await page.goto(new URL('home.html?view=notes', HOME_URL).href);
  await page.waitForSelector('#nf-crit .dr-tag-input');
  const inp = page.locator('#nf-crit .dr-tag-input');
  await inp.click();
  await inp.type('i');
  await page.waitForSelector('.tag-suggest .tag-suggest-row', { timeout: 5000 });
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('.tag-suggest .tag-suggest-row')].map((r) => r.textContent.trim()));
  check('suggestions: prefix matches, most-common first, with counts',
    rows[0] === 'ideas×3' && rows[1] === 'imagery×1', JSON.stringify(rows));
  check('non-matching tag (plot) not suggested', !rows.some((r) => r.startsWith('plot')), JSON.stringify(rows));

  // ArrowDown cycles with wrap; Enter confirms the highlighted tag.
  await inp.press('ArrowDown');
  let active = await page.evaluate(() => { const a = document.querySelector('.tag-suggest-row.active'); return a && a.textContent.trim(); });
  check('ArrowDown highlights the first suggestion', active === 'ideas×3', active);
  await inp.press('ArrowDown');
  active = await page.evaluate(() => { const a = document.querySelector('.tag-suggest-row.active'); return a && a.textContent.trim(); });
  check('ArrowDown again moves to the second', active === 'imagery×1', active);
  await inp.press('ArrowDown');
  active = await page.evaluate(() => { const a = document.querySelector('.tag-suggest-row.active'); return a && a.textContent.trim(); });
  check('cycling wraps back to the first', active === 'ideas×3', active);
  await inp.press('Enter');
  await page.waitForFunction(() =>
    [...document.querySelectorAll('#nf-crit .tag-chip')].some((c) => c.textContent.includes('ideas')), null, { timeout: 5000 });
  check('Enter confirms the highlighted tag into the filter', true);
  // Filter applied: only the 3 "ideas" notes remain.
  await page.waitForFunction(() => document.querySelectorAll('.card-note').length === 3, null, { timeout: 5000 });
  check('filter narrows the grid to the tagged notes', true);

  // Cache landed in localStorage.
  check('counts cached in localStorage',
    await page.evaluate(() => !!localStorage.getItem('ms_tag_counts')));

  wipe();
  console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS');
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('Test crashed:', e); process.exit(1); });
