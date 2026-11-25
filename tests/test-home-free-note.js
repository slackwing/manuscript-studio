// The landing's Notes section has a "+" ghost card (2026-11-25): it births a
// FREE note (placed nowhere) whose card is its editor — the shared widget,
// live, saving through the note API. Notes with a context keep opening in
// it. The All-notes view carries the ghost too.
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const { TEST_URL, TEST_USERNAME, loginAsTestUser, cleanupTestNotes } = require('./test-utils');
const HOME_URL = new URL('home.html', TEST_URL).href;
const psql = (sql) => execSync(`PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`, { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('=== landing: + creates a free note, edited in place ===\n');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
  page.on('dialog', (d) => d.accept());
  let failed = 0;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed++; };

  await cleanupTestNotes();
  await loginAsTestUser(page);
  await page.goto(HOME_URL);
  await page.waitForSelector('#home-root [data-note-grid]', { timeout: 20000 });
  await page.waitForSelector('#home-root [data-note-grid] .card-ghost[data-ghost="note"]', { timeout: 10000 });
  const ghostLast = await page.evaluate(() => { const g = document.querySelector('#home-root [data-note-grid]'); return g.lastElementChild && g.lastElementChild.dataset.ghost === 'note'; });
  check('the Notes grid ends with a "New note" ghost card', ghostLast);

  await page.click('#home-root [data-note-grid] .card-ghost[data-ghost="note"]');
  await page.waitForSelector('#home-root .card-note.card-note-free .note-input', { timeout: 15000 });
  const born = await page.evaluate(() => {
    const card = document.querySelector('#home-root .card-note.card-note-free');
    const grid = card.closest('[data-note-grid]');
    return { id: card.dataset.noteId, first: grid.firstElementChild === card, yellow: card.classList.contains('color-yellow'), focused: document.activeElement === card.querySelector('.note-input'), button: card.getAttribute('role') === 'button', ctx: !!card.querySelector('.card-meta') };
  });
  check('clicking + births a yellow free note FIRST in the grid, caret in it, not a button, no context line', born.first && born.yellow && born.focused && !born.button && !born.ctx, JSON.stringify(born));
  const row = () => psql(`SELECT color || '|' || coalesce(body,'<null>') || '|' || coalesce(task_type,'-') FROM note WHERE note_id=${born.id}`);
  check('DB: a free note (no placements, no manuscript)', row() === 'yellow|<null>|-' && psql(`SELECT count(*) FROM note_sentence WHERE note_id=${born.id}`) === '0' && psql(`SELECT coalesce(manuscript_id::text,'none') FROM note WHERE note_id=${born.id}`) === 'none', row());

  // ---- edit in place: text, colour, type ----
  await page.keyboard.type('Free as a bird');
  let saved = false;
  for (let i = 0; i < 60 && !saved; i++) { await sleep(150); saved = row().includes('|Free as a bird|'); }
  check('typing in the card saves the note', saved, row());
  // (The palette shows on hover — dispatch the pick.)
  await page.locator(`#home-root .card-note[data-note-id="${born.id}"] .color-circle[data-color="green"]`).dispatchEvent('click');
  await page.waitForSelector(`#home-root .card-note[data-note-id="${born.id}"].color-green`, { timeout: 8000 });
  let green = false;
  for (let i = 0; i < 40 && !green; i++) { await sleep(150); green = row().startsWith('green|'); }
  check('the colour palette recolours the card and the note', green, row());
  await page.click(`#home-root .card-note[data-note-id="${born.id}"] .dim-type`);
  await page.waitForSelector('.dim-pop button[data-v="reminder"]', { timeout: 8000 });
  await page.click('.dim-pop button[data-v="reminder"]');
  let typed = false;
  for (let i = 0; i < 40 && !typed; i++) { await sleep(150); typed = row().endsWith('|reminder'); }
  check('the type chip sets the type', typed, row());
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, clip: { x: 0, y: 0, width: 1300, height: 900 } });

  // ---- reload: still editable; a note WITH context still opens in it ----
  await page.reload();
  await page.waitForSelector(`#home-root .card-note[data-note-id="${born.id}"].card-note-free .note-input`, { timeout: 20000 });
  check('after a reload the free note is still an editable card', true);
  const contextual = await page.evaluate(() => { const c = document.querySelector('#home-root .card-note:not(.card-note-free)'); return c ? { button: c.getAttribute('role') === 'button', hasCtx: !!c.querySelector('.card-meta') } : null; });
  check('a note with a context stays a read-only "open in context" card', !contextual || (contextual.button && contextual.hasCtx), JSON.stringify(contextual));

  // ---- All-notes view carries the ghost too; the trash removes the note ----
  await page.goto(HOME_URL + '?view=notes');
  await page.waitForSelector('#home-root [data-note-grid] .card-ghost[data-ghost="note"]', { timeout: 15000 });
  check('the All-notes view has the + too', true);
  const trash = page.locator(`#home-root .card-note[data-note-id="${born.id}"] .note-trash`);
  await trash.dispatchEvent('click');
  await sleep(300);
  await trash.dispatchEvent('click').catch(() => {}); // two-click confirm
  let gone = false;
  for (let i = 0; i < 40 && !gone; i++) { await sleep(150); gone = psql(`SELECT deleted_at IS NOT NULL FROM note WHERE note_id=${born.id}`) === 't'; }
  check('the card\'s trash deletes the free note', gone);

  await browser.close();
  console.log(failed ? `\n❌ ${failed} check(s) failed` : '\n✅ Test passed');
  process.exit(failed ? 1 : 0);
})();
