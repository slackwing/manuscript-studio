// DATA-LOSS REGRESSION: NoteRefView had no update() — ProseMirror recreated
// it on any nearby redraw and destroy() soft-deleted the note WHILE ITS REF
// WAS STILL IN THE DOC. Notes died silently every time you typed in the same
// paragraph as a ref. Pins: heavy same-paragraph editing + pad reopen never
// deletes the note; deleting the ref via its trash still does.
const { chromium } = require('playwright');
const { TEST_URL, TEST_USERNAME, cleanupTestNotes, loginAsTestUser } = require('./test-utils');
const { execSync } = require('child_process');
const HOME_URL = new URL('home.html', TEST_URL).href;
const psql = (sql) => execSync(
  `PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`,
  { encoding: 'utf-8' }).trim();

(async () => {
  await cleanupTestNotes();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  page.on('dialog', d => d.accept());
  let failed = false;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed = true; };

  await loginAsTestUser(page);
  await page.goto(HOME_URL);
  await page.waitForSelector('#home-new-pad'); await page.click('#home-new-pad');
  await page.waitForSelector('.spm-overlay .ProseMirror');
  const pm = page.locator('.spm-editor .ProseMirror');
  await pm.click();
  await page.keyboard.type('alpha KEEPME omega');
  await page.keyboard.press('Home');
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.down('Shift');
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.up('Shift');
  await page.waitForTimeout(150);
  await page.locator('.sn-note-colorbar .sn-note-colorbtn').first().click();
  await page.waitForTimeout(800);
  const box = await page.locator('.spm-editor').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + 30); // close float
  await page.waitForTimeout(300);
  const noteId = await page.evaluate(() => parseInt(document.querySelector('.sn-note-ref').dataset.noteId, 10));
  const alive = () => psql(`SELECT deleted_at IS NULL FROM note WHERE note_id=${noteId}`);
  check('note created', alive() === 't', `id=${noteId}`);

  // HEAVY editing in the ref's paragraph — the killer scenario.
  await page.keyboard.press('Control+End');
  for (let round = 0; round < 3; round++) {
    await page.keyboard.type(` edit${round} in the same paragraph`);
    await page.waitForTimeout(300);
    await page.keyboard.press('Home');
    await page.keyboard.type('pre. ');
    await page.keyboard.press('Control+End');
    await page.waitForTimeout(300);
  }
  await page.waitForTimeout(1500); // let doc save
  check('note SURVIVES same-paragraph editing', alive() === 't');

  // Reopen the pad (normalize-at-open, full redraw) — still alive.
  const padId = await page.evaluate(() => window.WriteSysScratchpad.scratchpadId);
  await page.click('#spm-close');
  await page.waitForSelector('.spm-overlay', { state: 'detached' });
  await page.evaluate((id) => window.WriteSysScratchpadModal.open(id), padId);
  await page.waitForSelector('.sn-note-ref', { timeout: 10000 });
  await page.waitForTimeout(1000);
  check('note SURVIVES pad reopen', alive() === 't');

  // Intentional delete via the ref's trash still works (two-click confirm).
  await page.locator('.sn-note-ref').hover();
  await page.locator('.sn-note-ref .sn-note-ref-trash').click({ force: true });
  await page.waitForTimeout(250);
  await page.locator('.sn-note-ref .sn-note-ref-trash').click({ force: true });
  await page.waitForTimeout(800);
  check('trash delete still soft-deletes', alive() === 'f');

  await cleanupTestNotes();
  console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS');
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('Test crashed:', e); process.exit(1); });
