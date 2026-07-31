// Phase B (manuscript-link chip): a note carries a manuscript link, shown as the
// LAST chip with a link glyph. Linked → named chip + × (unlink). Unlinked → bare
// glyph chip that opens a manuscript picker. Built in the shared component, so it
// works in every view. This test drives it in the scratchpad float.
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const { TEST_URL, cleanupTestNotes, loginAsTestUser } = require('./test-utils');
const HOME_URL = new URL('home.html', TEST_URL).href;
function psql(sql) {
  return execSync(
    `PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8' });
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  page.on('dialog', d => d.accept());
  let failed = false;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed = true; };

  await cleanupTestNotes();
  await loginAsTestUser(page);
  await page.goto(HOME_URL);
  await page.waitForSelector('#home-new-pad'); await page.click('#home-new-pad');
  await page.waitForSelector('.spm-overlay .ProseMirror');

  // Make a scratchpad note and open its float.
  const pm = page.locator('.spm-editor .ProseMirror');
  await pm.click();
  await page.keyboard.type('Link me to a manuscript.');
  await page.keyboard.press('Home');
  await page.keyboard.down('Shift'); await page.keyboard.press('End'); await page.keyboard.up('Shift');
  await page.waitForTimeout(150);
  await page.locator('.sn-note-colorbar .sn-note-colorbtn').first().click();
  await page.waitForTimeout(600);
  const noteId = await page.locator('.sn-note-ref').first().getAttribute('data-note-id');
  const float = page.locator('.sn-note-float .sticky-note');

  // Unlinked: a bare manuscript chip (link glyph, no name) is present + last.
  const unlinkedChip = float.locator('.manuscript-chip.unlinked');
  await unlinkedChip.waitFor({ timeout: 4000 });
  check('unlinked note shows the bare link chip', await unlinkedChip.count() === 1);
  const hasName = await float.locator('.manuscript-chip .ms-chip-name').count();
  check('bare chip has no manuscript name', hasName === 0, `nameSpans=${hasName}`);

  // Click it → the shared manuscript picker opens.
  await unlinkedChip.click();
  const pop = page.locator('.note-linkpop');
  await pop.waitFor({ timeout: 4000 });
  check('clicking the chip opens the manuscript picker', await pop.count() === 1);
  await page.waitForTimeout(400); // list loads from /api/home
  const optCount = await pop.locator('button[data-mid]').count();
  check('picker lists at least one manuscript', optCount >= 1, `options=${optCount}`);

  // Pick the first manuscript → note links.
  const pickedName = await pop.locator('button[data-mid]').first().textContent();
  await pop.locator('button[data-mid]').first().click();
  await page.waitForTimeout(600);

  // Chip is now linked, shows the name, has an × to unlink.
  const linkedChip = float.locator('.manuscript-chip.linked');
  await linkedChip.waitFor({ timeout: 4000 });
  const chipName = await linkedChip.locator('.ms-chip-name').textContent();
  check('chip now shows the linked manuscript name', (chipName || '').trim() === (pickedName || '').trim(), `chip="${chipName}" picked="${pickedName}"`);
  check('linked chip has an unlink ×', await linkedChip.locator('.ms-chip-x').count() === 1);

  // DB persisted the manuscript_id.
  const mid = psql(`SELECT manuscript_id FROM note WHERE note_id=${noteId}`).trim();
  check('note.manuscript_id persisted', /^[0-9]+$/.test(mid), `manuscript_id=${mid}`);

  // Unlink via the × → back to a bare chip, DB cleared.
  await linkedChip.locator('.ms-chip-x').click();
  await page.waitForTimeout(600);
  check('unlinking returns the bare chip', await float.locator('.manuscript-chip.unlinked').count() === 1);
  const midAfter = psql(`SELECT COALESCE(manuscript_id::text,'null') FROM note WHERE note_id=${noteId}`).trim();
  check('note.manuscript_id cleared on unlink', midAfter === 'null', `after=${midAfter}`);

  await browser.close();
  console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS');
  process.exit(failed ? 1 : 0);
})();
