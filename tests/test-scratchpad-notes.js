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

  await page.screenshot({ path: `${OUT}/scratch-note-created.png` });

  // Type in the note float, expect it to persist.
  const noteInput = page.locator('.sn-note-float .note-input').first();
  await noteInput.click(); await noteInput.fill('This is my scratchpad note.');
  await page.waitForTimeout(1400); // debounced save

  // The note exists in the DB as a scratchpad note (no sentence).
  const row = psql(`SELECT color, body, (sentence_id IS NULL) AS no_sentence, (scratchpad_id IS NOT NULL) AS has_pad FROM note WHERE user_id='test' AND scratchpad_id IS NOT NULL AND deleted_at IS NULL ORDER BY note_id DESC LIMIT 1`);
  check('note persisted as a scratchpad note (color purple, no sentence, has pad)',
    /purple/.test(row) && /\|t\|t/.test(row.replace(/\s/g, '')), row.trim());

  // Click outside → float hides.
  await page.locator('.spm-title').click();
  await page.waitForTimeout(300);
  const floatAfter = await page.locator('.sn-note-float').count();
  check('clicking outside hides the float', floatAfter === 0, `floats=${floatAfter}`);

  // Click the anchor square → float reopens.
  await page.locator('.sn-note-anchor .sn-note-anchor-sq').first().click();
  await page.waitForTimeout(400);
  const floatReopen = await page.locator('.sn-note-float').count();
  check('clicking the anchor reopens the float', floatReopen >= 1, `floats=${floatReopen}`);

  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
