// Phone suggest-edit: the BOOK stays put while the modal is open, and an
// edit lands you back on your sentence (2026-11-23). Before: the overlay
// column rarely overflowed, so a flick inside it scrolled the page behind
// it (and iOS scrolls the document to reveal a focused textarea); close()
// then re-rendered around the sentence's drifted viewport offset — "I keep
// getting sent to some anchor way above the sentence I was editing".
// Now: openModal pins the body (body.sgm-page-locked, fixed at -scrollY)
// while the phone layout is up and restores the scroll before the
// re-render measures its anchor. Desktop never locks. The ‹ › tour scrolls
// instantly on a phone so the next modal pins the page where the edit is.
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const { TEST_URL, TEST_USERNAME, loginAsTestUser, waitForPagination, suggestEditor } = require('./test-utils');
const psql = (sql) => execSync(
  `PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`,
  { encoding: 'utf-8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MARK = ` [mobile-scroll ${TEST_USERNAME}]`;

(async () => {
  const browser = await chromium.launch();
  let failed = false;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed = true; };
  const cleanup = () => psql(`DELETE FROM suggested_change WHERE user_id='${TEST_USERNAME}' AND text LIKE '%${MARK}%'`);
  cleanup();

  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  if (process.env.MS_DEBUG) page.on('console', (m) => console.log('   [console]', m.text().slice(0, 180)));
  await loginAsTestUser(page);
  await page.goto(TEST_URL);
  await waitForPagination(page);

  // A sentence deep in the book, scrolled into view the way a reader would.
  const ids = await page.evaluate(() => [...new Set([...document.querySelectorAll('.pagedjs_pages .sentence[data-sentence-id]')].map((s) => s.dataset.sentenceId))]);
  const sidA = ids[Math.min(300, ids.length - 2)];
  const sidB = ids[Math.min(330, ids.length - 1)];
  const spanA = page.locator(`.pagedjs_pages .sentence[data-sentence-id="${sidA}"]`).first();
  const posOf = (sid) => page.evaluate((id) => {
    const el = document.querySelector(`.pagedjs_pages .sentence[data-sentence-id="${id}"]`);
    return { y: Math.round(window.scrollY), top: el ? Math.round(el.getBoundingClientRect().top) : null,
      locked: document.body.classList.contains('sgm-page-locked'), paginated: document.body.dataset.paginated };
  }, sid);
  await spanA.scrollIntoViewIfNeeded();
  await page.waitForFunction(() => !!document.querySelector('.pagedjs_pages .sentence'));
  const start = await posOf(sidA);
  check('starting deep in the book, unlocked', start.y > 2000 && !start.locked, JSON.stringify(start));

  // ---- open: the page pins ----
  await spanA.dblclick();
  await page.waitForSelector('#suggestion-modal .sgm-fmt-left', { state: 'visible', timeout: 8000 });
  const open = await posOf(sidA);
  check('phone modal pins the book (body.sgm-page-locked)', open.locked, JSON.stringify(open));

  // ---- the two drifts that used to leak through ----
  await page.mouse.move(195, 420);
  await page.mouse.wheel(0, 4000);                  // a flick inside the modal
  await page.evaluate(() => window.scrollTo(0, 0)); // iOS revealing the focused textarea
  await sleep(300);
  const ov = await page.evaluate(() => getComputedStyle(document.getElementById('suggestion-modal-overlay')).overscrollBehaviorY);
  check('overlay refuses to chain scroll to the page (overscroll-behavior: contain)', ov === 'contain', ov);

  // ---- edit + autosave, then close by tapping the backdrop ----
  const ta = await suggestEditor(page);
  await ta.press('End');
  await ta.type(MARK);
  let saved = false;
  for (let i = 0; i < 60 && !saved; i++) { await sleep(100); saved = psql(`SELECT count(*) FROM suggested_change WHERE sentence_id='${sidA}' AND user_id='${TEST_USERNAME}' AND text LIKE '%${MARK}%'`) === '1'; }
  check('edit autosaved', saved);
  const pagBefore = await page.evaluate(() => document.body.dataset.paginated);
  await page.evaluate(() => document.getElementById('suggestion-modal-overlay').click());
  // iOS puts back the scroll it remembered when the keyboard opened — 0
  // under the pin — on blur: the instant the modal is gone (mid-render)…
  await page.waitForSelector('#suggestion-modal', { state: 'detached', timeout: 20000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForFunction((p) => !document.getElementById('suggestion-modal') && document.body.dataset.paginated !== p, pagBefore, { timeout: 60000 });
  await page.waitForFunction((id) => !!document.querySelector(`.pagedjs_pages .sentence.selected[data-sentence-id="${id}"]`), sidA);
  // …and again once the render has already landed (a short book).
  await sleep(120);
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(700);
  const after = await posOf(sidA);
  check('page unpinned after close', !after.locked, JSON.stringify(after));
  check('scroll is back where the modal opened', Math.abs(after.y - start.y) <= 2, `${start.y} → ${after.y}`);
  check('the edited sentence sits where it was', after.top !== null && Math.abs(after.top - start.top) <= 3, `${start.top} → ${after.top}`);
  check('…and is on screen', after.top > 0 && after.top < 844, String(after.top));

  // ---- a close with NO change (nothing to re-render) holds the spot too ----
  // (The sentence is already selected, so one tap opens; a dblclick's second
  // click would land on the backdrop and close it again.)
  await spanA.click();
  await page.waitForSelector('#suggestion-modal .sgm-fmt-left', { state: 'visible', timeout: 8000 });
  await page.evaluate(() => document.getElementById('suggestion-modal-overlay').click());
  await page.waitForSelector('#suggestion-modal', { state: 'detached', timeout: 20000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(700);
  const noop = await posOf(sidA);
  check('no-change close: the sentence is held where it was, despite the phone\'s stray scroll', Math.abs(noop.top - start.top) <= 3 && !noop.locked, `${start.top} → ${noop.top}`);

  // ---- the ‹ › tour on a phone: the next modal pins the page ON its edit ----
  // A second suggested edit further down, then flip to it from A.
  const csrf = await page.evaluate(() => sessionStorage.getItem('csrf_token') || localStorage.getItem('csrf_token'));
  const textB = await page.evaluate((id) => window.WriteSysRenderer.sentenceMap[id], sidB);
  const put = await page.request.put(new URL(`api/sentences/${encodeURIComponent(sidB)}/suggestion`, TEST_URL).href,
    { headers: { 'X-CSRF-Token': csrf || '' }, data: { text: textB + MARK } });
  check('seeded a second suggested edit (B)', put.ok(), String(put.status()));
  // A plain load: close() stamped ?scroll_to=A, and a reload would restore
  // THAT selection — the double-click's first tap would then be a re-click
  // that opens the modal and its second tap the backdrop that closes it.
  await page.goto(TEST_URL);
  await waitForPagination(page);
  await spanA.scrollIntoViewIfNeeded();
  await spanA.dblclick();
  await page.waitForSelector('#suggestion-modal', { timeout: 8000 });
  // The tour's next stop is whatever carries a suggestion after A in book
  // order (B, unless the fixture holds others in between) — ask the same
  // list the tour uses.
  const next = await page.evaluate((a) => { const l = window.WriteSysSuggestions.suggestedOrder(); return l[(l.indexOf(a) + 1) % l.length]; }, sidA);
  check('tour has a next stop after A', !!next && next !== sidA, String(next));
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction((id) => {
    const ta = document.querySelector('#suggestion-modal .suggestion-modal-textarea');
    const base = window.WriteSysRenderer.sentenceMap[id] || '';
    return !!ta && (ta.value.startsWith(base.slice(0, 20)) || base.startsWith(ta.value.slice(0, 20)));
  }, next, { timeout: 10000 });
  const tourOpen = await posOf(next);
  check('tour: the next modal pins the page WITH its sentence on screen', tourOpen.locked && tourOpen.top !== null && tourOpen.top >= 0 && tourOpen.top < 844, JSON.stringify(tourOpen));
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.getElementById('suggestion-modal'));
  const tourClosed = await posOf(next);
  check('tour: after closing, that sentence is still on screen', tourClosed.top !== null && tourClosed.top >= 0 && tourClosed.top < 844 && !tourClosed.locked, JSON.stringify(tourClosed));

  // ---- desktop control: no lock ----
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.reload();
  await waitForPagination(page);
  await spanA.scrollIntoViewIfNeeded();
  await spanA.dblclick();
  await page.waitForSelector('#suggestion-modal', { timeout: 8000 });
  check('desktop modal leaves the page unlocked', !(await posOf(sidA)).locked);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.getElementById('suggestion-modal'));

  cleanup();
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
