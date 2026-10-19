// The eye (2026-10-18, v2): every book note's bottom row carries an eye
// right of the checkmark — hide this note from YOUR view (note_hide, per
// viewer; someone else's note's owner never knows). Two clicks like the
// trash: the first ARMS it (filled purple, 2s), the second hides. A hidden
// note is gone from the book entirely — margin, phone stack, the
// sentence's color bars, the ‹ › tour — and stays gone across reloads.
// Settings → Note actions lists every hidden note with "undo hide" (the
// only way back; it never ages out of the list).
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
    const hides = (b, who = U) => psql(`SELECT count(*) FROM note_hide WHERE username='${who}' AND note_id=${idOf(b)}`);
    const noteSel = (b) => `#sticky-notes-container .sticky-note[data-annotation-id="${idOf(b)}"]`;
    const open = async (p) => {
      await p.evaluate(() => { window.WriteSysRenderer.currentSelectedSentenceId = null; });
      await p.locator(`.pagedjs_pages .sentence[data-sentence-id="${sid}"]`).first().click();
      await p.waitForSelector(noteSel('Eye note B'));
    };
    await page.reload();
    await waitForPagination(page);
    await open(page);
    const order = await page.evaluate((s) => [...document.querySelector(`${s} .priority-flag-chips`).children]
      .filter((c) => getComputedStyle(c).display !== 'none').map((c) => c.className.split(' ')[0]), noteSel('Eye note A'));
    const ci = order.indexOf('complete-check');
    check('the eye sits right of the checkmark, before the trash',
      ci >= 0 && order[ci + 1] === 'hide-chip' && order[order.length - 1] === 'note-trash', order.join(' '));

    // ---- two clicks, purple ---------------------------------------------------
    const eye = page.locator(`${noteSel('Eye note A')} .hide-chip`);
    await eye.hover();
    await page.waitForTimeout(250);
    const hoverColor = await eye.evaluate((e) => getComputedStyle(e).borderTopColor);
    check('hover tints the eye purple', hoverColor === 'rgb(126, 87, 194)', hoverColor);
    await eye.click();
    await page.waitForTimeout(350); // past the chip's 0.2s color transition
    const armed = await eye.evaluate((e) => ({ cls: e.classList.contains('confirming'), bg: getComputedStyle(e).backgroundColor }));
    check('first click ARMS it (filled purple) — nothing hidden yet', armed.cls && armed.bg === 'rgb(126, 87, 194)' && hides('Eye note A') === '0', JSON.stringify(armed));
    await shot(page, 'eye-armed');
    await page.waitForFunction((s) => !document.querySelector(s).classList.contains('confirming'), `${noteSel('Eye note A')} .hide-chip`, { timeout: 4000 });
    check('…and disarms by itself after 2s, still visible', hides('Eye note A') === '0' && (await page.locator(noteSel('Eye note A')).count()) === 1);
    await eye.click();
    await eye.click();
    await page.waitForSelector(noteSel('Eye note A'), { state: 'detached' });
    check('second click hides it: gone from the margin', hides('Eye note A') === '1');
    check('…the other notes stay', (await page.locator(noteSel('Eye note B')).count()) === 1);
    check('…and it\'s out of the book\'s note cache (bars, tour)', await page.evaluate((id) =>
      !window.WriteSysRenderer.currentNotes.some((n) => n.note_id === id), parseInt(idOf('Eye note A'), 10)));
    await shot(page, 'eye-hidden');
    await page.reload();
    await waitForPagination(page);
    await open(page);
    check('still gone after a reload', (await page.locator(noteSel('Eye note A')).count()) === 0);

    // Someone else's note: same eye, hides for me only.
    const cEye = page.locator(`${noteSel('Eye note C (someone else)')} .hide-chip`);
    await cEye.click();
    await cEye.click();
    await page.waitForSelector(noteSel('Eye note C (someone else)'), { state: 'detached' });
    check('someone else\'s note hides for me only', hides('Eye note C (someone else)') === '1' && hides('Eye note C (someone else)', other) === '0');

    // ---- Settings → Note actions: the way back ------------------------------
    await page.goto(new URL('settings.html', TEST_URL).href);
    await page.waitForSelector('#na-rows .na-hidden');
    const rows = await page.evaluate(() => [...document.querySelectorAll('#na-rows .na-hidden')].map((r) => ({
      text: r.querySelector('.na-prev').textContent, undo: r.querySelector('.na-undo').textContent,
      view: !!r.querySelector('.na-goto'), icon: !!r.querySelector('.na-icon svg'),
    })));
    const rowA = rows.find((r) => r.text === 'Eye note A');
    const rowC = rows.find((r) => r.text === 'Eye note C (someone else)');
    check('both hidden notes are listed with "undo hide"', rowA && rowC && rowA.undo === 'undo hide' && rowC.undo === 'undo hide', JSON.stringify(rows));
    check('…with the slashed eye; view arrow only on my own note', rowA.icon && rowA.view && !rowC.view, JSON.stringify(rows));
    // A hide older than the newest 20 other actions still lists.
    psql(`UPDATE note_hide SET created_at = now() - interval '400 days' WHERE username='${U}' AND note_id=${idOf('Eye note C (someone else)')}`);
    psql(`INSERT INTO note (user_id, color, body, priority, position, manuscript_id, completed_at)
          SELECT '${U}', 'yellow', 'Eye note filler ' || i, 'none', 'z' || i, ${M}, now() FROM generate_series(1, 25) i`);
    await page.reload();
    await page.waitForSelector('#na-rows .na-hidden');
    check('a hide never ages out of the list (25 newer actions)', await page.evaluate(() =>
      [...document.querySelectorAll('#na-rows .na-hidden .na-prev')].some((p) => p.textContent === 'Eye note C (someone else)')));
    await shot(page, 'settings-hidden');
    await page.locator('#na-rows .na-hidden', { hasText: 'Eye note A' }).locator('.na-undo').click();
    await page.waitForFunction(() => ![...document.querySelectorAll('#na-rows .na-hidden .na-prev')].some((p) => p.textContent === 'Eye note A'));
    check('"undo hide" unhides (row leaves the list)', hides('Eye note A') === '0');
    await page.goto(TEST_URL);
    await waitForPagination(page);
    await open(page);
    check('…and the note is back in the book', (await page.locator(noteSel('Eye note A')).count()) === 1);
    await page.close();

    // ---- phone: the stack's eye, same two clicks ------------------------------
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
    check('phone: first tap arms', hides('Eye note B') === '0'
      && await m.evaluate((s) => document.querySelector(`${s} .hide-chip`).classList.contains('confirming'), mSel));
    await m.click(`${mSel} .hide-chip`);
    await m.waitForSelector(mSel, { state: 'detached' });
    check('phone: second tap hides — gone from the stack', hides('Eye note B') === '1'
      && (await m.locator(`#sgm-notes-stack .sticky-note[data-annotation-id="${idOf('Eye note A')}"]`).count()) === 1);
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
