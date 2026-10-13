// Daily-tasks PINS (048) e2e: a note pinned to its manuscript's daily board
// always shows there — first, most recently pinned first — even a task
// created today. Pins overrule the daily rules but COUNT against them: a
// pinned hone spends a 1-hone rule's quota, so no random hone that day.
// UI: the sticky note's pin chip sits between blocked and the star (tasks
// with a manuscript only); a landing/daily card has a faint pushpin in its
// bottom-right corner that darkens under the pointer and pins on click
// without opening the note. The daily board is at most 4 cards across.
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const { TEST_URL, TEST_USERNAME, TEST_MANUSCRIPT_ID, cleanupTestNotes, loginAsTestUser, waitForPagination } = require('./test-utils');
const HOME_URL = new URL('home.html', TEST_URL).href;
function psql(sql) {
  return execSync(
    `PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8' }).trim();
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
  page.on('dialog', (d) => d.accept());
  let failed = false;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed = true; };
  const M = TEST_MANUSCRIPT_ID;
  const U = TEST_USERNAME;

  try {
    await cleanupTestNotes();
    psql(`DELETE FROM daily_rule WHERE user_id='${U}'`);
    // Pool: 8 eligible (yesterday) tasks — seeds 1-4 hone, 5-8 write — plus
    // two tasks created TODAY (never in the day's random pick) and a
    // yesterday non-task.
    psql(`INSERT INTO note (user_id, color, body, priority, task_type, position, manuscript_id, created_at)
          SELECT '${U}', 'yellow', 'Pin seed ' || i, 'can', CASE WHEN i <= 4 THEN 'hone' ELSE 'write' END,
                 'a' || i, ${M}, now() - interval '1 day'
          FROM generate_series(1, 8) i`);
    psql(`INSERT INTO note (user_id, color, body, priority, task_type, position, manuscript_id)
          VALUES ('${U}', 'green', 'Today hone', 'can', 'hone', 'b1', ${M}),
                 ('${U}', 'green', 'Today write', 'can', 'write', 'b2', ${M})`);
    psql(`INSERT INTO note (user_id, color, body, position, manuscript_id, created_at)
          VALUES ('${U}', 'blue', 'Plain note', 'c0', ${M}, now() - interval '1 day')`);
    const idOf = (body) => parseInt(psql(`SELECT note_id FROM note WHERE user_id='${U}' AND body='${body}'`), 10);

    await loginAsTestUser(page);
    await page.goto(HOME_URL);
    await page.waitForSelector('.card-manuscript', { timeout: 15000 });
    const csrf = await page.evaluate(() => sessionStorage.getItem('csrf_token') || localStorage.getItem('csrf_token') || '');
    const board = () => page.evaluate(async (M) =>
      (await (await fetch(`api/daily-tasks?manuscript_id=${M}`, { credentials: 'same-origin' })).json()).notes.map((n) => n.body), M);
    const pin = (id, on) => page.evaluate(async ({ id, on, csrf }) =>
      (await fetch(`api/notes/${id}/${on ? 'pin' : 'unpin'}`, { method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrf } })).status,
    { id, on, csrf });
    const hones = (b) => b.filter((x) => /^Pin seed [1-4]$/.test(x)).length;

    // ---- the API: pins first, rules counted ----
    const plain = await board();
    check('no pins: the 8 eligible, nothing from today', plain.length === 8 && !plain.some((b) => b.startsWith('Today') || b === 'Plain note'), JSON.stringify(plain));
    const ruleStatus = await page.evaluate(async (csrf) => (await fetch('api/daily-rules', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({ task_type: 'hone', max_per_day: 1, tags: [] }),
    })).status, csrf);
    check('rule hone ≤ 1 accepted', ruleStatus === 200, String(ruleStatus));
    const ruled = await board();
    check('rule alone: 1 random hone + 4 write', ruled.length === 5 && hones(ruled) === 1, JSON.stringify(ruled));

    check('pin the TODAY hone → 204', (await pin(idOf('Today hone'), true)) === 204);
    const p1 = await board();
    check('a pinned task created today shows — first', p1[0] === 'Today hone', JSON.stringify(p1));
    check('the pinned hone spends the 1-hone quota: no random hone', hones(p1) === 0 && p1.length === 5, JSON.stringify(p1));

    check('pin a hone seed too → 204', (await pin(idOf('Pin seed 2'), true)) === 204);
    const p2 = await board();
    check('pins overrule the cap (two hones) — most recently pinned first',
      p2[0] === 'Pin seed 2' && p2[1] === 'Today hone' && hones(p2) === 1 && p2.length === 6, JSON.stringify(p2));

    await pin(idOf('Pin seed 2'), false);
    await pin(idOf('Today hone'), false);
    const back = await board();
    check('unpinning restores the ruled board', JSON.stringify(back) === JSON.stringify(ruled), JSON.stringify(back));
    psql(`DELETE FROM daily_rule WHERE user_id='${U}'`);

    // ---- the landing card pin ----
    await page.reload();
    await page.waitForSelector('.card-note', { timeout: 15000 });
    const cardSel = (body) => page.locator('.card-note', { hasText: body }).first();
    const todayWrite = cardSel('Today write');
    const pinEl = todayWrite.locator('.card-pin');
    check('a task card wears the pushpin', await pinEl.count() === 1);
    check('a non-task card has none', await cardSel('Plain note').locator('.card-pin').count() === 0);
    const corner = await todayWrite.evaluate((card) => {
      const c = card.getBoundingClientRect();
      const p = card.querySelector('.card-pin').getBoundingClientRect();
      return { right: Math.round(c.right - p.right), bottom: Math.round(c.bottom - p.bottom) };
    });
    check('the pin sits in the bottom-right corner', corner.right <= 12 && corner.bottom <= 12, JSON.stringify(corner));
    const faint = await pinEl.evaluate((el) => +getComputedStyle(el).opacity);
    await pinEl.hover();
    await page.waitForFunction((sel) => +getComputedStyle(document.querySelector(sel)).opacity > 0.5,
      `.card-note[data-note-id="${idOf('Today write')}"] .card-pin`, { timeout: 2000 }).catch(() => {});
    const hovered = await pinEl.evaluate((el) => +getComputedStyle(el).opacity);
    check('faint at rest, darker under the pointer', faint < 0.3 && hovered > 0.5, `${faint} → ${hovered}`);
    const urlBefore = page.url();
    await pinEl.click();
    await page.waitForFunction((id) => !!document.querySelector(`.card-note[data-note-id="${id}"] .card-pin.pinned`), idOf('Today write'));
    await page.waitForFunction(() => true);
    const pinnedAt = psql(`SELECT pinned_at IS NOT NULL FROM note WHERE note_id=${idOf('Today write')}`);
    check('clicking pins it (lit, stored)', pinnedAt === 't');
    check('…without opening the note', page.url() === urlBefore
      && await page.locator('.spm-overlay').count() === 0);
    const p3 = await board();
    check('the card-pinned task (created today) heads the board', p3[0] === 'Today write', JSON.stringify(p3));

    // ---- the daily view: at most 4 across ----
    await page.goto(`${HOME_URL}?view=daily&manuscript_id=${M}`);
    await page.waitForSelector('.daily-grid .card-note', { timeout: 15000 });
    const tracks = () => page.evaluate(() =>
      getComputedStyle(document.querySelector('.daily-grid')).gridTemplateColumns.split(' ').filter(Boolean).length);
    check('wide window: the daily board is 4 across', (await tracks()) === 4, String(await tracks()));
    check('the pinned card shows lit on the board', await page.locator('.daily-grid .card-note').first().locator('.card-pin.pinned').count() === 1);
    await page.setViewportSize({ width: 760, height: 1200 });
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.daily-grid')).gridTemplateColumns.split(' ').length < 4);
    check('narrow window: fewer columns', (await tracks()) < 4, String(await tracks()));
    await page.setViewportSize({ width: 1600, height: 1200 });

    // ---- the sticky note's pin chip ----
    await page.goto(TEST_URL);
    await waitForPagination(page);
    const sid = await page.evaluate(() => document.querySelector('.pagedjs_pages .sentence[data-sentence-id]').dataset.sentenceId);
    psql(`INSERT INTO note (user_id, color, body, priority, task_type, position, manuscript_id, sentence_id)
          VALUES ('${U}', 'yellow', 'Chip note', 'can', 'write', 'd0', ${M}, '${sid}')`);
    await page.reload();
    await waitForPagination(page);
    await page.locator(`.pagedjs_pages .sentence[data-sentence-id="${sid}"]`).first().click();
    await page.waitForSelector('.sticky-note:not(.uncreated-note) .pin-chip', { timeout: 8000 });
    const order = await page.evaluate(() => {
      const row = document.querySelector('.sticky-note:not(.uncreated-note) .priority-flag-chips');
      return [...row.children].map((c) => c.className.split(' ')[0]);
    });
    const bi = order.indexOf('blocked-chip'), pi = order.indexOf('pin-chip'), si = order.indexOf('points-star');
    check('the pin sits between blocked and the star', bi >= 0 && pi === bi + 1 && si === pi + 1, order.join(' '));
    const chip = page.locator('.sticky-note:not(.uncreated-note) .pin-chip');
    check('a task with a manuscript shows the pin, unlit', await chip.isVisible() && !(await chip.evaluate((el) => el.classList.contains('active'))));
    await chip.click();
    await page.waitForFunction(() => document.querySelector('.sticky-note:not(.uncreated-note) .pin-chip.active'));
    const chipId = idOf('Chip note');
    const stored = () => psql(`SELECT pinned_at IS NOT NULL FROM note WHERE note_id=${chipId}`);
    for (let i = 0; i < 20 && stored() !== 't'; i++) await page.waitForTimeout(100);
    check('clicking the chip pins the note', stored() === 't');
    await chip.click();
    for (let i = 0; i < 20 && stored() !== 'f'; i++) await page.waitForTimeout(100);
    check('clicking again unpins it', stored() === 'f'
      && !(await chip.evaluate((el) => el.classList.contains('active'))));
  } catch (e) {
    console.log(`❌ Test errored: ${e.message}`);
    failed = true;
  } finally {
    psql(`DELETE FROM daily_rule WHERE user_id='${U}'`);
    await browser.close();
    await cleanupTestNotes();
  }
  console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS');
  process.exit(failed ? 1 : 0);
})();
