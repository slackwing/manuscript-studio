// Points on a NON-task type (051): task_type.scores_points lets a non-task
// type (on prod: material) earn points — the ★ shows on its notes (no
// check / blocked / priority, those stay task-only) and the server accepts
// the score. The settings page's non-task chips carry the ★ toggle.
// SHOT_DIR=<dir> also saves screenshots.
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const { TEST_URL, TEST_USERNAME, TEST_MANUSCRIPT_ID, loginAsTestUser, waitForPagination, cleanupTestNotes } = require('./test-utils');
function psql(sql) {
  return execSync(`PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`, { encoding: 'utf8' }).trim();
}

(async () => {
  let failed = false;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed = true; };
  const shot = async (p, name) => { if (process.env.SHOT_DIR) await p.screenshot({ path: `${process.env.SHOT_DIR}/${name}.png` }); };
  const U = TEST_USERNAME, M = TEST_MANUSCRIPT_ID;
  const T = `mat-${Date.now().toString(36)}`;
  const browser = await chromium.launch({ headless: true });
  try {
    await cleanupTestNotes();
    psql(`INSERT INTO task_type (name, built_in, is_task, color, position) VALUES ('${T}', false, false, 'yellow', 0)`);
    const flag = () => psql(`SELECT scores_points FROM task_type WHERE name='${T}'`);

    // ---- settings: the ★ on non-task chips -------------------------------
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    await loginAsTestUser(page);
    await page.goto(new URL('settings.html', TEST_URL).href);
    const chip = page.locator('#nt-chips .tt-chip', { hasText: T });
    await chip.waitFor();
    check('a non-task chip carries the ★, unlit by default', (await chip.locator('.tt-points:not(.active)').count()) === 1);
    check('task chips carry no ★', (await page.locator('#tt-chips .tt-points').count()) === 0);
    await chip.locator('.tt-points').click();
    await page.waitForFunction(() => true);
    for (let i = 0; i < 20 && flag() !== 't'; i++) await page.waitForTimeout(150);
    check('clicking it flags the type (scores_points)', flag() === 't');
    check('…and lights it', (await chip.locator('.tt-points.active').count()) === 1);
    check('…without arming the chip for delete', !(await chip.evaluate((c) => c.classList.contains('tt-armed'))));
    await shot(page, 'settings-points');

    // ---- the book: ★ on the type's notes, scoring lands -------------------
    await page.goto(TEST_URL);
    await waitForPagination(page);
    const sid = await page.evaluate(() => document.querySelectorAll('.pagedjs_pages .sentence[data-sentence-id]')[2].dataset.sentenceId);
    psql(`INSERT INTO note (user_id, color, body, priority, task_type, position, manuscript_id, sentence_id) VALUES
      ('${U}', 'yellow', 'Material note', 'none', '${T}', 'm1', ${M}, '${sid}'),
      ('${U}', 'yellow', 'Reminder note', 'none', 'reminder', 'm2', ${M}, '${sid}')`);
    const idOf = (b) => psql(`SELECT note_id FROM note WHERE body='${b}' AND user_id='${U}'`);
    const noteSel = (b) => `#sticky-notes-container .sticky-note[data-annotation-id="${idOf(b)}"]`;
    const shown = (b) => page.evaluate((s) => {
      const n = document.querySelector(s);
      const vis = (c) => { const e = n.querySelector(c); return !!e && getComputedStyle(e).display !== 'none'; };
      return { star: vis('.points-star'), check: vis('.complete-check'), blocked: vis('.blocked-chip'), priority: vis('.dim-priority') };
    }, noteSel(b));
    await page.reload();
    await waitForPagination(page);
    await page.locator(`.pagedjs_pages .sentence[data-sentence-id="${sid}"]`).first().click();
    await page.waitForSelector(noteSel('Material note'));
    const mat = await shown('Material note');
    check('a material-type note shows the ★', mat.star, JSON.stringify(mat));
    check('…but no check / blocked / priority (still not a task)', !mat.check && !mat.blocked && !mat.priority, JSON.stringify(mat));
    const rem = await shown('Reminder note');
    check('a non-scoring non-task type shows no ★', !rem.star, JSON.stringify(rem));
    await page.click(`${noteSel('Material note')} .points-star`);
    await page.keyboard.type('3');
    await page.keyboard.press('Enter');
    const pts = () => psql(`SELECT coalesce(string_agg(points::text || ':' || from_daily::text, ','), '') FROM point_event WHERE note_id=${idOf('Material note')}`);
    for (let i = 0; i < 20 && !pts(); i++) await page.waitForTimeout(150);
    check('★ → 3 → Enter scores 3 points (gold: never on the daily board)', pts() === '3:false', pts());
    await page.locator(noteSel('Material note')).scrollIntoViewIfNeeded();
    await shot(page, 'material-note-desktop');

    // ---- the server gates the same way -------------------------------------
    const csrf = await page.evaluate(() => sessionStorage.getItem('csrf_token') || localStorage.getItem('csrf_token') || '');
    const score = (id) => page.evaluate(async ({ id, csrf }) => (await fetch(`api/notes/${id}/points`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ points: 2 }),
    })).status, { id, csrf });
    check('server refuses points on a non-scoring non-task note', (await score(idOf('Reminder note'))) === 400);
    const off = await page.evaluate(async ({ T, csrf }) => (await fetch(`api/task-types/${T}/points`, {
      method: 'PUT', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ scores_points: false }),
    })).status, { T, csrf });
    check('flag off via the API → 204', off === 204 && flag() === 'f');
    check('…then the server refuses the type\'s points', (await score(idOf('Material note'))) === 400);
    await page.evaluate(async ({ T, csrf }) => fetch(`api/task-types/${T}/points`, {
      method: 'PUT', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ scores_points: true }),
    }), { T, csrf });
    check('…and accepts them once it\'s back on', (await score(idOf('Material note'))) === 204);
    await page.close();

    // ---- phone ----------------------------------------------------------------
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await loginAsTestUser(phone);
    await phone.goto(TEST_URL);
    await waitForPagination(phone);
    // Phone: the second tap opens the suggest-edit modal and its note stack.
    await phone.evaluate(() => { window.WriteSysRenderer.currentSelectedSentenceId = null; });
    const span = phone.locator(`.pagedjs_pages .sentence[data-sentence-id="${sid}"]`).first();
    await span.click();
    await phone.waitForTimeout(300);
    await span.click();
    const pSel = `#sgm-notes-stack .sticky-note[data-annotation-id="${idOf('Material note')}"]`;
    await phone.waitForSelector(pSel);
    const pStar = await phone.evaluate((s) => [...document.querySelectorAll(s)].some((n) => {
      const e = n.querySelector('.points-star'); return e && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0;
    }), pSel);
    check('phone: the material note shows the ★ too', pStar);
    await phone.locator(pSel).scrollIntoViewIfNeeded();
    await shot(phone, 'material-note-phone');
    await phone.close();
  } catch (e) {
    check('run', false, e.message);
  } finally {
    psql(`DELETE FROM point_event WHERE note_id IN (SELECT note_id FROM note WHERE task_type='${T}')`);
    psql(`DELETE FROM note WHERE task_type='${T}' OR body='Reminder note'`);
    psql(`DELETE FROM task_type WHERE name='${T}'`);
  }
  await browser.close();
  console.log(failed ? '\n❌ some checks failed' : '\n✅ all passed');
  process.exit(failed ? 1 : 0);
})();
