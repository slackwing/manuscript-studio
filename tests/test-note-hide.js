// The eye (2026-10-18): every book note's bottom row carries an eye right
// of the checkmark — hide this note from YOUR view (note_hide, per viewer;
// someone else's note's owner never knows). A hidden note collapses in
// place to a faded strip (its color + the lit, slashed eye) and sinks below
// the rest; it stays hidden across reloads; the eye brings it back. It
// replaced the "hide/unhide" text button, which hid nothing on the margin.
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const { TEST_URL, TEST_USERNAME, TEST_MANUSCRIPT_ID, loginAsTestUser, waitForPagination, cleanupTestNotes } = require('./test-utils');
function psql(sql) {
  return execSync(`PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`, { encoding: 'utf8' }).trim();
}

(async () => {
  let failed = false;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed = true; };
  const U = TEST_USERNAME, M = TEST_MANUSCRIPT_ID;
  const other = psql(`SELECT username FROM "user" WHERE username <> '${U}' AND username <> 'admin' ORDER BY username LIMIT 1`);
  const browser = await chromium.launch({ headless: true });
  try {
    await cleanupTestNotes();
    psql(`DELETE FROM note WHERE body LIKE 'Eye note%'`);
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    await loginAsTestUser(page);
    await page.goto(TEST_URL);
    await waitForPagination(page);
    const sid = await page.evaluate(() => document.querySelectorAll('.pagedjs_pages .sentence[data-sentence-id]')[2].dataset.sentenceId);
    psql(`INSERT INTO note (user_id, color, body, priority, task_type, position, manuscript_id, sentence_id) VALUES
      ('${U}', 'yellow', 'Eye note A', 'can', 'write', 'e1', ${M}, '${sid}'),
      ('${U}', 'green', 'Eye note B', 'none', NULL, 'e2', ${M}, '${sid}'),
      ('${other}', 'blue', 'Eye note C (someone else)', 'none', NULL, 'e3', ${M}, '${sid}')`);
    const idOf = (b) => psql(`SELECT note_id FROM note WHERE body='${b}'`);
    const open = async (p) => {
      await p.evaluate(() => { window.WriteSysRenderer.currentSelectedSentenceId = null; });
      await p.locator(`.pagedjs_pages .sentence[data-sentence-id="${sid}"]`).first().click();
      await p.waitForSelector(`#sticky-notes-container .sticky-note[data-annotation-id="${idOf('Eye note A')}"]`);
    };
    await page.reload();
    await waitForPagination(page);
    await open(page);
    const noteSel = (b) => `#sticky-notes-container .sticky-note[data-annotation-id="${idOf(b)}"]`;
    const order = await page.evaluate((s) => [...document.querySelector(`${s} .priority-flag-chips`).children]
      .filter((c) => getComputedStyle(c).display !== 'none').map((c) => c.className.split(' ')[0]), noteSel('Eye note A'));
    const ci = order.indexOf('complete-check');
    check('the eye sits right of the checkmark, before the trash',
      ci >= 0 && order[ci + 1] === 'hide-chip' && order[order.length - 1] === 'note-trash', order.join(' '));
    const state = (b) => page.evaluate((s) => {
      const n = document.querySelector(s);
      const ta = n.querySelector('.note-input, .note-readonly-body');
      return {
        hidden: n.classList.contains('note-hidden'),
        bodyShown: !!ta && getComputedStyle(ta).display !== 'none' && ta.getBoundingClientRect().height > 0,
        h: Math.round(n.getBoundingClientRect().height),
        eyeLit: n.querySelector('.hide-chip').classList.contains('active'),
        idx: [...n.parentElement.querySelectorAll(':scope > .sticky-note:not(.uncreated-note)')].indexOf(n),
      };
    }, noteSel(b));
    const before = await state('Eye note A');
    check('a visible note shows its body, eye unlit', !before.hidden && before.bodyShown && !before.eyeLit, JSON.stringify(before));
    await page.click(`${noteSel('Eye note A')} .hide-chip`);
    await page.waitForFunction((s) => document.querySelector(s) && document.querySelector(s).classList.contains('note-hidden'), noteSel('Eye note A'));
    const hid = await state('Eye note A');
    check('the eye hides it: collapsed to a strip (no body), eye lit', hid.hidden && !hid.bodyShown && hid.eyeLit && hid.h < 60, JSON.stringify(hid));
    check('…and it sinks below the visible notes', hid.idx > (await state('Eye note B')).idx, `A at ${hid.idx}`);
    check('recorded per viewer (note_hide)', psql(`SELECT count(*) FROM note_hide WHERE username='${U}' AND note_id=${idOf('Eye note A')}`) === '1');
    await page.reload();
    await waitForPagination(page);
    await open(page);
    check('still hidden after a reload', (await state('Eye note A')).hidden);
    await page.click(`${noteSel('Eye note A')} .hide-chip`);
    await page.waitForFunction((s) => !document.querySelector(s).classList.contains('note-hidden'), noteSel('Eye note A'));
    const back = await state('Eye note A');
    check('the lit eye brings it back, full size', !back.hidden && back.bodyShown && !back.eyeLit, JSON.stringify(back));
    check('unhide recorded', psql(`SELECT count(*) FROM note_hide WHERE username='${U}' AND note_id=${idOf('Eye note A')}`) === '0');
    // Someone else's note has the eye too, and the old text button is gone.
    const foreign = await page.evaluate((s) => {
      const n = document.querySelector(s);
      return n ? { eye: !!n.querySelector('.hide-chip'), oldBtn: !!n.querySelector('.note-hide-btn') } : null;
    }, noteSel('Eye note C (someone else)'));
    check('someone else\'s note: the eye, no old "hide" text button', foreign && foreign.eye && !foreign.oldBtn, JSON.stringify(foreign));
    await page.click(`${noteSel('Eye note C (someone else)')} .hide-chip`);
    await page.waitForFunction((s) => document.querySelector(s).classList.contains('note-hidden'), noteSel('Eye note C (someone else)'));
    check('…and it hides for me only', psql(`SELECT count(*) FROM note_hide WHERE username='${U}' AND note_id=${idOf('Eye note C (someone else)')}`) === '1'
      && psql(`SELECT count(*) FROM note_hide WHERE username='${other}' AND note_id=${idOf('Eye note C (someone else)')}`) === '0');
    await page.close();

    // Phone: the same eye in the suggest-edit note stack.
    const m = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await loginAsTestUser(m);
    await m.goto(TEST_URL);
    await waitForPagination(m);
    await m.evaluate(() => { window.WriteSysRenderer.currentSelectedSentenceId = null; });
    const span = m.locator(`.pagedjs_pages .sentence[data-sentence-id="${sid}"]`).first();
    await span.click(); await m.waitForTimeout(300); await span.click();
    const mSel = `#sgm-notes-stack .sticky-note[data-annotation-id="${idOf('Eye note B')}"]`;
    await m.waitForSelector(mSel);
    await m.click(`${mSel} .hide-chip`);
    await m.waitForFunction((s) => document.querySelector(s) && document.querySelector(s).classList.contains('note-hidden'), mSel);
    const mIdx = await m.evaluate((s) => {
      const n = document.querySelector(s);
      const real = [...n.parentElement.querySelectorAll(':scope > .sticky-note:not(.uncreated-note)')];
      const i = real.indexOf(n);
      return { idx: i, visibleAfter: real.slice(i + 1).filter((x) => !x.classList.contains('note-hidden')).length };
    }, mSel);
    check('phone: the stack\'s eye hides the note — and it sinks below every visible note', mIdx.visibleAfter === 0, JSON.stringify(mIdx));
    await m.close();
  } catch (e) {
    console.log(`❌ Test errored: ${e.message}`);
    failed = true;
  } finally {
    psql(`DELETE FROM note_hide WHERE note_id IN (SELECT note_id FROM note WHERE body LIKE 'Eye note%')`);
    psql(`DELETE FROM note WHERE body LIKE 'Eye note%'`);
    await browser.close();
  }
  console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS');
  process.exit(failed ? 1 : 0);
})();
