/**
 * Two-click "complete" flow on an annotation:
 *   first click → green confirming state, annotation still present
 *   second click → annotation disappears from the DOM and rainbow bars update
 */

const { chromium } = require('playwright');
const { TEST_URL, cleanupTestAnnotations, loginAsTestUser,
  waitForPagination,
} = require('./test-utils');

(async () => {
  console.log('=== Complete-Annotation Test ===\n');

  await cleanupTestAnnotations();

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1400, height: 900 });

  let failed = false;
  function assert(cond, msg) {
    if (cond) console.log(`✓ ${msg}`);
    else { console.log(`✗ ${msg}`); failed = true; }
  }

  try {
    await loginAsTestUser(page);
    await page.goto(TEST_URL);
    await page.waitForSelector('.pagedjs_page', { timeout: 30000 });
    await page.waitForSelector('.sentence', { timeout: 10000 });
    await waitForPagination(page);

    await page.locator('.sentence').first().click();
    await page.waitForSelector('.sticky-note.uncreated-note.first-uncreated', { timeout: 5000 });

    const colorCircle = page.locator('.sticky-note.uncreated-note.first-uncreated .sticky-note-color-circle');
    await colorCircle.hover();
    await page.waitForSelector('.sticky-note.uncreated-note.first-uncreated .sticky-note-palette.visible', { timeout: 5000 });
    await page.locator('.sticky-note.uncreated-note.first-uncreated .sticky-note-palette .color-circle[data-color="yellow"]').click();
    await page.waitForSelector('.sticky-note:not(.uncreated-note)', { timeout: 5000 });
    await page.waitForTimeout(500);

    const realNotesBefore = await page.locator('.sticky-note:not(.uncreated-note)').count();
    assert(realNotesBefore === 1, `One real annotation created (got ${realNotesBefore})`);

    const rainbowBarsBefore = await page.locator('.rainbow-bar').count();

    // Only TASKS (notes with a priority) can be completed: no priority, no
    // checkmark.
    const check = page.locator('.sticky-note:not(.uncreated-note) .complete-check');
    const hiddenBefore = await check.evaluate(el => getComputedStyle(el).display === 'none');
    assert(hiddenBefore, 'Complete button hidden while the note has no priority');
    const chipVis = () => page.evaluate(() => {
      const vis = {};
      document.querySelectorAll('.sticky-note:not(.uncreated-note) .priority-chip')
        .forEach(c => { vis[c.dataset.priority] = getComputedStyle(c).display !== 'none'; });
      return vis;
    });
    const before = await chipVis();
    assert(before.P0 && before.P1 && before.P2 && before.P3 && before.blocked,
      'All five priority chips (incl. P3 + blocked) show while unprioritized');
    await page.locator('.sticky-note:not(.uncreated-note) .priority-chip[data-priority="P0"]').click();
    await page.waitForFunction(() => {
      const el = document.querySelector('.sticky-note:not(.uncreated-note) .complete-check');
      return el && getComputedStyle(el).display !== 'none';
    });
    assert(true, 'Assigning a priority reveals the complete button');
    const afterSel = await chipVis();
    assert(afterSel.P0 && !afterSel.P1 && !afterSel.P2 && !afterSel.P3,
      'Selecting a priority collapses the row to just that level');
    const noteId = await page.locator('.sticky-note:not(.uncreated-note)').first()
      .evaluate(el => el.dataset.noteId || el.dataset.annotationId);

    // The SCORING STAR (yellow, slot 6 — one slot gap after the checkmark):
    // typed points live here now, fully independent of completion.
    const star = page.locator('.sticky-note:not(.uncreated-note) .points-star');
    const starVisible = await star.evaluate(el => getComputedStyle(el).display !== 'none');
    assert(starVisible, 'Star appears for tasks alongside the checkmark');
    const layout = await page.evaluate(() => {
      const rowEl = document.querySelector('.sticky-note:not(.uncreated-note) .priority-flag-chips');
      const row = rowEl.getBoundingClientRect();
      const fl = document.querySelector('.sticky-note:not(.uncreated-note) .flag-chip').getBoundingClientRect();
      const st = document.querySelector('.sticky-note:not(.uncreated-note) .points-star').getBoundingClientRect();
      const ck = document.querySelector('.sticky-note:not(.uncreated-note) .complete-check').getBoundingClientRect();
      // The 7-across pitch: buttons stay on this grid however few show.
      const pitch = 26 + (row.width - 182) / 6;
      return { starAfterFlag: st.left - fl.left, pitch, checkRightGap: Math.round(row.right - ck.right) };
    });
    assert(Math.abs(layout.starAfterFlag - layout.pitch) <= 1,
      `Star sits one 7-grid slot after the flag (${layout.starAfterFlag.toFixed(1)} vs pitch ${layout.pitch.toFixed(1)})`);
    assert(Math.abs(layout.checkRightGap) <= 1, `Check pinned to the far right (gap ${layout.checkRightGap})`);

    await star.click();
    const scoring = await star.evaluate(el => el.classList.contains('scoring'));
    assert(scoring, 'First click arms the star (scoring state)');
    // A stale first digit ("9") expires after the 1s window, then "1"+"5"
    // within the window reads as 15, shown in place of the star.
    await page.keyboard.press('9');
    await page.waitForTimeout(1200);
    await page.keyboard.press('1');
    await page.waitForTimeout(150);
    await page.keyboard.press('5');
    const shown = await star.evaluate(el => (el.querySelector('.points-entry') || {}).textContent || '');
    assert(shown === '15', `Typed points shown in place of the star (got "${shown}")`);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    const { execSync: ex1 } = require('child_process');
    const psq = (sql) => ex1(
      `PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`,
      { encoding: 'utf-8' }).trim();
    const ev1 = psq(`SELECT points FROM point_event WHERE note_id=${parseInt(noteId, 10)} ORDER BY point_event_id`);
    assert(ev1 === '15', `First point_event recorded (got "${ev1}")`);
    const notDone = psq(`SELECT completed_at IS NULL FROM note WHERE note_id=${parseInt(noteId, 10)}`);
    assert(notDone === 't', 'Scoring did NOT complete the task');

    // Score AGAIN — points are repeatable events.
    await star.click();
    await page.keyboard.press('7');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    const evs = psq(`SELECT string_agg(points::text, ',' ORDER BY point_event_id) FROM point_event WHERE note_id=${parseInt(noteId, 10)}`);
    assert(evs === '15,7', `Second scoring appended (got "${evs}")`);

    // BLOCKED is a fifth priority-like state: mutually exclusive, collapses
    // the row, and makes the note a task (star + check show).
    await p0Toggle(page);
    async function p0Toggle(pg) {
      await pg.locator('.sticky-note:not(.uncreated-note) .priority-chip[data-priority="P0"]').click();
      await pg.waitForTimeout(300);
    }
    await page.locator('.sticky-note:not(.uncreated-note) .priority-chip[data-priority="blocked"]').click();
    await page.waitForTimeout(300);
    const blockedVis = await chipVis();
    assert(blockedVis.blocked && !blockedVis.P0 && !blockedVis.P1,
      'Selecting blocked collapses the row to just blocked');
    const taskWhileBlocked = await page.evaluate(() => {
      const q = (sel) => getComputedStyle(document.querySelector(`.sticky-note:not(.uncreated-note) ${sel}`)).display !== 'none';
      return q('.complete-check') && q('.points-star');
    });
    assert(taskWhileBlocked, 'Blocked notes are tasks (check + star show)');
    // Back to P0 for the completion below.
    await page.locator('.sticky-note:not(.uncreated-note) .priority-chip[data-priority="blocked"]').click();
    await page.waitForTimeout(300);
    await p0Toggle(page);

    // Completion is its own act: plain two-click green checkmark.
    await check.click();
    const confirming = await check.evaluate(el => el.classList.contains('confirming'));
    assert(confirming, 'First click puts complete button into confirming state');
    await page.waitForTimeout(150);
    await check.click();

    await page.waitForSelector('.sticky-note.uncreated-note.first-uncreated', { timeout: 5000 });
    await page.waitForTimeout(500);

    const realNotesAfter = await page.locator('.sticky-note:not(.uncreated-note)').count();
    assert(realNotesAfter === 0, `Annotation disappeared after completion (got ${realNotesAfter})`);

    const rainbowBarsAfter = await page.locator('.rainbow-bar').count();
    assert(rainbowBarsAfter !== rainbowBarsBefore || rainbowBarsBefore === 0,
      `Rainbow bars updated (before=${rainbowBarsBefore}, after=${rainbowBarsAfter})`);

    // Completion time landed; the point events survive independently.
    const { execSync } = require('child_process');
    const row = execSync(
      `PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "SELECT (completed_at IS NOT NULL), (SELECT SUM(points) FROM point_event WHERE note_id=${parseInt(noteId, 10)}) FROM note WHERE note_id=${parseInt(noteId, 10)}"`,
      { encoding: 'utf-8' }).trim();
    assert(row === 't|22', `completed_at stored + events sum 22 (got "${row}")`);

    // Completion must persist after reload.
    await page.reload();
    await page.waitForSelector('.pagedjs_page', { timeout: 30000 });
    await page.waitForSelector('.sentence', { timeout: 10000 });
    await waitForPagination(page);
    await page.locator('.sentence').first().click();
    await page.waitForSelector('.sticky-note.uncreated-note.first-uncreated', { timeout: 5000 });
    const realNotesAfterReload = await page.locator('.sticky-note:not(.uncreated-note)').count();
    assert(realNotesAfterReload === 0, `Annotation stays completed after reload (got ${realNotesAfterReload})`);

  } catch (e) {
    console.log(`✗ Test errored: ${e.message}`);
    failed = true;
  } finally {
    await browser.close();
    await cleanupTestAnnotations();
  }

  if (failed) {
    console.log('\n❌ Test failed');
    process.exit(1);
  }
  console.log('\n✅ Test passed');
})().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
