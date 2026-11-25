// The note modal (notes/note-modal.js, 2026-11-25): a note card on the
// landing / a board opens the FULL note centred over a greyed page, editable,
// with one card per placement tiled under it in a forming square (cols =
// ⌈√n⌉). Hovering a manuscript card shows the sentence as the book sets it;
// clicking goes to that sentence; a pad card opens the pad. Escape closes.
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const { TEST_URL, TEST_USERNAME, TEST_MANUSCRIPT_ID, loginAsTestUser, cleanupTestNotes } = require('./test-utils');
const HOME_URL = new URL('home.html', TEST_URL).href;
const psql = (sql) => execSync(`PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`, { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('=== note modal ===\n');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  page.on('dialog', (d) => d.accept());
  page.on('pageerror', (e) => console.log('   PAGEERROR', e.message.slice(0, 160)));
  let failed = 0;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed++; };

  await cleanupTestNotes();
  await loginAsTestUser(page);
  await page.goto(HOME_URL);
  await page.waitForSelector('#home-root .home-section', { timeout: 20000 });
  const mig = psql(`SELECT max(migration_id) FROM migration WHERE manuscript_id=${TEST_MANUSCRIPT_ID}`);
  const sidAt = (ord) => psql(`SELECT sentence_id FROM sentence WHERE migration_id=${mig} AND ordinal=${ord}`);
  const s2 = sidAt(2), s5 = sidAt(5), s7 = sidAt(7), s9 = sidAt(9);
  const seeded = await page.evaluate(async ({ s2, s5 }) => {
    const H = { 'Content-Type': 'application/json', 'X-CSRF-Token': sessionStorage.getItem('csrf_token') || localStorage.getItem('csrf_token') };
    const pad = await (await fetch('api/scratchpads', { method: 'POST', headers: H, body: JSON.stringify({ title: 'Modal pad' }) })).json();
    const n = await (await fetch('api/notes', { method: 'POST', headers: H, body: JSON.stringify({ scratchpad_id: pad.scratchpad_id, color: 'green', body: 'Modal note' }) })).json();
    for (const sid of [s2, s5]) await fetch(`api/notes/${n.note_id}/sentences/${encodeURIComponent(sid)}`, { method: 'PUT', headers: H });
    return { padId: pad.scratchpad_id, noteId: n.note_id };
  }, { s2, s5 });
  check('seeded a note on a pad and two sentences', seeded.noteId > 0, JSON.stringify(seeded));
  await page.reload();
  await page.waitForSelector(`#home-root .card-note[data-note-id="${seeded.noteId}"]`, { timeout: 20000 });

  // ---- open: the modal, not the context ----
  await page.click(`#home-root .card-note[data-note-id="${seeded.noteId}"]`);
  await page.waitForSelector('.nm-overlay .nm-note .note-input', { timeout: 10000 });
  await page.waitForSelector('.nm-overlay .nm-cards .nm-card', { timeout: 10000 });
  const opened = await page.evaluate(() => {
    const ov = document.querySelector('.nm-overlay');
    const ta = ov.querySelector('.nm-note .note-input');
    const cards = [...ov.querySelectorAll('.nm-card')];
    const grid = ov.querySelector('.nm-cards');
    return {
      greyed: getComputedStyle(ov).backgroundColor !== 'rgba(0, 0, 0, 0)', value: ta.value, focused: document.activeElement === ta,
      cards: cards.map((c) => c.className.replace(/card |nm-card /g, '').trim() + ':' + c.querySelector('.card-title').textContent),
      cols: grid.style.getPropertyValue('--nm-cols'), noTabChange: !location.hash.includes('manuscript'),
    };
  });
  check('clicking a note card greys the page and shows the full note, editable and focused', opened.greyed && opened.value === 'Modal note' && opened.focused && opened.noTabChange, JSON.stringify(opened));
  check('one card per placement — 2 manuscript + 1 pad — in a 2-column forming square', opened.cards.length === 3 && opened.cards.filter((c) => c.startsWith('nm-card-manuscript')).length === 2 && opened.cards.some((c) => c === 'nm-card-pad:Modal pad') && opened.cols === '2', JSON.stringify(opened.cards) + ' cols=' + opened.cols);
  const msNames = opened.cards.filter((c) => c.startsWith('nm-card-manuscript')).map((c) => c.split(':')[1]);
  check('the two manuscript cards both carry the manuscript\'s name', msNames[0] && msNames[0] === msNames[1], JSON.stringify(msNames));

  // ---- hover: the sentence as the book sets it ----
  const sText = psql(`SELECT text FROM sentence WHERE sentence_id='${s2}'`).replace(/\\n|\\t/g, ' ').replace(/\s+/g, ' ').trim();
  await page.hover('.nm-overlay .nm-card-manuscript');
  await page.waitForSelector('.nm-hint', { timeout: 5000 });
  const hint = await page.evaluate(() => {
    const h = document.querySelector('.nm-hint .nm-hint-page');
    const root = h && h.shadowRoot;
    const book = root && root.querySelector('.scratch-book');
    const r = document.querySelector('.nm-hint').getBoundingClientRect();
    return { text: book ? book.textContent.replace(/\s+/g, ' ').trim() : '', font: book ? getComputedStyle(book).fontFamily : '', onScreen: r.top >= 0 && r.bottom <= innerHeight, bookStyled: !!root && !!root.querySelector('link[href*="book.css"]') };
  });
  const probe = sText.replace(/[*_]/g, '').slice(0, 24);
  check('hovering a manuscript card shows the sentence, set in the book\'s typography', hint.text.includes(probe) && hint.bookStyled && /Georgia|serif/i.test(hint.font) && hint.onScreen, JSON.stringify({ probe, got: hint.text.slice(0, 50), font: hint.font }));
  await page.mouse.move(5, 5);
  await page.waitForSelector('.nm-hint', { state: 'detached', timeout: 3000 }).catch(() => {});

  // ---- edits save from the modal ----
  await page.click('.nm-overlay .nm-note .note-input');
  await page.keyboard.press('End');
  await page.keyboard.type(' edited');
  let saved = false;
  for (let i = 0; i < 40 && !saved; i++) { await sleep(150); saved = psql(`SELECT body FROM note WHERE note_id=${seeded.noteId}`) === 'Modal note edited'; }
  check('typing in the modal saves the note', saved);
  await page.locator('.nm-overlay .nm-note .color-circle[data-color="blue"]').dispatchEvent('click');
  let blue = false;
  for (let i = 0; i < 40 && !blue; i++) { await sleep(150); blue = psql(`SELECT color FROM note WHERE note_id=${seeded.noteId}`) === 'blue'; }
  check('the palette recolours the note', blue);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.nm-overlay', { state: 'detached', timeout: 5000 });
  await page.waitForFunction((id) => { const c = document.querySelector(`#home-root .card-note[data-note-id="${id}"]`); return !!c && c.classList.contains('color-blue') && /Modal note edited/.test(c.textContent); }, seeded.noteId, { timeout: 15000 });
  check('Escape closes it and the card behind reflects the edits', true);

  // ---- 5 placements → 3 columns (3 + 2) ----
  await page.evaluate(async ({ id, s7, s9 }) => {
    const H = { 'X-CSRF-Token': sessionStorage.getItem('csrf_token') || localStorage.getItem('csrf_token') };
    for (const sid of [s7, s9]) await fetch(`api/notes/${id}/sentences/${encodeURIComponent(sid)}`, { method: 'PUT', headers: H });
  }, { id: seeded.noteId, s7, s9 });
  await page.click(`#home-root .card-note[data-note-id="${seeded.noteId}"]`);
  await page.waitForFunction(() => document.querySelectorAll('.nm-overlay .nm-card').length === 5, null, { timeout: 10000 });
  check('five placements tile as a 3-column forming square', (await page.evaluate(() => document.querySelector('.nm-cards').style.getPropertyValue('--nm-cols'))) === '3');

  // ---- a manuscript card goes to its sentence; a pad card opens the pad ----
  await page.click('.nm-overlay .nm-card-manuscript');
  await page.waitForSelector(`#ms-tab-panels iframe[src*="manuscript_id=${TEST_MANUSCRIPT_ID}"].active`, { timeout: 15000 });
  const framed = await page.evaluate(() => ({ src: document.querySelector('#ms-tab-panels iframe.active').getAttribute('src'), modalGone: !document.querySelector('.nm-overlay') }));
  check('a manuscript card opens the book at that sentence (and closes the modal)', framed.modalGone && framed.src.includes('note-sentence=' + encodeURIComponent(s2)), JSON.stringify(framed));
  await page.evaluate(() => window.WriteSysTabs.activate(null));
  await page.waitForSelector(`#home-root .card-note[data-note-id="${seeded.noteId}"]`, { timeout: 15000 });
  await page.click(`#home-root .card-note[data-note-id="${seeded.noteId}"]`);
  await page.waitForSelector('.nm-overlay .nm-card-pad', { timeout: 10000 });
  await page.click('.nm-overlay .nm-card-pad');
  await page.waitForSelector('.spm-overlay .ProseMirror', { timeout: 15000 });
  check('a pad card opens the scratchpad', !(await page.locator('.nm-overlay').count()));
  await page.keyboard.press('Escape');
  await page.waitForSelector('.spm-overlay', { state: 'detached', timeout: 10000 }).catch(() => {});

  // ---- a board's cards open the modal too ----
  const b = await page.evaluate(async () => window.WriteSysHome.api('api/boards', { method: 'POST', body: JSON.stringify({ name: 'Modal board' }) }));
  await page.evaluate((id) => window.WriteSysTabs.openBoard(id, 'Modal board'), b.board_id);
  await page.waitForSelector('#ms-tab-panels iframe[src*="view=board"].active', { timeout: 15000 });
  const frame = page.frames().find((f) => f.url().includes('view=board'));
  await frame.waitForSelector(`.board-page .card-note[data-note-id="${seeded.noteId}"]`, { timeout: 20000 });
  await frame.evaluate((id) => document.querySelector(`.board-page .card-note[data-note-id="${id}"]`).click(), seeded.noteId);
  await frame.waitForSelector('.nm-overlay .nm-note .note-input', { timeout: 10000 });
  check('on a board, a card opens the same modal', (await frame.locator('.nm-overlay .nm-card').count()) === 5);
  await page.evaluate(async (id) => { await window.WriteSysHome.api(`api/boards/${id}`, { method: 'DELETE' }); window.WriteSysTabs.unpin('board', id); }, b.board_id);
  await page.evaluate(() => { try { localStorage.removeItem('ms_pinned_tabs'); localStorage.removeItem('ms_split'); sessionStorage.removeItem('ms_split_session'); } catch (e) {} });
  await browser.close();
  console.log(failed ? `\n❌ ${failed} check(s) failed` : '\n✅ Test passed');
  process.exit(failed ? 1 : 0);
})();
