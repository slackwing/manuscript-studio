// The existing-note picker in the pad (NOTE_UI_PLAN.md phase 2): the ↗
// button lists recent notes I may place (mine across contexts, with where
// they live); with nothing selected a pick becomes a block at the caret;
// with a selection it becomes that note's text run. Notes already in the
// doc are left out. Either way the save makes the pad placement and the
// note keeps its other placements.
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const { TEST_URL, TEST_MANUSCRIPT_ID, loginAsTestUser, cleanupTestNotes, waitForPagination } = require('./test-utils');
const HOME_URL = new URL('home.html', TEST_URL).href;
const psql = (sql) => execSync(
  `PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`,
  { encoding: 'utf8' }).trim();

(async () => {
  console.log('=== note picker in the pad ===\n');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  page.on('dialog', (d) => d.accept());
  let failed = 0;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed++; };
  const saved = () => page.waitForFunction(() => /^Saved$/.test(document.getElementById('spm-status').textContent.trim()), null, { timeout: 15000 });
  const livePlacements = (id) => psql(`SELECT count(*) FROM note_scratchpad WHERE note_id=${id} AND removed_at IS NULL`);

  await cleanupTestNotes();
  await loginAsTestUser(page);
  // Seeds through the API: a margin note on the test manuscript, a note in another pad.
  await page.goto(TEST_URL);
  await page.waitForSelector('.sentence', { timeout: 30000 });
  await waitForPagination(page);
  const seeds = await page.evaluate(async () => {
    const csrf = sessionStorage.getItem('csrf_token');
    const H = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf };
    const sid = document.querySelector('p .sentence').dataset.sentenceId;
    const margin = await (await fetch('api/notes', { method: 'POST', headers: H, body: JSON.stringify({ sentence_id: sid, color: 'purple', body: 'A margin note to import', priority: 'none' }) })).json();
    const pad = await (await fetch('api/scratchpads', { method: 'POST', headers: H, body: JSON.stringify({ title: 'Picker source pad' }) })).json();
    const padNote = await (await fetch('api/notes', { method: 'POST', headers: H, body: JSON.stringify({ scratchpad_id: pad.scratchpad_id, color: 'green', body: 'From another pad', priority: 'none' }) })).json();
    return { sid, margin: margin.note_id, padId: pad.scratchpad_id, padNote: padNote.note_id };
  });
  check('seeded a margin note and a pad note', seeds.margin > 0 && seeds.padNote > 0, JSON.stringify(seeds));

  await page.goto(HOME_URL);
  await page.waitForSelector('.card-ghost[data-ghost="scratchpad"]'); await page.click('.card-ghost[data-ghost="scratchpad"]');
  await page.waitForSelector('.spm-overlay .ProseMirror');
  const pm = page.locator('.spm-editor .ProseMirror');
  await pm.click();
  await page.keyboard.type('Prose line to note.');
  await page.keyboard.press('Enter');

  // ---- the 7th button opens the picker; it lists both seeds with context ----
  check('the colour bar has the ↗ existing-note button after the six colours, evenly spaced',
    await page.evaluate(() => {
      const bar = document.querySelector('.sn-note-colorbar'); const kids = [...bar.children];
      const gaps = kids.slice(1).map((k, i) => Math.round(k.getBoundingClientRect().left - kids[i].getBoundingClientRect().right));
      return kids.length === 7 && kids[6].classList.contains('sn-note-pickbtn') && !!kids[6].querySelector('svg') && gaps.every((g) => g === gaps[0]);
    }));
  await page.locator('.sn-note-pickbtn').dispatchEvent('mousedown');
  await page.waitForSelector('.note-linkpop.note-pick button[data-nid]', { timeout: 8000 });
  const rows = () => page.evaluate(() => [...document.querySelectorAll('.note-linkpop.note-pick button[data-nid]')].map((b) => ({ id: +b.dataset.nid, text: b.querySelector('.note-pick-text').textContent, ctx: b.querySelector('.note-pick-ctx').textContent })));
  let r = await rows();
  const marginRow = r.find((x) => x.id === seeds.margin), padRow = r.find((x) => x.id === seeds.padNote);
  check('picker lists the margin note with its manuscript as context', !!marginRow && /Test Manuscripts/.test(marginRow.ctx), JSON.stringify(marginRow));
  check('picker lists the pad note with its pad title as context', !!padRow && /Picker source pad/.test(padRow.ctx), JSON.stringify(padRow));
  if (process.env.SHOT) { const b = await page.locator('.spm-overlay').boundingBox(); await page.screenshot({ path: process.env.SHOT, clip: { x: b.x, y: b.y, width: Math.min(b.width, 900), height: 460 } }); }
  await page.locator('.note-linkpop-q').fill('margin note');
  await page.waitForTimeout(450);
  r = await rows();
  check('search narrows the list', r.length >= 1 && r.every((x) => /margin note/i.test(x.text)), JSON.stringify(r.map((x) => x.text)));

  // ---- pick with nothing selected → a block at the caret ----
  await page.locator(`.note-linkpop.note-pick button[data-nid="${seeds.margin}"]`).click();
  await page.waitForSelector(`.sn-note-block[data-note-id="${seeds.margin}"] .sticky-note`, { timeout: 8000 });
  await page.waitForTimeout(300);
  const blk = await page.evaluate((id) => {
    const b = document.querySelector(`.sn-note-block[data-note-id="${id}"]`);
    return { body: b.querySelector('.note-input').value, purple: !!b.querySelector('.sticky-note.color-purple'), afterProse: b.previousElementSibling && /Prose line/.test(b.previousElementSibling.textContent), nextP: b.nextElementSibling && b.nextElementSibling.tagName === 'P' };
  }, seeds.margin);
  check('the picked note appears as a block with its body and colour, after the prose, a paragraph below', blk.body === 'A margin note to import' && blk.purple && blk.afterProse && blk.nextP, JSON.stringify(blk));
  await saved();
  check('save placed the note in THIS pad; its sentence placement stays', livePlacements(seeds.margin) === '1' && psql(`SELECT count(*) FROM note_sentence WHERE note_id=${seeds.margin}`) === '1');

  // ---- a selection + pick → the note's text run; the placed note is excluded ----
  await page.evaluate(() => {
    const ed = document.querySelector('.spm-editor .ProseMirror');
    const p = ed.querySelector('p');
    const rg = document.createRange(); rg.selectNodeContents(p);
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(rg); ed.focus();
  });
  await page.waitForTimeout(150);
  await page.locator('.sn-note-pickbtn').dispatchEvent('mousedown');
  await page.waitForSelector('.note-linkpop.note-pick button[data-nid]', { timeout: 8000 });
  r = await rows();
  check('a note already in this pad is not offered again', !r.some((x) => x.id === seeds.margin) && r.some((x) => x.id === seeds.padNote));
  await page.locator(`.note-linkpop.note-pick button[data-nid="${seeds.padNote}"]`).click();
  await page.waitForSelector(`.sn-note-ref[data-note-id="${seeds.padNote}"]`, { timeout: 8000 });
  const ref = await page.evaluate((id) => { const el = document.querySelector(`.sn-note-ref[data-note-id="${id}"]`); return { text: el.querySelector('.sn-note-ref-text').textContent, cls: el.className }; }, seeds.padNote);
  check('the selection became that note\'s text run, in the note\'s colour', ref.text === 'Prose line to note.' && /color-green/.test(ref.cls), JSON.stringify(ref));
  await saved();
  check('the pad note is now placed in two pads (its own and this one)', livePlacements(seeds.padNote) === '2', livePlacements(seeds.padNote));

  await page.click('#spm-close').catch(() => {});
  psql(`DELETE FROM note WHERE note_id IN (${seeds.margin}, ${seeds.padNote})`);
psql(`DELETE FROM scratchpad_revision WHERE scratchpad_id = ${seeds.padId}; DELETE FROM note_scratchpad WHERE scratchpad_id = ${seeds.padId}; DELETE FROM scratchpad WHERE scratchpad_id = ${seeds.padId}`);
  await cleanupTestNotes();
  await browser.close();
  console.log(failed ? `\n❌ ${failed} check(s) failed` : '\n✅ Test passed');
  process.exit(failed ? 1 : 0);
})();
