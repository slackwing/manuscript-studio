// Boards (BOARDS_PLAN.md, 2026-11-25): a Boards section on the landing
// between Scratchpads and Notes; "+" creates a board and opens it as a TAB;
// the board page shows the SHARED rules editor (with the manuscript picker)
// above the notes it matches; rename renames the tab; Delete closes it.
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const { TEST_URL, TEST_USERNAME, TEST_MANUSCRIPT_ID, loginAsTestUser, cleanupTestNotes } = require('./test-utils');
const HOME_URL = new URL('home.html', TEST_URL).href;
const psql = (sql) => execSync(`PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`, { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('=== boards ===\n');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  page.on('dialog', (d) => d.accept());
  page.on('pageerror', (e) => console.log('   PAGEERROR', e.message.slice(0, 160)));
  let failed = 0;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed++; };

  await cleanupTestNotes();
  psql(`UPDATE board SET deleted_at = now() WHERE user_id='${TEST_USERNAME}' AND deleted_at IS NULL`);
  await loginAsTestUser(page);
  await page.goto(HOME_URL);
  await page.waitForSelector('#home-root .home-section', { timeout: 20000 });
  // Notes to look at: two tagged "hone-me" (one on the book, one free), one untagged.
  const seeded = await page.evaluate(async (mid) => {
    const H = { 'Content-Type': 'application/json', 'X-CSRF-Token': sessionStorage.getItem('csrf_token') || localStorage.getItem('csrf_token') };
    const mk = async (body, extra) => (await (await fetch('api/notes', { method: 'POST', headers: H, body: JSON.stringify(Object.assign({ color: 'yellow', body }, extra || {})) })).json()).note_id;
    const tag = (id) => fetch(`api/notes/${id}/tags`, { method: 'POST', headers: H, body: JSON.stringify({ tag_name: 'hone-me' }) });
    const a = await mk('Board note A (on the book)', { manuscript_id: mid }); await tag(a);
    const b = await mk('Board note B (free)'); await tag(b);
    const c = await mk('Board note C (untagged, on the book)', { manuscript_id: mid });
    return { a, b, c };
  }, TEST_MANUSCRIPT_ID);
  check('seeded three notes', seeded.a > 0 && seeded.b > 0 && seeded.c > 0, JSON.stringify(seeded));
  await page.reload();
  await page.waitForSelector('#home-root .home-section', { timeout: 20000 });
  const order = await page.evaluate(() => [...document.querySelectorAll('#home-root .home-section h2')].map((h) => h.textContent));
  check('landing: Boards sits between Scratchpads and Notes', order.indexOf('Boards') === order.indexOf('Scratchpads') + 1 && order.indexOf('Notes') === order.indexOf('Boards') + 1, JSON.stringify(order));
  await page.click('#home-root .card-ghost[data-ghost="board"]');
  await page.waitForSelector('#ms-tabs .ms-tab-board.active', { timeout: 15000 });
  await page.waitForSelector('#ms-tab-panels iframe[src*="view=board"].active', { timeout: 15000 });
  const boardId = psql(`SELECT max(board_id) FROM board WHERE user_id='${TEST_USERNAME}' AND deleted_at IS NULL`);
  check('+ creates a board and opens it as a tab', !!boardId && (await page.locator('#ms-tabs .ms-tab-board').textContent()).includes('Board'), boardId);

  const frame = page.frames().find((f) => f.url().includes('view=board'));
  await frame.waitForSelector('.board-page #board-rules .rules-builder .dim-type', { timeout: 20000 });
  await frame.waitForSelector('.board-page [data-note-grid] .card-note', { timeout: 20000 });
  const first = await frame.evaluate(() => ({
    notes: document.querySelectorAll('.board-page [data-note-grid] .card-note').length,
    picker: [...document.querySelectorAll('.rules-manuscripts .rules-ms')].map((c) => c.textContent),
    builder: !!document.querySelector('.rules-builder .dim-cap') && !!document.querySelector('.rules-builder .dr-add'),
    cap: (document.querySelector('.rules-builder .dim-cap .dim-label') || {}).textContent,
    name: document.querySelector('.board-name').value,
  }));
  check('board page: the rules editor (picker + builder) sits above ALL the notes', first.notes >= 3 && first.picker.length >= 1 && first.builder && first.name === 'Board', JSON.stringify(first));
  check('the cap chip reads ∞ by default on a board (no -1 anywhere)', first.cap === '∞', first.cap);

  // ---- a tag rule narrows the board ----
  await frame.fill('.rules-builder .dr-tag-input', 'hone-me');
  await frame.press('.rules-builder .dr-tag-input', 'Enter');
  await frame.waitForSelector('.rules-builder .tag-chip', { timeout: 5000 });
  await frame.click('.rules-builder .dr-add');
  await frame.waitForSelector('#board-rules .dr-rule', { timeout: 8000 });
  await frame.waitForFunction((n) => document.querySelectorAll('.board-page [data-note-grid] .card-note').length === n, 2, { timeout: 10000 }).catch(() => {});
  const tagged = await frame.evaluate(() => [...document.querySelectorAll('.board-page [data-note-grid] .card-note')].map((c) => parseInt(c.dataset.noteId, 10)));
  check('a "hone-me" rule leaves the two tagged notes', tagged.length === 2 && tagged.includes(seeded.a) && tagged.includes(seeded.b), JSON.stringify(tagged));
  check('DB: the rule belongs to the board, not the daily rules', psql(`SELECT count(*) FROM daily_rule WHERE user_id='${TEST_USERNAME}' AND board_id=${boardId}`) === '1' && psql(`SELECT count(*) FROM daily_rule WHERE user_id='${TEST_USERNAME}' AND board_id IS NULL`) === '0');

  // ---- the manuscript picker: only the book's notes ----
  await frame.click(`.rules-manuscripts .rules-ms[data-manuscript-id="${TEST_MANUSCRIPT_ID}"]`);
  await frame.waitForFunction((n) => document.querySelectorAll('.board-page [data-note-grid] .card-note').length === n, 1, { timeout: 10000 }).catch(() => {});
  const picked = await frame.evaluate(() => [...document.querySelectorAll('.board-page [data-note-grid] .card-note')].map((c) => parseInt(c.dataset.noteId, 10)));
  check('picking the book keeps only its tagged note', picked.length === 1 && picked[0] === seeded.a, JSON.stringify(picked));
  check('DB: manuscript_ids saved', psql(`SELECT manuscript_ids FROM board WHERE board_id=${boardId}`) === `{${TEST_MANUSCRIPT_ID}}`);
  await frame.click(`.rules-manuscripts .rules-ms[data-manuscript-id="${TEST_MANUSCRIPT_ID}"]`); // none = all again
  await frame.waitForFunction((n) => document.querySelectorAll('.board-page [data-note-grid] .card-note').length === n, 2, { timeout: 10000 }).catch(() => {});
  check('unpicking (none) means all books again', (await frame.locator('.board-page [data-note-grid] .card-note').count()) === 2);

  // ---- sort (060): recent = last-touched first; manuscript = sentence order first ----
  const sids = psql(`SELECT s.sentence_id FROM sentence s JOIN migration mg ON mg.migration_id=s.migration_id WHERE mg.manuscript_id=${TEST_MANUSCRIPT_ID} AND mg.migration_id=(SELECT max(migration_id) FROM migration WHERE manuscript_id=${TEST_MANUSCRIPT_ID}) AND s.ordinal IN (2,5) ORDER BY s.ordinal`).split('\n');
  const placed = await frame.evaluate(async ({ s2, s5 }) => {
    const H = { 'Content-Type': 'application/json', 'X-CSRF-Token': sessionStorage.getItem('csrf_token') || localStorage.getItem('csrf_token') };
    const mk = async (body, sid) => (await (await fetch('api/notes', { method: 'POST', headers: H, body: JSON.stringify({ color: 'blue', body, sentence_id: sid }) })).json()).note_id;
    const tag = (id) => fetch(`api/notes/${id}/tags`, { method: 'POST', headers: H, body: JSON.stringify({ tag_name: 'hone-me' }) });
    const n2 = await mk('Sort note on sentence 2', s2); await tag(n2);
    const n5 = await mk('Sort note on sentence 5', s5); await tag(n5); // created LAST → touched last
    return { n2, n5 };
  }, { s2: sids[0], s5: sids[1] });
  await frame.evaluate(() => window.WriteSysHome.refreshBoardNotes());
  await frame.waitForFunction((n) => document.querySelectorAll('.board-page [data-note-grid] .card-note').length === n, 4, { timeout: 10000 }).catch(() => {});
  const recentOrder = await frame.evaluate(() => [...document.querySelectorAll('.board-page [data-note-grid] .card-note')].map((c) => parseInt(c.dataset.noteId, 10)));
  check('default sort: the last-touched note leads (created last)', recentOrder[0] === placed.n5, JSON.stringify(recentOrder));
  await frame.click('.board-sort .dim-sort');
  await frame.waitForSelector('.dim-pop button[data-v="manuscript"]', { timeout: 5000 });
  await frame.click('.dim-pop button[data-v="manuscript"]');
  await frame.waitForFunction((n) => { const l = [...document.querySelectorAll('.board-page [data-note-grid] .card-note')].map((c) => parseInt(c.dataset.noteId, 10)); return l[0] === n; }, placed.n2, { timeout: 10000 }).catch(() => {});
  const msOrder = await frame.evaluate(() => [...document.querySelectorAll('.board-page [data-note-grid] .card-note')].map((c) => parseInt(c.dataset.noteId, 10)));
  check('manuscript sort: sentence 2 before sentence 5, then the unplaced', msOrder[0] === placed.n2 && msOrder[1] === placed.n5 && msOrder.length === 4, JSON.stringify(msOrder));
  check('DB: the sort is saved on the board', psql(`SELECT sort FROM board WHERE board_id=${boardId}`) === 'manuscript');

  // ---- rename renames the tab; the landing card shows the board ----
  await frame.fill('.board-name', 'Hone list');
  await frame.press('.board-name', 'Enter');
  await page.waitForFunction(() => (document.querySelector('#ms-tabs .ms-tab-board') || {}).textContent.includes('Hone list'), null, { timeout: 8000 }).catch(() => {});
  check('renaming the board renames its tab', (await page.locator('#ms-tabs .ms-tab-board').textContent()).includes('Hone list') && psql(`SELECT name FROM board WHERE board_id=${boardId}`) === 'Hone list');
  await page.evaluate(() => window.WriteSysTabs.activate(null));
  await page.waitForFunction(() => document.querySelector('#home-root .card-board'), null, { timeout: 15000 }).catch(() => {});
  await page.evaluate(() => window.WriteSysHome.reload());
  await page.waitForFunction((id) => !!document.querySelector(`#home-root .card-board[data-board-id="${id}"]`), boardId, { timeout: 15000 });
  const card = await page.evaluate((id) => { const c = document.querySelector(`#home-root .card-board[data-board-id="${id}"]`); return { title: c.querySelector('.card-title').textContent, meta: c.querySelector('.card-meta').textContent, chips: c.querySelectorAll('.card-board-rules .tag-chip').length }; }, boardId);
  check('landing card: name, rule chips, note count', card.title === 'Hone list' && /4 notes/.test(card.meta) && card.chips === 1, JSON.stringify(card));

  // ---- Delete from the board page closes the tab ----
  await page.evaluate((id) => window.WriteSysTabs.openBoard(id, 'Hone list'), parseInt(boardId, 10));
  await page.waitForSelector('#ms-tab-panels iframe[src*="view=board"].active', { timeout: 15000 });
  const f2 = page.frames().find((f) => f.url().includes('view=board'));
  await f2.waitForSelector('.board-delete', { timeout: 15000 });
  await f2.click('.board-delete');
  await page.waitForFunction(() => !document.querySelector('#ms-tabs .ms-tab-board'), null, { timeout: 10000 }).catch(() => {});
  check('Delete soft-deletes the board and closes its tab', psql(`SELECT deleted_at IS NOT NULL FROM board WHERE board_id=${boardId}`) === 't' && (await page.locator('#ms-tabs .ms-tab-board').count()) === 0);

  // ---- settings: the same editor, picker OFF ----
  await page.goto(new URL('settings.html', TEST_URL).href);
  await page.waitForSelector('#dr-editor .rules-builder .dim-type', { timeout: 20000 });
  check('settings: the shared editor renders the daily rules builder without a manuscript picker',
    (await page.locator('#dr-editor .rules-manuscripts').count()) === 0 && (await page.locator('#dr-editor .rules-builder .dr-add').count()) === 1);

  psql(`DELETE FROM daily_rule WHERE user_id='${TEST_USERNAME}'`);
  await page.evaluate(() => { try { localStorage.removeItem('ms_pinned_tabs'); localStorage.removeItem('ms_split'); sessionStorage.removeItem('ms_split_session'); } catch (e) {} });
  await browser.close();
  console.log(failed ? `\n❌ ${failed} check(s) failed` : '\n✅ Test passed');
  process.exit(failed ? 1 : 0);
})();
