// Daily tasks (manuscript card link → home.html?view=daily&manuscript_id=N):
// a date-seeded deterministic pick of up to 16 of the manuscript's live TASK
// notes, drawn only from notes created before today — same day, same data →
// same set. Notes awarded points today dim under a big gold check but stay
// clickable. Today-created and non-task notes never appear.
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const { TEST_URL, TEST_USERNAME, TEST_MANUSCRIPT_ID, cleanupTestNotes, loginAsTestUser } = require('./test-utils');
const HOME_URL = new URL('home.html', TEST_URL).href;
function psql(sql) {
  return execSync(
    `PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8' }).trim();
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1200 } });
  page.on('dialog', d => d.accept());
  let failed = false;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed = true; };

  await cleanupTestNotes();
  const M = TEST_MANUSCRIPT_ID;
  // 18 eligible task notes (created yesterday), 2 today-created tasks and one
  // yesterday non-task — the latter three must never appear.
  psql(`INSERT INTO note (user_id, color, body, priority, task_type, position, manuscript_id, created_at)
        SELECT '${TEST_USERNAME}', 'yellow', 'Daily seed ' || i, 'can', 'write', 'a' || i, ${M}, now() - interval '1 day'
        FROM generate_series(1, 18) i`);
  psql(`INSERT INTO note (user_id, color, body, priority, task_type, position, manuscript_id)
        SELECT '${TEST_USERNAME}', 'green', 'Today task ' || i, 'can', 'write', 'b' || i, ${M}
        FROM generate_series(1, 2) i`);
  psql(`INSERT INTO note (user_id, color, body, position, manuscript_id, created_at)
        VALUES ('${TEST_USERNAME}', 'blue', 'Yesterday non-task', 'c0', ${M}, now() - interval '1 day')`);

  await loginAsTestUser(page);
  await page.goto(HOME_URL);
  await page.waitForSelector('.card-manuscript');

  // --- The card link ---
  const link = page.locator(`.ms-daily-link[data-daily="${M}"]`);
  check('manuscript card shows "daily tasks" link', await link.count() === 1);
  check('link reads "daily tasks"', (await link.innerText()).trim() === 'daily tasks');
  await link.click();
  await page.waitForURL(/view=daily/);
  await page.waitForSelector('.card-note', { timeout: 8000 });
  check('link navigates to the daily view', page.url().includes(`manuscript_id=${M}`));

  // --- 16 of the 18 eligible; none from today, none non-task ---
  const bodies = await page.locator('.card-note').allInnerTexts();
  check('shows exactly 16 cards', bodies.length === 16, `cards=${bodies.length}`);
  check('all cards are eligible seeds', bodies.every(b => b.includes('Daily seed')));
  check('today-created and non-task notes excluded',
    !bodies.some(b => b.includes('Today task') || b.includes('Yesterday non-task')));

  // --- Deterministic: same set, same order, across reloads ---
  const ids1 = await page.locator('.card-note').evaluateAll(cs => cs.map(c => c.dataset.noteId));
  await page.reload();
  await page.waitForSelector('.card-note', { timeout: 8000 });
  const ids2 = await page.locator('.card-note').evaluateAll(cs => cs.map(c => c.dataset.noteId));
  check('same 16 in the same order after reload', ids1.join(',') === ids2.join(','), `${ids1.length} vs ${ids2.length}`);

  // --- Points awarded today → dimmed + gold check, still clickable ---
  const doneId = ids1[0];
  const csrf = await page.evaluate(() => sessionStorage.getItem('csrf_token'));
  const st = await page.evaluate(async ({ id, csrf }) => {
    const r = await fetch(`api/notes/${id}/points`, { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({ points: 3 }) });
    return r.status;
  }, { id: doneId, csrf });
  check('points awarded via API', st < 300, `status=${st}`);
  await page.reload();
  await page.waitForSelector('.card-note', { timeout: 8000 });
  const doneCard = page.locator(`.card-note[data-note-id="${doneId}"]`);
  check('awarded note is marked done', await doneCard.evaluate(el => el.classList.contains('daily-done')));
  check('gold check overlaid', await doneCard.locator('.daily-check svg').count() === 1);
  check('other cards not marked', await page.locator('.card-note.daily-done').count() === 1);
  check('overlay does not swallow clicks', await doneCard.locator('.daily-check').evaluate(
    el => getComputedStyle(el).pointerEvents === 'none'));
  const ids3 = await page.locator('.card-note').evaluateAll(cs => cs.map(c => c.dataset.noteId));
  check('the set itself is unchanged by scoring', ids1.join(',') === ids3.join(','));

  await cleanupTestNotes();
  await browser.close();
  process.exit(failed ? 1 : 0);
})();
