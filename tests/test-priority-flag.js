/**
 * Task dimensions (031/032): the type dropdown chip makes a note a TASK
 * (revealing priority/impact dropdown chips + blocked/star/check), the
 * blocked chip is an independent flag, and everything persists.
 */
const { chromium } = require('playwright');
const { TEST_URL, cleanupTestAnnotations, loginAsTestUser, waitForPagination } = require('./test-utils');
const { execSync } = require('child_process');
const psql = (sql) => execSync(
  `PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`,
  { encoding: 'utf-8' }).trim();

(async () => {
  console.log('=== Task Dimensions Test ===\n');
  await cleanupTestAnnotations();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  let failed = 0;
  const check = (n, ok, extra) => { console.log(`${ok ? '✓' : '✗'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed++; };

  await loginAsTestUser(page);
  await page.goto(TEST_URL);
  await page.waitForSelector('.sentence', { timeout: 30000 });
  await waitForPagination(page);
  await page.locator('.sentence').first().click();
  await page.waitForSelector('.sticky-note.uncreated-note.first-uncreated');
  const cc = page.locator('.sticky-note.uncreated-note.first-uncreated .sticky-note-color-circle');
  await cc.hover();
  await page.waitForSelector('.sticky-note.uncreated-note.first-uncreated .sticky-note-palette.visible');
  await page.locator('.sticky-note.uncreated-note.first-uncreated .sticky-note-palette .color-circle[data-color="yellow"]').click();
  await page.waitForSelector('.sticky-note:not(.uncreated-note)');
  await page.waitForTimeout(500);
  const NOTE = '.sticky-note:not(.uncreated-note)';
  const noteId = await page.locator(NOTE).first().evaluate(el => el.dataset.noteId || el.dataset.annotationId);

  // 1. Fresh note: type chip reads 'reminder'; no priority/impact chips;
  //    blocked/star/check hidden; trash right-pinned.
  const typeChip = page.locator(`${NOTE} .dim-chip.dim-type`);
  check('type chip present, reads reminder', (await typeChip.locator('.dim-label').innerText()) === 'reminder');
  check('no priority chip while reminder', (await page.locator(`${NOTE} .dim-priority`).count()) === 0);
  check('no impact chip while reminder', (await page.locator(`${NOTE} .dim-impact`).count()) === 0);
  const hiddenBits = await page.evaluate((sel) => {
    const q = (c) => { const el = document.querySelector(`${sel} ${c}`); return el ? getComputedStyle(el).display === 'none' : null; };
    return { blocked: q('.blocked-chip'), star: q('.points-star'), check: q('.complete-check') };
  }, NOTE);
  check('blocked/star/check hidden for reminders', hiddenBits.blocked && hiddenBits.star && hiddenBits.check, JSON.stringify(hiddenBits));
  const trashPin = await page.evaluate((sel) => {
    const row = document.querySelector(`${sel} .priority-flag-chips`).getBoundingClientRect();
    const tr = document.querySelector(`${sel} .note-trash`).getBoundingClientRect();
    return Math.round(row.right - tr.right);
  }, NOTE);
  check('trash pinned to slot 8 (right edge)', Math.abs(trashPin) <= 1, `gap=${trashPin}`);

  // 2. Pick a type → TASK: priority (can) + impact (n/a) chips appear;
  //    blocked/star/check reveal.
  await typeChip.click();
  await page.waitForSelector('.dim-pop button[data-v="write"]');
  const optionCount = await page.locator('.dim-pop button').count();
  check('type dropdown lists built-ins', optionCount >= 11, `options=${optionCount}`);
  await page.locator('.dim-pop button[data-v="write"]').click();
  await page.waitForSelector(`${NOTE} .dim-priority`);
  check('priority chip appears, defaults can', (await page.locator(`${NOTE} .dim-priority .dim-label`).innerText()) === 'can');
  check('impact chip appears, defaults n/a', (await page.locator(`${NOTE} .dim-impact .dim-label`).innerText()) === 'n/a');
  await page.waitForTimeout(400);
  check('DB: task_type + default priority saved',
    psql(`SELECT task_type || '|' || priority FROM note WHERE note_id=${noteId}`) === 'write|can');
  const shown = await page.evaluate((sel) => {
    const q = (c) => getComputedStyle(document.querySelector(`${sel} ${c}`)).display !== 'none';
    return q('.blocked-chip') && q('.points-star') && q('.complete-check');
  }, NOTE);
  check('blocked/star/check revealed for tasks', shown);

  // 3. Bottom-row slots: link circle(1) blocked(2) star(3) check(4) … trash(8).
  const slots = await page.evaluate((sel) => {
    const row = document.querySelector(`${sel} .priority-flag-chips`).getBoundingClientRect();
    const ms = document.querySelector(`${sel} .note-ms-slot`).getBoundingClientRect();
    const bl = document.querySelector(`${sel} .blocked-chip`).getBoundingClientRect();
    const st = document.querySelector(`${sel} .points-star`).getBoundingClientRect();
    const ck = document.querySelector(`${sel} .complete-check`).getBoundingClientRect();
    const tr = document.querySelector(`${sel} .note-trash`).getBoundingClientRect();
    const pitch = 26 + (row.width - 208) / 7;
    return {
      msSpan: ms.width,
      blockedStep: bl.left - ms.left,
      starStep: st.left - bl.left, checkStep: ck.left - st.left, pitch,
      trashRight: Math.round(row.right - tr.right),
    };
  }, NOTE);
  check('ms slot is one circle slot (26px)', Math.abs(slots.msSpan - 26) <= 1, `${slots.msSpan.toFixed(1)}`);
  check('link(1)→blocked(2)→star(3)→check(4) march at slot pitch',
    Math.abs(slots.blockedStep - slots.pitch) <= 1 && Math.abs(slots.starStep - slots.pitch) <= 1 && Math.abs(slots.checkStep - slots.pitch) <= 1,
    JSON.stringify({ blocked: slots.blockedStep.toFixed(1), star: slots.starStep.toFixed(1), check: slots.checkStep.toFixed(1), pitch: slots.pitch.toFixed(1) }));
  check('trash still right edge (slot 8)', Math.abs(slots.trashRight) <= 1);

  // 4. Priority + impact dropdowns persist.
  await page.locator(`${NOTE} .dim-priority`).click();
  await page.waitForSelector('.dim-pop button[data-v="must"]');
  await page.locator('.dim-pop button[data-v="must"]').click();
  await page.waitForTimeout(400);
  check('priority=must saved', psql(`SELECT priority FROM note WHERE note_id=${noteId}`) === 'must');
  await page.locator(`${NOTE} .dim-impact`).click();
  await page.waitForSelector('.dim-pop button[data-v="chapter"]');
  await page.locator('.dim-pop button[data-v="chapter"]').click();
  await page.waitForTimeout(400);
  check('impact=chapter saved', psql(`SELECT impact FROM note WHERE note_id=${noteId}`) === 'chapter');

  // 5. Blocked toggles independently.
  await page.locator(`${NOTE} .blocked-chip`).click();
  await page.waitForTimeout(400);
  check('blocked=true saved', psql(`SELECT blocked FROM note WHERE note_id=${noteId}`) === 't');
  check('blocked chip shows active', await page.locator(`${NOTE} .blocked-chip`).evaluate(el => el.classList.contains('active')));
  await page.locator(`${NOTE} .blocked-chip`).click();
  await page.waitForTimeout(400);
  check('blocked toggles back off', psql(`SELECT blocked FROM note WHERE note_id=${noteId}`) === 'f');

  // 6. Everything survives reload.
  await page.reload();
  await page.waitForSelector('.sentence', { timeout: 30000 });
  await waitForPagination(page);
  await page.locator('.sentence').first().click();
  await page.waitForSelector(NOTE, { timeout: 8000 });
  await page.waitForSelector(`${NOTE} .dim-priority`, { timeout: 8000 });
  check('dims persist after reload',
    (await page.locator(`${NOTE} .dim-chip.dim-type .dim-label`).innerText()) === 'write' &&
    (await page.locator(`${NOTE} .dim-priority .dim-label`).innerText()) === 'must' &&
    (await page.locator(`${NOTE} .dim-impact .dim-label`).innerText()) === 'chapter');

  await browser.close();
  await cleanupTestAnnotations();
  console.log(failed === 0 ? '\n✅ All Task Dimension Tests Passed!' : `\n❌ ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('Test crashed:', e); process.exit(1); });
