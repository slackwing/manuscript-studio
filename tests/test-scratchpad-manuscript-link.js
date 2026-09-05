// Phase C (scratchpad → manuscript link): linking a pad to a manuscript makes
// NEW notes created in it inherit the manuscript by default (live default, NOT
// retroactive). The pad's header link control does the linking; unlinking stops
// future inheritance and leaves existing notes untouched.
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const { TEST_URL, cleanupTestNotes, loginAsTestUser } = require('./test-utils');
const HOME_URL = new URL('home.html', TEST_URL).href;
function psql(sql) {
  return execSync(
    `PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8' });
}
// Make a scratchpad note from a fresh line and return its note_id.
async function makeNote(page, text) {
  const pm = page.locator('.spm-editor .ProseMirror');
  await pm.click();
  // Go to end, add a new line, type + select it.
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type(text);
  await page.keyboard.press('Home');
  await page.keyboard.down('Shift'); await page.keyboard.press('End'); await page.keyboard.up('Shift');
  await page.waitForTimeout(150);
  const before = await page.locator('.sn-note-ref').count();
  await page.locator('.sn-note-colorbar .sn-note-colorbtn').first().click();
  await page.waitForTimeout(600);
  // Close the float so it doesn't cover the next selection.
  await page.locator('.spm-title').click();
  await page.waitForTimeout(200);
  const ids = await page.locator('.sn-note-ref').evaluateAll(els => els.map(e => e.getAttribute('data-note-id')));
  return ids[ids.length - 1];
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
  await page.waitForSelector('.card-ghost[data-ghost="scratchpad"]'); await page.click('.card-ghost[data-ghost="scratchpad"]');
  await page.waitForSelector('.spm-overlay .ProseMirror');

  // (1) A note made BEFORE linking → no manuscript (not retroactive).
  const preNote = await makeNote(page, 'Before the link.');
  const preMid = psql(`SELECT COALESCE(manuscript_id::text,'null') FROM note WHERE note_id=${preNote}`).trim();
  check('pre-link note has no manuscript', preMid === 'null', `manuscript_id=${preMid}`);

  // (2) Link the pad via the header control.
  const linkEl = page.locator('#spm-link');
  await linkEl.waitFor({ timeout: 4000 });
  check('unlinked pad shows the link control (not linked)', !(await linkEl.evaluate(e => e.classList.contains('linked'))));
  await linkEl.click();
  const pop = page.locator('.note-linkpop');
  await pop.waitFor({ timeout: 4000 });
  await page.waitForTimeout(400);
  const pickedName = await pop.locator('button[data-mid]').first().textContent();
  await pop.locator('button[data-mid]').first().click();
  await page.waitForTimeout(600);
  check('pad header now shows linked state', await linkEl.locator('.ms-chip.linked').count() === 1);
  const chipName = await linkEl.locator('.ms-chip-name').textContent().catch(() => '');
  check('pad link shows the manuscript name', (chipName || '').trim() === (pickedName || '').trim(), `chip="${chipName}"`);

  // (3) A note made AFTER linking → inherits the manuscript, and the float that
  //     opens right away SHOWS the manuscript chip (seeded from the create
  //     response — the earlier bug was the first note's float showing no chip).
  const pm = page.locator('.spm-editor .ProseMirror');
  await pm.click();
  await page.keyboard.press('Control+End'); await page.keyboard.press('Enter');
  await page.keyboard.type('After the link.');
  await page.keyboard.press('Home');
  await page.keyboard.down('Shift'); await page.keyboard.press('End'); await page.keyboard.up('Shift');
  await page.waitForTimeout(150);
  await page.locator('.sn-note-colorbar .sn-note-colorbtn').first().click();
  // The float opens as soon as the create POST resolves — wait for the chip,
  // don't count after a fixed beat.
  const floatChip = await page.waitForFunction(
    () => document.querySelectorAll('.sn-note-float .manuscript-chip.linked').length === 1,
    null, { timeout: 10000 }).then(() => 1).catch(() => 0);
  check('first note after linking shows its manuscript chip immediately (float)', floatChip === 1, `chips=${floatChip}`);
  const postNote = await page.locator('.sn-note-ref').last().getAttribute('data-note-id');
  await page.locator('.spm-title').click(); await page.waitForTimeout(200); // close float
  const postMid = psql(`SELECT COALESCE(manuscript_id::text,'null') FROM note WHERE note_id=${postNote}`).trim();
  check('post-link note INHERITS the manuscript', /^[0-9]+$/.test(postMid), `manuscript_id=${postMid}`);

  // (3b) The landing card shows BOTH contexts: "<manuscript> · <scratchpad>".
  const home = await page.evaluate(async () => (await (await fetch('api/home', { credentials: 'same-origin' })).json()));
  const card = (home.notes || []).find(n => String(n.note_id) === String(postNote));
  check('landing card shows both manuscript and scratchpad context',
    !!card && / · /.test(card.context) && card.context.includes(pickedName.trim()),
    card && card.context);

  // (3c) A sketch created in the linked pad also inherits the manuscript and
  //      shows its link chip immediately (parity with notes).
  const snipCtx = await page.evaluate(() => window.WriteSysScratchpad.insertSketch());
  await page.waitForTimeout(1000);
  const sketchId = snipCtx && snipCtx.sketch && snipCtx.sketch.sketch_id;
  const snipLink = psql(`SELECT COALESCE(linked_manuscript_id::text,'null') FROM sketch WHERE sketch_id='${sketchId}'`).trim();
  check('sketch in a linked pad INHERITS the manuscript', /^[0-9]+$/.test(snipLink), `linked=${snipLink}`);
  // Icon-only chip: the manuscript name lives in the hover title now.
  const snipChip = await page.locator('.sn-widget .sn-linkchip.linked').first().getAttribute('title').catch(() => '');
  check('sketch shows its manuscript link chip immediately', (snipChip || '').trim() === pickedName.trim(), `chip="${snipChip}"`);

  // The earlier note is still untouched (not retroactively linked).
  const preMid2 = psql(`SELECT COALESCE(manuscript_id::text,'null') FROM note WHERE note_id=${preNote}`).trim();
  check('pre-link note STILL has no manuscript (not retroactive)', preMid2 === 'null', `manuscript_id=${preMid2}`);

  // (4) Unlink the pad → future notes stop inheriting.
  await linkEl.locator('.ms-chip-x').click();
  await page.waitForTimeout(500);
  check('pad shows unlinked again', !(await linkEl.evaluate(e => e.classList.contains('linked'))));
  const padLink = psql(`SELECT COALESCE(linked_manuscript_id::text,'null') FROM scratchpad WHERE scratchpad_id=(SELECT scratchpad_id FROM note WHERE note_id=${postNote})`).trim();
  check('scratchpad.linked_manuscript_id cleared', padLink === 'null', `pad link=${padLink}`);

  const afterUnlink = await makeNote(page, 'After unlink.');
  const auMid = psql(`SELECT COALESCE(manuscript_id::text,'null') FROM note WHERE note_id=${afterUnlink}`).trim();
  check('note made after unlink has no manuscript', auMid === 'null', `manuscript_id=${auMid}`);

  await browser.close();
  console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS');
  process.exit(failed ? 1 : 0);
})();
