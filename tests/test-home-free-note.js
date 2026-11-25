// The landing's Notes section has a "+" ghost card (2026-11-25): it births a
// FREE note (placed nowhere) and opens it in the note modal, where it is
// edited; its card in the grid follows. The All-notes view carries the +.
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const { TEST_URL, loginAsTestUser, cleanupTestNotes } = require('./test-utils');
const HOME_URL = new URL('home.html', TEST_URL).href;
const psql = (sql) => execSync(`PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`, { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('=== landing: + creates a free note, edited in the modal ===\n');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
  page.on('dialog', (d) => d.accept());
  let failed = 0;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed++; };

  await cleanupTestNotes();
  await loginAsTestUser(page);
  await page.goto(HOME_URL);
  await page.waitForSelector('#home-root [data-note-grid] .card-ghost[data-ghost="note"]', { timeout: 20000 });
  check('the Notes grid ends with a "New note" ghost card', await page.evaluate(() => { const g = document.querySelector('#home-root [data-note-grid]'); return g.lastElementChild.dataset.ghost === 'note'; }));

  await page.click('#home-root [data-note-grid] .card-ghost[data-ghost="note"]');
  await page.waitForSelector('.nm-overlay .nm-note .note-input', { timeout: 15000 });
  const id = psql(`SELECT max(note_id) FROM note WHERE user_id='${(await page.evaluate(() => window.currentSession && window.currentSession.username)) || 'test'}'`);
  const born = await page.evaluate(() => ({ focused: document.activeElement === document.querySelector('.nm-overlay .nm-note .note-input'), yellow: !!document.querySelector('.nm-overlay .sticky-note.color-yellow'), cards: document.querySelectorAll('.nm-overlay .nm-card').length }));
  check('+ births a yellow free note and opens it in the modal, caret in it, no placement cards', born.focused && born.yellow && born.cards === 0, JSON.stringify(born));
  const row = () => psql(`SELECT color || '|' || coalesce(body,'<null>') FROM note WHERE note_id=${id}`);
  check('DB: a free note (no placements, no manuscript)', row() === 'yellow|<null>' && psql(`SELECT count(*) FROM note_sentence WHERE note_id=${id}`) === '0', row());
  await page.keyboard.type('Free as a bird');
  let saved = false;
  for (let i = 0; i < 60 && !saved; i++) { await sleep(150); saved = row() === 'yellow|Free as a bird'; }
  check('typing in the modal saves the note', saved, row());
  await page.keyboard.press('Escape');
  await page.waitForSelector('.nm-overlay', { state: 'detached', timeout: 5000 });
  await page.waitForFunction((id) => { const g = document.querySelector('#home-root [data-note-grid]'); const c = g && g.firstElementChild; return !!c && c.dataset.noteId === String(id) && /Free as a bird/.test(c.textContent); }, id, { timeout: 15000 });
  check('after closing, the new note is the first card in the grid', true);

  await page.goto(HOME_URL + '?view=notes');
  await page.waitForSelector('#home-root [data-note-grid] .card-ghost[data-ghost="note"]', { timeout: 15000 });
  check('the All-notes view has the + too', true);
  await page.click(`#home-root .card-note[data-note-id="${id}"]`);
  await page.waitForSelector('.nm-overlay .note-trash', { timeout: 10000 });
  const trash = page.locator('.nm-overlay .note-trash');
  await trash.dispatchEvent('click');
  await sleep(300);
  await trash.dispatchEvent('click').catch(() => {});
  let gone = false;
  for (let i = 0; i < 40 && !gone; i++) { await sleep(150); gone = psql(`SELECT deleted_at IS NOT NULL FROM note WHERE note_id=${id}`) === 't'; }
  check('the modal\'s trash deletes the free note and closes', gone && !(await page.locator('.nm-overlay').count()));

  await browser.close();
  console.log(failed ? `\n❌ ${failed} check(s) failed` : '\n✅ Test passed');
  process.exit(failed ? 1 : 0);
})();
