// Where you are (2026-11-25): clicking a sentence stamps #at=<id> on the
// book page, remembers it per manuscript in localStorage, and puts
// #tab=m1&at=<id> on the tabbed shell; a refresh (standalone or in the
// shell) scrolls back to the sentence and reselects it. An explicit
// ?scroll_to= still wins; a #note-sentence= deep link owns the scroll.
const { chromium } = require('playwright');
const { TEST_URL, TEST_MANUSCRIPT_ID, loginAsTestUser, waitForPagination } = require('./test-utils');
const HOME_URL = new URL('home.html', TEST_URL).href;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('=== remember where you are (#at=) ===\n');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  let failed = 0;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed++; };
  const posOf = (p, sid) => p.evaluate((id) => {
    const el = document.querySelector(`.pagedjs_pages .sentence[data-sentence-id="${id}"]`);
    const r = el && el.getBoundingClientRect();
    return { y: Math.round(window.scrollY), top: r ? Math.round(r.top) : null, onScreen: !!r && r.top >= 0 && r.bottom <= innerHeight, selected: !!el && el.classList.contains('selected'), flashed: !!el && el.classList.contains('flash-highlight'), hash: location.hash };
  }, sid);
  // The restore polls for the sentence after pagination — wait for it to be
  // on screen with the page scrolled (it flashes; it is NOT selected).
  const waitRestored = (p, sid, selected = false) => p.waitForFunction(({ id, sel }) => { const el = document.querySelector(`.pagedjs_pages .sentence[data-sentence-id="${id}"]`); if (!el) return false; const r = el.getBoundingClientRect(); return (sel ? el.classList.contains('selected') : r.top >= 0 && r.bottom <= innerHeight) && window.scrollY > 100; }, { id: sid, sel: selected }, { timeout: 30000 }).catch(() => {});

  await loginAsTestUser(page);
  await page.evaluate(() => { try { localStorage.removeItem('ms_pinned_tabs'); localStorage.removeItem('ms_split'); } catch (e) {} });

  // ---- standalone book page ----
  await page.goto(TEST_URL);
  await waitForPagination(page);
  await page.evaluate((id) => localStorage.removeItem('ms_at:' + id), TEST_MANUSCRIPT_ID);
  const ids = await page.evaluate(() => [...new Set([...document.querySelectorAll('.pagedjs_pages p .sentence[data-sentence-id]')].map((s) => s.dataset.sentenceId))]);
  const sid = ids[Math.floor(ids.length * 0.7)];
  const span = page.locator(`.pagedjs_pages .sentence[data-sentence-id="${sid}"]`).first();
  await span.scrollIntoViewIfNeeded();
  await span.click();
  await sleep(200);
  const stamped = await page.evaluate((id) => ({ hash: location.hash, stored: localStorage.getItem('ms_at:' + id), scrollTo: new URLSearchParams(location.search).get('scroll_to') }), TEST_MANUSCRIPT_ID);
  check('a click stamps #at=<id> and remembers it for the manuscript', stamped.hash === '#at=' + sid && stamped.stored === sid && !stamped.scrollTo, JSON.stringify(stamped));

  await page.reload();
  await waitForPagination(page);
  await waitRestored(page, sid);
  const back = await posOf(page, sid);
  check('refresh: back on the sentence — on screen, flashed, NOT selected (a click still selects)', !back.selected && back.onScreen && back.y > 100, JSON.stringify(back));
  await page.locator(`.pagedjs_pages .sentence[data-sentence-id="${sid}"]`).first().click();
  await sleep(400);
  const clicked = await page.evaluate((id) => ({ selected: !!document.querySelector(`.pagedjs_pages .sentence.selected[data-sentence-id="${id}"]`), modal: !!document.getElementById('suggestion-modal'), margin: !!document.querySelector('#sticky-notes-container .sticky-note') }), sid);
  check('a click after the restore selects it and shows the margin, not the editor', clicked.selected && !clicked.modal && clicked.margin, JSON.stringify(clicked));

  // Memory alone (no hash): opening the book plain lands on the remembered spot.
  await page.goto(TEST_URL);
  await waitForPagination(page);
  await waitRestored(page, sid);
  const plain = await posOf(page, sid);
  check('opening the book with no hash lands on the remembered sentence', plain.onScreen && !plain.selected, JSON.stringify(plain));

  // ?scroll_to= wins over the memory.
  const other = ids[Math.floor(ids.length * 0.3)];
  await page.goto(TEST_URL + '&scroll_to=' + other);
  await waitForPagination(page);
  await waitRestored(page, other, true);
  check('?scroll_to= still wins over the memory (and selects, as a post-edit reload should)', (await posOf(page, other)).selected && !(await posOf(page, sid)).selected);

  // ---- the tabbed shell: the panel reports up; the shell's hash carries it; a refresh restores ----
  await page.goto(HOME_URL);
  await page.waitForSelector('#ms-tabs, .card-ghost', { timeout: 20000 });
  await page.evaluate((id) => window.WriteSysTabs.openManuscript(id, 'Test'), TEST_MANUSCRIPT_ID);
  await page.waitForSelector(`#ms-tab-panels iframe[src*="manuscript_id=${TEST_MANUSCRIPT_ID}"].active`, { timeout: 15000 });
  let frame = page.frames().find((f) => f.url().includes('manuscript_id=' + TEST_MANUSCRIPT_ID));
  await frame.waitForFunction(() => document.querySelectorAll('.pagedjs_page').length > 0, null, { timeout: 60000 });
  await waitRestored(frame, sid); // the memory lands it on sid first
  const fsid = ids[Math.floor(ids.length * 0.5)];
  // Let the panel's pagination settle (the book paginates again as its
  // session data lands; a click between two passes is re-rendered away).
  const settled = async (f) => { let last = null; for (let i = 0; i < 60; i++) { const v = await f.evaluate(() => document.body.dataset.paginated); if (v === last) { await sleep(700); if ((await f.evaluate(() => document.body.dataset.paginated)) === v) return; } last = v; await sleep(300); } };
  await settled(frame);
  // (Playwright's pointer does not land inside these panel iframes — click
  // the span from within the frame; the renderer's handler is the same.)
  const panelClick = await frame.evaluate((id) => {
    const el = document.querySelector(`.pagedjs_pages .sentence[data-sentence-id="${id}"]`);
    if (!el) return { missing: true };
    el.scrollIntoView({ block: 'center' }); el.click();
    return { sel: window.WriteSysRenderer.currentSelectedSentenceId, hash: location.hash, paginated: document.body.dataset.paginated };
  }, fsid);
  await sleep(300);
  const shellHash = await page.evaluate(() => location.hash);
  check('shell: a click in the panel puts #tab=m<id>&at=<sid> on the shell URL', shellHash === `#tab=m${TEST_MANUSCRIPT_ID}&at=${fsid}`, `${shellHash} ${JSON.stringify(panelClick)}`);

  await page.reload();
  await page.waitForSelector(`#ms-tab-panels iframe[src*="manuscript_id=${TEST_MANUSCRIPT_ID}"].active`, { timeout: 20000 });
  frame = page.frames().find((f) => f.url().includes('manuscript_id=' + TEST_MANUSCRIPT_ID));
  check('shell refresh: the panel loads with the spot in its own hash', /#at=/.test(frame.url()), frame.url().slice(-40));
  await frame.waitForFunction(() => document.querySelectorAll('.pagedjs_page').length > 0, null, { timeout: 60000 });
  await waitRestored(frame, fsid);
  const fback = await posOf(frame, fsid);
  check('shell refresh: back on that sentence, on screen', fback.onScreen && fback.y > 100, JSON.stringify(fback));
  check('shell URL still carries it after the reload', (await page.evaluate(() => location.hash)) === `#tab=m${TEST_MANUSCRIPT_ID}&at=${fsid}`);

  await page.evaluate((id) => { try { localStorage.removeItem('ms_pinned_tabs'); localStorage.removeItem('ms_split'); localStorage.removeItem('ms_at:' + id); sessionStorage.removeItem('ms_split_session'); } catch (e) {} }, TEST_MANUSCRIPT_ID);
  await browser.close();
  console.log(failed ? `\n❌ ${failed} check(s) failed` : '\n✅ Test passed');
  process.exit(failed ? 1 : 0);
})();
