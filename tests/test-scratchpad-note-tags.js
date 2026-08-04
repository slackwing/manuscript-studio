// Phase A (user-wide tags): a SCRATCHPAD note has no sentence, hence no
// migration. Before migration 020, tagging it 500'd ("Failed to add tag")
// because the server scoped tags to the note's sentence→migration. Tags are
// now user-wide, so a scratchpad note can be tagged and the tag round-trips.
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
  // A user-wide 'idea' tag from a prior run must not leak in; clean it.
  psql(`DELETE FROM tag WHERE user_id='test' AND tag_name='sctag'`);
  await loginAsTestUser(page);
  await page.goto(HOME_URL);
  await page.waitForSelector('#home-new-pad'); await page.click('#home-new-pad');
  await page.waitForSelector('.spm-overlay .ProseMirror');

  // Make a scratchpad note.
  const pm = page.locator('.spm-editor .ProseMirror');
  await pm.click();
  await page.keyboard.type('Tag me, I am a scratchpad note.');
  await page.keyboard.press('Home');
  await page.keyboard.down('Shift'); await page.keyboard.press('End'); await page.keyboard.up('Shift');
  await page.waitForTimeout(150);
  await page.locator('.sn-note-colorbar .sn-note-colorbtn').first().click();
  await page.waitForTimeout(600);

  const noteId = await page.locator('.sn-note-ref').first().getAttribute('data-note-id');
  check('scratchpad note created', !!noteId, `noteId=${noteId}`);
  const kind = psql(`SELECT (sentence_id IS NULL) no_sentence, (scratchpad_id IS NOT NULL) has_pad FROM note WHERE note_id=${noteId}`).trim();
  check('note is a scratchpad note (no sentence, has pad)', /t\|t/.test(kind), kind);

  // Add a tag through the shared widget's inline input inside the float.
  const float = page.locator('.sn-note-float .sticky-note');
  await float.locator('.tags-list .new-tag').click();
  await page.locator('.sn-note-float .tag-input').fill('sctag');
  await page.keyboard.press('Enter');
  // Wait for the chip to render (add → API round-trip → shared renderTags).
  await float.locator('.tag-chip[data-tag-id]').first().waitFor({ timeout: 4000 }).catch(() => {});

  // Chip shows in the UI.
  const chipText = await float.locator('.tag-chip[data-tag-id]').first().textContent().catch(() => '');
  check('tag chip appears on the scratchpad note', /sctag/.test(chipText), chipText);

  // It PERSISTED in the DB (the actual bug: this used to 500).
  const dbTag = psql(`SELECT t.tag_name, t.user_id FROM tag t JOIN note_tag nt ON nt.tag_id=t.tag_id WHERE nt.note_id=${noteId}`).trim();
  check('tag persisted (tag_name=sctag, user-scoped)', /sctag\|test/.test(dbTag), dbTag);

  // Wait until the scratchpad doc has actually PERSISTED the noteRef before
  // reloading (autosave is debounced; reloading early loses the ref). Poll DB.
  let persisted = false;
  for (let i = 0; i < 20 && !persisted; i++) {
    const has = psql(`SELECT (doc::text LIKE '%noteRef%') FROM scratchpad WHERE user_id='test' ORDER BY scratchpad_id DESC LIMIT 1`).trim();
    persisted = has === 't';
    if (!persisted) await page.waitForTimeout(300);
  }
  check('noteRef persisted to the scratchpad doc', persisted);

  // Reload + reopen the float → the tag is still there (round-trip via GET).
  await page.reload(); await page.waitForTimeout(800);
  if ((await page.locator('.spm-overlay').count()) === 0) {
    await page.waitForSelector('.card-scratchpad', { timeout: 20000 });
    await page.locator('.card-scratchpad').first().click();
  }
  await page.waitForSelector('.spm-editor .ProseMirror', { timeout: 20000 });
  await page.waitForSelector('.sn-note-ref', { timeout: 20000 });
  await page.waitForTimeout(400);
  await page.locator('.sn-note-ref-sq').first().click();
  await page.waitForTimeout(700);
  const reChip = await page.locator('.sn-note-float .tag-chip[data-tag-id]').first().textContent().catch(() => '');
  check('tag survives reload/reopen', /sctag/.test(reChip), reChip);

  // Remove the tag via the chip × → gone from DB.
  await page.locator('.sn-note-float .tag-chip[data-tag-id] .tag-chip-remove').first().click();
  await page.waitForTimeout(500);
  const afterRm = psql(`SELECT count(*) FROM note_tag WHERE note_id=${noteId}`).trim();
  check('tag removed from note', afterRm === '0', `note_tag count=${afterRm}`);

  psql(`DELETE FROM tag WHERE user_id='test' AND tag_name='sctag'`);
  await browser.close();
  console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS');
  process.exit(failed ? 1 : 0);
})();
