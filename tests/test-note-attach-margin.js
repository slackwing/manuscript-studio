// The margin's ↗ chip (NOTE_UI_PLAN.md phase 3): the grey new-note card
// offers existing notes; a pick places the note on the sentence and it
// shows in the margin with its text. The trash on a note that lives in
// more than one place removes it from THIS sentence (the note survives);
// on its last placement it deletes.
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const { TEST_URL, loginAsTestUser, cleanupTestNotes, waitForPagination } = require('./test-utils');
const psql = (sql) => execSync(
  `PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`,
  { encoding: 'utf8' }).trim();

(async () => {
  console.log('=== attach an existing note from the margin ===\n');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  page.on('dialog', (d) => d.accept());
  let failed = 0;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed++; };

  await cleanupTestNotes();
  await loginAsTestUser(page);
  await page.goto(TEST_URL);
  await page.waitForSelector('.sentence', { timeout: 30000 });
  await waitForPagination(page);
  // Seed: a note born in a pad (its default text stays unset — born context rules).
  const seed = await page.evaluate(async () => {
    const H = { 'Content-Type': 'application/json', 'X-CSRF-Token': sessionStorage.getItem('csrf_token') };
    const pad = await (await fetch('api/scratchpads', { method: 'POST', headers: H, body: JSON.stringify({ title: 'Attach source pad' }) })).json();
    const n = await (await fetch('api/notes', { method: 'POST', headers: H, body: JSON.stringify({ scratchpad_id: pad.scratchpad_id, color: 'orange', body: 'Born in a pad, placed on a sentence', priority: 'none' }) })).json();
    return { padId: pad.scratchpad_id, noteId: n.note_id };
  });
  check('seeded a pad note', seed.noteId > 0, JSON.stringify(seed));

  // Click a sentence → the grey card shows n/a · + tag · ↗ (right-aligned).
  const sids = await page.evaluate(() => [...new Set([...document.querySelectorAll('p .sentence')].filter((s) => s.textContent.trim().length > 20).map((s) => s.dataset.sentenceId))].slice(0, 2));
  await page.click(`.pagedjs_pages .sentence[data-sentence-id="${sids[0]}"]`);
  await page.waitForSelector('.sticky-note.uncreated-note.first-uncreated .attach-chip', { timeout: 10000 });
  const chipGeom = await page.evaluate(() => {
    const list = document.querySelector('.sticky-note.first-uncreated .tags-list');
    const chips = [...list.children].map((c) => c.className.replace(/\s*tag-chip\s*/, '').trim());
    const chip = list.querySelector('.attach-chip').getBoundingClientRect();
    const row = document.querySelector('.sticky-note.first-uncreated .sticky-bottom-controls').getBoundingClientRect();
    const tag = list.querySelector('.new-tag').getBoundingClientRect();
    return { chips, rightAligned: row.right - chip.right < 4 && chip.left - tag.right > 20, svg: !!list.querySelector('.attach-chip svg') };
  });
  check('grey card chips: type, + tag, then the ↗ chip right-aligned', chipGeom.chips.length === 3 && /attach-chip/.test(chipGeom.chips[2]) && chipGeom.rightAligned && chipGeom.svg, JSON.stringify(chipGeom));

  // ---- pick the pad note → it is on the sentence, in the margin ----
  await page.click('.sticky-note.first-uncreated .attach-chip');
  await page.waitForSelector(`.note-linkpop.note-pick button[data-nid="${seed.noteId}"]`, { timeout: 8000 });
  check('the picker lists the pad note with its pad as context', /Attach source pad/.test(await page.locator(`.note-linkpop.note-pick button[data-nid="${seed.noteId}"] .note-pick-ctx`).textContent()));
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, clip: { x: 0, y: 60, width: 420, height: 520 } });
  await page.click(`.note-linkpop.note-pick button[data-nid="${seed.noteId}"]`);
  await page.waitForSelector(`#sticky-notes-container .sticky-note[data-note-id="${seed.noteId}"]`, { timeout: 10000 });
  const placed = await page.evaluate((id) => {
    const el = document.querySelector(`#sticky-notes-container .sticky-note[data-note-id="${id}"]`);
    return { body: el.querySelector('.note-input').value, orange: el.classList.contains('color-orange'), inCache: (window.WriteSysRenderer.currentNotes || []).some((n) => n.note_id === id) };
  }, seed.noteId);
  check('the pad note now sits in the margin on this sentence, with its text and colour', placed.body === 'Born in a pad, placed on a sentence' && placed.orange && placed.inCache, JSON.stringify(placed));
  check('DB: a sentence placement was added; the pad placement stays', psql(`SELECT count(*) FROM note_sentence WHERE note_id=${seed.noteId} AND sentence_id='${sids[0]}'`) === '1' && psql(`SELECT count(*) FROM note_scratchpad WHERE note_id=${seed.noteId} AND removed_at IS NULL`) === '1');
  check('default text was set where the note was born: still none', psql(`SELECT COALESCE(default_body,'<null>') FROM note WHERE note_id=${seed.noteId}`) === '<null>');
  // The picker no longer offers it for this sentence.
  await page.click('.sticky-note.uncreated-note .attach-chip');
  await page.waitForSelector('.note-linkpop.note-pick', { timeout: 8000 });
  await page.waitForTimeout(500);
  check('a note already on the sentence is not offered again', (await page.locator(`.note-linkpop.note-pick button[data-nid="${seed.noteId}"]`).count()) === 0);
  await page.keyboard.press('Escape');

  // ---- trash on a multi-placed note = remove from this sentence ----
  const trash = page.locator(`#sticky-notes-container .sticky-note[data-note-id="${seed.noteId}"] .note-trash`);
  await page.hover(`#sticky-notes-container .sticky-note[data-note-id="${seed.noteId}"]`);
  await trash.click(); await page.waitForTimeout(150); await trash.click();
  await page.waitForFunction((id) => !document.querySelector(`#sticky-notes-container .sticky-note[data-note-id="${id}"]`), seed.noteId, { timeout: 8000 });
  check('trash removed it from the sentence; the note is alive and still in its pad',
    psql(`SELECT count(*) FROM note_sentence WHERE note_id=${seed.noteId}`) === '0'
    && psql(`SELECT deleted_at IS NULL FROM note WHERE note_id=${seed.noteId}`) === 't'
    && psql(`SELECT count(*) FROM note_scratchpad WHERE note_id=${seed.noteId} AND removed_at IS NULL`) === '1');

  // ---- a note on this sentence only: the trash deletes, as always ----
  await page.click(`.pagedjs_pages .sentence[data-sentence-id="${sids[1]}"]`);
  await page.waitForSelector('.sticky-note.uncreated-note.first-uncreated .note-input', { timeout: 10000 });
  await page.click('.sticky-note.uncreated-note.first-uncreated .note-input');
  await page.keyboard.type('Only here.');
  await page.waitForSelector(`#sticky-notes-container .sticky-note[data-note-id]:not(.uncreated-note)`, { timeout: 10000 });
  const soloId = await page.evaluate(() => parseInt(document.querySelector('#sticky-notes-container .sticky-note[data-note-id]:not(.uncreated-note)').dataset.noteId, 10));
  // Its text save has landed (so no late PUT follows the delete).
  for (let i = 0; i < 20 && psql(`SELECT COALESCE(body,'') FROM note WHERE note_id=${soloId}`) !== 'Only here.'; i++) await page.waitForTimeout(250);
  const t2 = page.locator(`#sticky-notes-container .sticky-note[data-note-id="${soloId}"] .note-trash`);
  await page.hover(`#sticky-notes-container .sticky-note[data-note-id="${soloId}"]`);
  await t2.click(); await page.waitForTimeout(150); await t2.click();
  await page.waitForFunction((id) => !document.querySelector(`#sticky-notes-container .sticky-note[data-note-id="${id}"]`), soloId, { timeout: 8000 });
  check('a single-placement note is deleted by its trash', psql(`SELECT deleted_at IS NOT NULL FROM note WHERE note_id=${soloId}`) === 't');

  psql(`DELETE FROM note WHERE note_id = ${seed.noteId}`);
psql(`DELETE FROM scratchpad_revision WHERE scratchpad_id = ${seed.padId}; DELETE FROM note_scratchpad WHERE scratchpad_id = ${seed.padId}; DELETE FROM scratchpad WHERE scratchpad_id = ${seed.padId}`);
  await cleanupTestNotes();
  await browser.close();
  console.log(failed ? `\n❌ ${failed} check(s) failed` : '\n✅ Test passed');
  process.exit(failed ? 1 : 0);
})();
