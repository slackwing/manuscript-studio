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

  // --- COMPLETED today stays on today's page, wearing the done check ---
  const completeId = ids1[2];
  const cst = await page.evaluate(async ({ id, csrf }) => {
    const r = await fetch(`api/notes/${id}/complete`, { method: 'POST', credentials: 'same-origin',
      headers: { 'X-CSRF-Token': csrf } });
    return r.status;
  }, { id: completeId, csrf });
  check('completed a visible task via API', cst < 300, `status=${cst}`);
  await page.reload();
  await page.waitForSelector('.card-note', { timeout: 8000 });
  const afterComplete = await page.evaluate((id) => ({
    total: document.querySelectorAll('.card-note').length,
    stillThere: !!document.querySelector(`.card-note[data-note-id="${id}"]`),
    done: !!document.querySelector(`.card-note[data-note-id="${id}"].daily-done`),
  }), completeId);
  check('completed-today task still shown, marked done',
    afterComplete.stillThere && afterComplete.done && afterComplete.total === 16, JSON.stringify(afterComplete));

  // --- DAILY RULES: per-category caps with deterministic backfill ---
  // Recolor the pool for variety: seeds 1-6 → hone/green, 7-12 → edit/purple.
  psql(`UPDATE note SET task_type='hone', color='green' WHERE user_id='${TEST_USERNAME}' AND body ~ 'Daily seed ([1-6])$'`);
  psql(`UPDATE note SET task_type='edit', color='purple' WHERE user_id='${TEST_USERNAME}' AND body ~ 'Daily seed (7|8|9|10|11|12)$'`);
  const addRule = (body) => page.evaluate(async ({ body, csrf }) => {
    const r = await fetch('api/daily-rules', { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify(body) });
    return r.status;
  }, { body, csrf });
  check('rule hone ≤ 1 accepted', (await addRule({ task_type: 'hone', max_per_day: 1, tags: [] })) === 200);
  check('rule purple ≤ 2 accepted', (await addRule({ color: 'purple', max_per_day: 2, tags: [] })) === 200);
  await page.reload();
  await page.waitForSelector('.card-note', { timeout: 8000 });
  const ruled = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.card-note')];
    const types = cards.map(c => (c.querySelector('.dim-type') || {}).textContent || '');
    return {
      total: cards.length,
      hone: types.filter(t => t === 'hone').length,
      purple: cards.filter(c => c.classList.contains('color-purple')).length,
    };
  });
  // Pool: 6 hone + 6 purple + 6 write. Caps skip 5 hones and 4 purples →
  // 9 remain (below 16, so every eligible task shows).
  check('caps applied: ≤1 hone, ≤2 purple', ruled.hone === 1 && ruled.purple === 2, JSON.stringify(ruled));
  check('backfill keeps every eligible task (9 here)', ruled.total === 9, String(ruled.total));
  const ruledIds1 = await page.locator('.card-note').evaluateAll(cs => cs.map(c => c.dataset.noteId));
  await page.reload();
  await page.waitForSelector('.card-note', { timeout: 8000 });
  const ruledIds2 = await page.locator('.card-note').evaluateAll(cs => cs.map(c => c.dataset.noteId));
  check('ruled pick is deterministic across reloads', ruledIds1.join(',') === ruledIds2.join(','));
  // Removing the rules restores the plain 16.
  const ruleIds = await page.evaluate(async () => (await (await fetch('api/daily-rules', { credentials: 'same-origin' })).json()).rules.map(r => r.rule_id));
  for (const id of ruleIds) {
    await page.evaluate(async ({ id, csrf }) => {
      await fetch(`api/daily-rules/${id}`, { method: 'DELETE', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrf } });
    }, { id, csrf });
  }
  await page.reload();
  await page.waitForSelector('.card-note', { timeout: 8000 });
  check('deleting rules restores the plain 16', (await page.locator('.card-note').count()) === 16);

  // Book strip: the daily-tasks button (right of settings) routes to this view.
  await page.goto(TEST_URL);
  await page.waitForSelector('#mc-daily', { timeout: 30000 });
  check('daily button sits right of settings', await page.evaluate(() => {
    const s = document.getElementById('mc-settings');
    const d = document.getElementById('mc-daily');
    return !!s && !!d && s.nextElementSibling === d;
  }));
  await page.click('#mc-daily');
  await page.waitForURL(/home\.html\?view=daily&manuscript_id=\d+/, { timeout: 15000 });
  check('daily button lands on the daily view for this manuscript', true);

  await cleanupTestNotes();
  await browser.close();
  process.exit(failed ? 1 : 0);
})();
