// Scratchpad notes (NOTES_PLAN.md Phase 2): select text → click a color square →
// a colored note float appears + the text becomes an inline anchor+highlight;
// the note persists in the DB as a scratchpad note (no sentence).
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const { TEST_URL, cleanupTestNotes, loginAsTestUser } = require('./test-utils');
const HOME_URL = new URL('home.html', TEST_URL).href;
function psql(sql) {
  return execSync(
    `PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8' });
}
const OUT = '/tmp/claude-1000/-home-slackwing--config-my/8ba4eaee-57a9-43f6-8b98-5a406662b25a/scratchpad';

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

  // Type a line, then select the whole line.
  const pm = page.locator('.spm-editor .ProseMirror');
  await pm.click();
  await page.keyboard.type('Highlight this sentence for a note.');
  await page.keyboard.press('Home');
  await page.keyboard.down('Shift'); await page.keyboard.press('End'); await page.keyboard.up('Shift');
  await page.waitForTimeout(200);

  // The 6 color squares exist and are enabled (selection non-empty).
  const btnCount = await page.locator('.sn-note-colorbar .sn-note-colorbtn').count();
  check('6 note-color buttons in the toolbar', btnCount === 6, `got=${btnCount}`);
  const disabled = await page.evaluate(() => document.querySelector('.sn-note-colorbar').classList.contains('sn-note-colorbar-disabled'));
  check('color bar enabled while text is selected', disabled === false);

  // Click purple → creates note, wraps highlight, inserts anchor, opens float.
  await page.locator('.sn-note-colorbar .sn-note-colorbtn.color-purple').click();
  await page.waitForTimeout(800);

  const anchor = await page.locator('.sn-note-anchor').count();
  check('inline note anchor appeared', anchor >= 1, `anchors=${anchor}`);
  const hl = await page.locator('.sn-note-hl').count();
  check('text got the note highlight', hl >= 1, `highlights=${hl}`);
  const float = await page.locator('.sn-note-float .sticky-note').count();
  check('floating note (sticky-note) opened', float >= 1, `floats=${float}`);

  // The note body is SEEDED with the highlighted text (snapshot), so it shows
  // what it's about.
  const seeded = await page.locator('.sn-note-float .note-input').first().inputValue();
  check('note body seeded with the highlighted text', /Highlight this sentence/.test(seeded), seeded);

  await page.screenshot({ path: `${OUT}/scratch-note-created.png` });

  // Add to the note body, expect it to persist.
  const noteInput = page.locator('.sn-note-float .note-input').first();
  await noteInput.click();
  await noteInput.fill('Highlight this sentence for a note.\n\nMy added thought.');
  await page.waitForTimeout(1400); // debounced save

  const row = psql(`SELECT color, body, (sentence_id IS NULL) AS no_sentence, (scratchpad_id IS NOT NULL) AS has_pad FROM note WHERE user_id='test' AND scratchpad_id IS NOT NULL AND deleted_at IS NULL ORDER BY note_id DESC LIMIT 1`);
  check('note persisted as a scratchpad note (purple, no sentence, has pad)',
    /purple/.test(row) && /\|t\|t/.test(row.replace(/\s/g, '')), row.trim());

  // Click outside → float hides.
  await page.locator('.spm-title').click();
  await page.waitForTimeout(300);
  check('clicking outside hides the float', (await page.locator('.sn-note-float').count()) === 0);

  // Click the anchor square → float reopens.
  await page.locator('.sn-note-anchor .sn-note-anchor-sq').first().click();
  await page.waitForTimeout(400);
  check('clicking the anchor reopens the float', (await page.locator('.sn-note-float').count()) >= 1);
  await page.locator('.spm-title').click(); await page.waitForTimeout(200);

  // KEY: completely change the highlighted text, THEN delete the note via the
  // anchor trash (two-click) — deletion is anchor-id based, so it still works.
  await pm.click();
  // Select the highlighted word run and retype over it.
  await page.keyboard.press('Control+A');
  await page.keyboard.type('totally different text now');
  await page.waitForTimeout(300);
  // The anchor was removed by select-all → its note should be soft-deleted
  // deterministically (destroy()).
  await page.waitForTimeout(400);
  const noteIdRow = psql(`SELECT note_id, deleted_at IS NOT NULL AS del FROM note WHERE user_id='test' AND scratchpad_id IS NOT NULL ORDER BY note_id DESC LIMIT 1`).trim();
  check('deleting the anchor (via edit) soft-deletes the note deterministically (no sweep)',
    /\|t$/.test(noteIdRow), noteIdRow);

  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
