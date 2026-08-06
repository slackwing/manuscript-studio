// Scratchpad notes (NOTES_PLAN.md Phase 2): select text → click a color square →
// a colored note float appears + the text becomes an inline anchor+highlight;
// the note persists in the DB as a scratchpad note (no sentence).
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const { TEST_URL, TEST_USERNAME, cleanupTestNotes, loginAsTestUser } = require('./test-utils');
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

  // The atomic noteRef: one inline widget = square + verbatim highlighted text.
  const refs = await page.locator('.sn-note-ref').count();
  check('atomic noteRef appeared', refs >= 1, `refs=${refs}`);
  const refText = await page.locator('.sn-note-ref-text').first().textContent();
  check('noteRef shows the verbatim highlighted text', /Highlight this sentence/.test(refText), refText);
  const refClass = await page.locator('.sn-note-ref').first().getAttribute('class');
  check('noteRef wears the note color (purple) — sourced from note data', /color-purple/.test(refClass), refClass);
  const float = await page.locator('.sn-note-float .sticky-note').count();
  check('floating note (sticky-note) opened', float >= 1, `floats=${float}`);

  // The note body is SEEDED with the highlighted text (snapshot).
  const seeded = await page.locator('.sn-note-float .note-input').first().inputValue();
  check('note body seeded with the highlighted text', /Highlight this sentence/.test(seeded), seeded);

  await page.screenshot({ path: `${OUT}/scratch-note-created.png` });

  // Add to the note body, expect it to persist.
  const noteInput = page.locator('.sn-note-float .note-input').first();
  await noteInput.click();
  await noteInput.fill('Highlight this sentence for a note.\n\nMy added thought.');
  await page.waitForTimeout(2000); // debounced save

  const noteId = await page.locator('.sn-note-ref').first().getAttribute('data-note-id');
  const row = psql(`SELECT color, body, (sentence_id IS NULL) AS no_sentence, (scratchpad_id IS NOT NULL) AS has_pad FROM note WHERE note_id=${noteId}`);
  check('note persisted as a scratchpad note (purple, no sentence, has pad)',
    /purple/.test(row) && /\|t\|t/.test(row.replace(/\s/g, '')), row.trim());
  // The doc stores note_id + text but NO color (one source of truth).
  const doc = psql(`SELECT doc::text FROM scratchpad WHERE user_id='${TEST_USERNAME}' ORDER BY scratchpad_id DESC LIMIT 1`);
  check('doc has the noteRef but NO color (color lives on the note)',
    /noteRef/.test(doc) && !/color/.test(doc), doc.slice(0, 200));

  // Click outside → float hides.
  await page.locator('.spm-title').click();
  await page.waitForTimeout(300);
  check('clicking outside hides the float', (await page.locator('.sn-note-float').count()) === 0);

  // Click the ref square → float REOPENS with the saved body (fetch fixes the
  // earlier "body gone on reopen" bug).
  await page.locator('.sn-note-ref-sq').first().click();
  await page.waitForTimeout(700);
  check('clicking the square reopens the float', (await page.locator('.sn-note-float').count()) >= 1);
  const reopened = await page.locator('.sn-note-float .note-input').first().inputValue();
  check('reopened float shows the SAVED body (not lost)', /My added thought/.test(reopened), reopened);
  await page.locator('.spm-title').click(); await page.waitForTimeout(200);

  // Color is sourced from the note data: change it in the DB, reopen the float —
  // the ref recolors. (Recolor UI is exercised via the palette in real use;
  // here we prove the source-of-truth by changing the row directly.)
  psql(`UPDATE note SET color='red' WHERE note_id=${noteId}`);
  // Reload the page + reopen the pad so the ref re-fetches its color from the DB.
  await page.reload(); await page.waitForTimeout(500);
  if ((await page.locator('.spm-overlay').count()) === 0) {
    await page.waitForSelector('.card-scratchpad'); await page.locator('.card-scratchpad').first().click();
  }
  await page.waitForSelector('.sn-note-ref', { timeout: 8000 });
  await page.waitForTimeout(800); // ensureNoteCached fetch
  const afterClass = await page.locator('.sn-note-ref').first().getAttribute('class');
  check('ref color re-sourced from note data on reload (red, from DB — not the doc)',
    /color-red/.test(afterClass), afterClass);

  // KEY: completely change the doc, THEN the note is deterministically
  // soft-deleted when its ref leaves the doc (no sweep).
  await page.locator('.spm-editor .ProseMirror').click();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('totally different text now');
  await page.waitForTimeout(600);
  const delRow = psql(`SELECT deleted_at IS NOT NULL AS del FROM note WHERE note_id=${noteId}`).trim();
  check('removing the ref (via bulk edit) soft-deletes the note deterministically (no sweep)',
    /^t$/.test(delRow), delRow);

  // Deleting a PAD takes its notes with it — an orphaned pad note used to
  // haunt the landing page with no UI left to remove it.
  const padId = psql(`SELECT scratchpad_id FROM note WHERE note_id=${noteId}`).trim();
  psql(`UPDATE note SET deleted_at = NULL WHERE note_id=${noteId}`); // resurrect as the pad's note
  const csrf = await page.evaluate(() => localStorage.getItem('csrf_token') || sessionStorage.getItem('csrf_token'));
  const delStatus = await page.evaluate(async ({ padId, csrf }) => {
    const r = await fetch(`api/scratchpads/${padId}`, { method: 'DELETE', headers: { 'X-CSRF-Token': csrf }, credentials: 'include' });
    return r.status;
  }, { padId, csrf });
  check('pad deleted via API', delStatus === 204 || delStatus === 200, `status=${delStatus}`);
  const orphanRow = psql(`SELECT deleted_at IS NOT NULL FROM note WHERE note_id=${noteId}`).trim();
  check('deleting the pad soft-deletes its notes (no orphans)', /^t$/.test(orphanRow), orphanRow);

  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
