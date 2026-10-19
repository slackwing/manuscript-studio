// Suggest-edit modal + note stack on the phone layout (≤1239px), 2026-10-18:
//  - ONE gutter: the space above the modal = each side margin = the gap
//    under the modal = the gap between notes;
//  - the layout follows the breakpoint WHILE OPEN — widening past it moves
//    the modal out of the column and drops the stack (the margin shows the
//    notes), narrowing moves it back. It used to keep the phone layout,
//    the stack stranded top-left over the desktop page.
// SHOT_DIR=<dir> saves screenshots.
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
  const browser = await chromium.launch({ headless: true });
  try {
    await cleanupTestNotes();
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await loginAsTestUser(page);
    await page.goto(TEST_URL);
    await waitForPagination(page);
    const sid = await page.evaluate(() => document.querySelectorAll('.pagedjs_pages p .sentence[data-sentence-id]')[4].dataset.sentenceId);
    psql(`INSERT INTO note (user_id, color, body, priority, task_type, position, manuscript_id, sentence_id) VALUES
      ('${U}', 'yellow', 'Flip note one', 'can', 'write', 'f1', ${M}, '${sid}'),
      ('${U}', 'green', 'Flip note two', 'can', 'write', 'f2', ${M}, '${sid}'),
      ('${U}', 'blue', 'Flip note three', 'can', 'write', 'f3', ${M}, '${sid}')`);
    await page.reload();
    await waitForPagination(page);
    const open = async () => {
      await page.evaluate(() => { window.WriteSysRenderer.currentSelectedSentenceId = null; });
      const span = page.locator(`.pagedjs_pages .sentence[data-sentence-id="${sid}"]`).first();
      await span.click();
      await page.waitForTimeout(300);
      await span.click(); // the second tap opens suggest-edit + its note stack
      await page.waitForSelector('#suggestion-modal');
    };
    const measure = () => page.evaluate(() => {
      const ov = document.getElementById('suggestion-modal-overlay').getBoundingClientRect();
      const m = document.getElementById('suggestion-modal').getBoundingClientRect();
      const stack = document.getElementById('sgm-notes-stack');
      const notes = stack ? [...stack.children].filter((c) => c.classList.contains('sticky-note')).map((n) => n.getBoundingClientRect()) : [];
      const first = notes[0];
      const vgaps = [], hgaps = [];
      for (let i = 1; i < notes.length; i++) {
        if (Math.abs(notes[i].top - notes[i - 1].top) < 1) hgaps.push(Math.round(notes[i].left - notes[i - 1].right));
        else vgaps.push(Math.round(notes[i].top - notes[i - 1].bottom));
      }
      return {
        top: Math.round(m.top - ov.top), left: Math.round(m.left - ov.left), right: Math.round(ov.right - m.right),
        underModal: first ? Math.round(first.top - m.bottom) : null, vgaps, hgaps,
        stackLeft: stack ? Math.round(stack.getBoundingClientRect().left - ov.left) : null,
      };
    });
    await open();
    const g = await measure();
    const gutter = Math.round(390 * 0.03);
    const near = (v) => v !== null && Math.abs(v - gutter) <= 1;
    check('phone: top margin = side margins', near(g.top) && near(g.left) && near(g.right), JSON.stringify(g));
    check('phone: gap under the modal = the same gutter', near(g.underModal), JSON.stringify(g));
    check('phone: gaps between notes = the same gutter', g.vgaps.length >= 2 && g.vgaps.every(near), JSON.stringify(g.vgaps));
    check('phone: notes stay left-aligned on the modal\'s edge', near(g.stackLeft), JSON.stringify(g));
    await shot(page, 'phone-gutters');

    // ---- widen past the breakpoint with the modal open ---------------------
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.waitForFunction(() => !document.getElementById('sgm-notes-stack'));
    const wide = await page.evaluate((sid) => {
      const m = document.getElementById('suggestion-modal');
      const r = m.getBoundingClientRect();
      return {
        parent: m.parentElement === document.body,
        centered: Math.abs((r.left + r.width / 2) - window.innerWidth / 2) < 2 && Math.abs((r.top + r.height / 2) - window.innerHeight / 2) < 2,
        margin: [...document.querySelectorAll('#sticky-notes-container .sticky-note[data-annotation-id]')].length,
        sel: window.WriteSysNotes.currentSentenceId === sid,
      };
    }, sid);
    check('widened: modal leaves the column and centers (desktop modal)', wide.parent && wide.centered, JSON.stringify(wide));
    check('widened: no stranded note stack; the margin shows the notes', wide.margin === 3 && wide.sel, JSON.stringify(wide));
    await shot(page, 'widened');

    // ---- and back --------------------------------------------------------------
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForSelector('#suggestion-modal-overlay > #sgm-notes-stack');
    const back = await measure();
    check('narrowed again: modal + stack back in the column, same gutters',
      near(back.top) && near(back.underModal) && back.vgaps.every(near), JSON.stringify(back));
    await page.keyboard.press('Escape');
    await page.waitForSelector('#suggestion-modal', { state: 'detached' });
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.waitForTimeout(300);
    check('closed: nothing left behind after a later resize',
      await page.evaluate(() => !document.getElementById('suggestion-modal') && !document.getElementById('sgm-notes-stack') && !document.getElementById('suggestion-modal-overlay')));
  } catch (e) {
    check('run', false, e.message);
  } finally {
    psql(`DELETE FROM note WHERE body LIKE 'Flip note %'`);
  }
  await browser.close();
  console.log(failed ? '\n❌ some checks failed' : '\n✅ all passed');
  process.exit(failed ? 1 : 0);
})();
