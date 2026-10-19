// The grey create card (no note yet) carries the SAME type chip as a real
// note — "n/a" until picked (2026-10-18). Picking a type CREATES the note,
// like typing does: the type set (priority 'can' for task types) and the
// note in the type's color (the default color for 'gray' types). No
// never-mind: switching the type back to n/a keeps the note.
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const { TEST_URL, TEST_USERNAME, loginAsTestUser, waitForPagination, cleanupTestNotes } = require('./test-utils');
function psql(sql) {
  return execSync(`PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`, { encoding: 'utf8' }).trim();
}
const TYPE = 'zz-ucolor';

(async () => {
  let failed = false;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed = true; };
  const browser = await chromium.launch({ headless: true });
  const notesOn = (sid) => psql(`SELECT count(*) FROM note WHERE user_id='${TEST_USERNAME}' AND sentence_id='${sid}' AND deleted_at IS NULL`);
  try {
    await cleanupTestNotes();
    psql(`INSERT INTO task_type (name, built_in, color, is_task, deleted, position) VALUES ('${TYPE}', false, 'purple', true, false, 99) ON CONFLICT (name) DO UPDATE SET color='purple', is_task=true, deleted=false`);
    const pick = async (page, scope, value) => {
      await page.locator(`${scope} .dim-type`).first().click();
      await page.waitForSelector('.dim-pop button[data-v]');
      await page.locator(`.dim-pop button[data-v="${value}"]`).click();
    };

    // ---- desktop margin ----
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    await loginAsTestUser(page);
    await page.goto(TEST_URL);
    await waitForPagination(page);
    const sid = await page.evaluate(() => document.querySelectorAll('.pagedjs_pages .sentence[data-sentence-id]')[3].dataset.sentenceId);
    await page.evaluate(() => { window.WriteSysRenderer.currentSelectedSentenceId = null; });
    await page.locator(`.pagedjs_pages .sentence[data-sentence-id="${sid}"]`).first().click();
    await page.waitForSelector('#sticky-notes-container .sticky-note.uncreated-note.first-uncreated');
    const card = '#sticky-notes-container .sticky-note.uncreated-note.first-uncreated';
    check('the grey card shows the type chip, n/a', (await page.locator(`${card} .dim-type .dim-label`).textContent()) === 'n/a');
    check('…before the + tag', await page.evaluate((c) => {
      const kids = [...document.querySelector(`${c} .tags-list`).children];
      return kids[0].classList.contains('dim-type') && kids[1].classList.contains('new-tag');
    }, card));
    check('no note yet', notesOn(sid) === '0');
    await pick(page, card, TYPE);
    await page.waitForSelector('#sticky-notes-container .sticky-note:not(.uncreated-note)', { timeout: 8000 });
    const row = () => psql(`SELECT coalesce(task_type, '') || '|' || priority || '|' || color FROM note WHERE user_id='${TEST_USERNAME}' AND sentence_id='${sid}' AND deleted_at IS NULL`);
    check('picking a type creates the note — typed, priority can, in the type\'s color', row() === `${TYPE}|can|purple`, row());
    const live = await page.evaluate(() => {
      const n = document.querySelector('#sticky-notes-container .sticky-note:not(.uncreated-note)');
      return { purple: n.classList.contains('color-purple'), type: (n.querySelector('.dim-type .dim-label') || {}).textContent };
    });
    check('…and shows as a real note with that type', live.purple && live.type === TYPE, JSON.stringify(live));
    // Back to n/a: the note stays (no never-mind).
    await pick(page, '#sticky-notes-container .sticky-note:not(.uncreated-note)', '');
    await page.waitForTimeout(800);
    check('switching back to n/a keeps the note', notesOn(sid) === '1' && row().startsWith('|'), row());

    // A gray type → the default color.
    const sid2 = await page.evaluate(() => document.querySelectorAll('.pagedjs_pages .sentence[data-sentence-id]')[4].dataset.sentenceId);
    await page.evaluate(() => { window.WriteSysRenderer.currentSelectedSentenceId = null; });
    await page.locator(`.pagedjs_pages .sentence[data-sentence-id="${sid2}"]`).first().click();
    await page.waitForSelector(card);
    await pick(page, card, 'write');
    await page.waitForSelector('#sticky-notes-container .sticky-note:not(.uncreated-note)', { timeout: 8000 });
    const def = await page.evaluate(() => window.WriteSysNotes.DEFAULT_COLOR);
    const row2 = psql(`SELECT task_type || '|' || color FROM note WHERE user_id='${TEST_USERNAME}' AND sentence_id='${sid2}' AND deleted_at IS NULL`);
    check('a gray type creates the note in the default color', row2 === `write|${def}`, row2);
    await page.close();

    // ---- phone: the same card in the suggest-edit note stack ----
    const m = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await loginAsTestUser(m);
    await m.goto(TEST_URL);
    await waitForPagination(m);
    const sid3 = await m.evaluate(() => document.querySelectorAll('.pagedjs_pages .sentence[data-sentence-id]')[5].dataset.sentenceId);
    await m.evaluate(() => { window.WriteSysRenderer.currentSelectedSentenceId = null; });
    const span = m.locator(`.pagedjs_pages .sentence[data-sentence-id="${sid3}"]`).first();
    await span.click();
    await m.waitForTimeout(300);
    await span.click();
    const mcard = '#sgm-notes-stack .sticky-note.uncreated-note';
    await m.waitForSelector(mcard);
    check('phone: the stack\'s grey card has the type chip too', (await m.locator(`${mcard} .dim-type .dim-label`).textContent()) === 'n/a');
    await pick(m, mcard, TYPE);
    await m.waitForSelector('#sgm-notes-stack .sticky-note:not(.uncreated-note)', { timeout: 8000 });
    check('phone: picking creates the typed note', psql(`SELECT task_type FROM note WHERE user_id='${TEST_USERNAME}' AND sentence_id='${sid3}' AND deleted_at IS NULL`) === TYPE);
    await m.close();
  } catch (e) {
    console.log(`❌ Test errored: ${e.message}`);
    failed = true;
  } finally {
    await browser.close();
    await cleanupTestNotes();
    psql(`DELETE FROM note WHERE task_type='${TYPE}'`);
    psql(`DELETE FROM task_type WHERE name='${TYPE}'`);
  }
  console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS');
  process.exit(failed ? 1 : 0);
})();
