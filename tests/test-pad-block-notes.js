// Pad BLOCK notes (NOTE_UI_PLAN.md phase 1): a colour button with nothing
// selected inserts the sticky note itself as a block at the caret — the
// shared widget, left-aligned, caret on the line after — and the save
// mirrors it as a pad placement. Removing the block closes the placement
// and leaves the note alive; the widget's trash deletes it.
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const { TEST_URL, loginAsTestUser, cleanupTestNotes } = require('./test-utils');
const HOME_URL = new URL('home.html', TEST_URL).href;
const psql = (sql) => execSync(
  `PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`,
  { encoding: 'utf8' }).trim();

(async () => {
  console.log('=== pad block notes ===\n');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  page.on('dialog', (d) => d.accept());
  let failed = 0;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed++; };
  const saved = () => page.waitForFunction(() => /^Saved$/.test(document.getElementById('spm-status').textContent.trim()), null, { timeout: 15000 });
  const placement = (id) => psql(`SELECT COALESCE((SELECT (removed_at IS NULL)::text FROM note_scratchpad WHERE note_id=${id} LIMIT 1), 'none')`);

  await cleanupTestNotes();
  await loginAsTestUser(page);
  await page.goto(HOME_URL);
  await page.waitForSelector('.card-ghost[data-ghost="scratchpad"]'); await page.click('.card-ghost[data-ghost="scratchpad"]');
  await page.waitForSelector('.spm-overlay .ProseMirror');
  const padId = await page.evaluate(() => parseInt(new URLSearchParams(location.hash.replace(/^#/, '')).get('pad') || '0', 10) || null);

  const pm = page.locator('.spm-editor .ProseMirror');
  await pm.click();
  await page.keyboard.type('Prose before the note.');
  await page.keyboard.press('Enter');
  check('colour bar is live with nothing selected', !(await page.evaluate(() => document.querySelector('.sn-note-colorbar').classList.contains('sn-note-colorbar-disabled'))));

  // ---- insert at the caret ----
  await page.locator('.sn-note-colorbar .sn-note-colorbtn.color-green').click();
  await page.waitForSelector('.sn-note-block .sticky-note', { timeout: 8000 });
  await page.waitForTimeout(250);
  const g = await page.evaluate(() => {
    const block = document.querySelector('.sn-note-block');
    const ed = document.querySelector('.spm-editor .ProseMirror');
    const p1 = ed.querySelector('p');
    const b = block.getBoundingClientRect(), e = ed.getBoundingClientRect(), pr = p1.getBoundingClientRect();
    return {
      noteId: parseInt(block.dataset.noteId, 10),
      sticky: block.querySelector('.sticky-note.color-green') && block.querySelector('.note-input') && block.querySelector('.sticky-bottom-controls') ? true : false,
      leftAligned: Math.abs(b.left - pr.left) < 2,
      width: Math.round(b.width),
      afterProse: block.previousElementSibling === p1,
      nextIsParagraph: block.nextElementSibling && block.nextElementSibling.tagName === 'P',
      textareaFocused: document.activeElement && document.activeElement.classList.contains('note-input'),
    };
  });
  check('a colour click inserts a block note after the prose', g.noteId > 0 && g.afterProse, JSON.stringify(g));
  check('the block IS the shared sticky-note widget (colour, textarea, bottom controls)', g.sticky === true);
  check('left-aligned at the standard note width', g.leftAligned && g.width === 232, JSON.stringify({ l: g.leftAligned, w: g.width }));
  check('a paragraph follows the block (the caret has a line to continue on)', g.nextIsParagraph === true);
  check('the new note\'s textarea takes focus', g.textareaFocused === true);
  const noteId = g.noteId;

  // ---- typing goes to the note, saves to the note; the pad save makes the placement ----
  await page.keyboard.type('Block note body.');
  await saved();
  let body = '';
  for (let i = 0; i < 20 && body !== 'Block note body.'; i++) { await page.waitForTimeout(300); body = psql(`SELECT COALESCE(body,'') FROM note WHERE note_id=${noteId}`); }
  check('note body saved (the widget\'s own debounce)', body === 'Block note body.', body);
  check('pad save made a LIVE placement for the block', placement(noteId) === 'true', placement(noteId));
  check('a bare block note has no default text', psql(`SELECT COALESCE(default_body,'<null>') FROM note WHERE note_id=${noteId}`) === '<null>');
  // Prose typed in the pad after the block lands in the following paragraph.
  await page.evaluate(() => {
    const ed = document.querySelector('.spm-editor .ProseMirror');
    const p = document.querySelector('.sn-note-block').nextElementSibling;
    const r = document.createRange(); r.selectNodeContents(p); r.collapse(false);
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); ed.focus();
  });
  await page.keyboard.type('Prose after the note.');
  await page.waitForTimeout(200);
  check('prose typed after the block lands in the paragraph below it',
    (await page.evaluate(() => document.querySelector('.sn-note-block').nextElementSibling.textContent)) === 'Prose after the note.');
  await saved();

  // ---- reopen: the block comes back from the doc with its note ----
  await page.click('#spm-close');
  await page.waitForSelector('.spm-overlay', { state: 'detached', timeout: 10000 }).catch(() => {});
  const id = padId || parseInt(psql(`SELECT scratchpad_id FROM note_scratchpad WHERE note_id=${noteId}`), 10);
  await page.evaluate((id) => window.WriteSysScratchpadModal.open(id), id);
  await page.waitForSelector('.sn-note-block .sticky-note', { timeout: 15000 });
  await page.waitForTimeout(300);
  check('reopened pad renders the block with its saved body',
    (await page.evaluate(() => document.querySelector('.sn-note-block .note-input').value)) === 'Block note body.');

  // ---- recolor from the block: the widget's colour circle ----
  // (covered by the shared widget; a recolor re-renders the block)
  // ---- Backspace onto the block removes it; the placement closes; the note lives ----
  await page.evaluate(() => {
    const ed = document.querySelector('.spm-editor .ProseMirror');
    const p = document.querySelector('.sn-note-block').nextElementSibling;
    const r = document.createRange(); r.setStart(p.firstChild || p, 0); r.collapse(true);
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); ed.focus();
  });
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(150);
  if ((await page.locator('.sn-note-block').count()) > 0) { await page.keyboard.press('Backspace'); await page.waitForTimeout(300); }
  check('Backspace from the line below removes the block from the doc', (await page.locator('.sn-note-block').count()) === 0);
  await saved();
  check('placement closed on save; the note is NOT deleted', placement(noteId) === 'false' && psql(`SELECT deleted_at IS NULL FROM note WHERE note_id=${noteId}`) === 't', `placement=${placement(noteId)}`);

  // ---- a new block, trashed from the widget → deleted ----
  await page.locator('.sn-note-colorbar .sn-note-colorbtn.color-red').click();
  await page.waitForSelector('.sn-note-block .sticky-note', { timeout: 8000 });
  const id2 = await page.evaluate(() => parseInt(document.querySelector('.sn-note-block').dataset.noteId, 10));
  await page.locator('.sn-note-block .note-trash').click();
  await page.waitForTimeout(150);
  await page.locator('.sn-note-block .note-trash').click(); // two-click confirm
  await page.waitForFunction(() => !document.querySelector('.sn-note-block'), null, { timeout: 5000 });
  let gone = 'f';
  for (let i = 0; i < 20 && gone !== 't'; i++) { await page.waitForTimeout(250); gone = psql(`SELECT deleted_at IS NOT NULL FROM note WHERE note_id=${id2}`); }
  check('the widget\'s trash removes the block and deletes the note', gone === 't');

  await page.click('#spm-close').catch(() => {});
  await cleanupTestNotes();
  await browser.close();
  console.log(failed ? `\n❌ ${failed} check(s) failed` : '\n✅ Test passed');
  process.exit(failed ? 1 : 0);
})();
