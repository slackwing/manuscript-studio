// Feature test: shift-click range selection → red trash (two-click) → empty
// suggestions on every sentence in the range. Runs against the WORKTREE
// server on :5002.
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const {BASE_URL, TEST_URL, TEST_USERNAME, TEST_PASSWORD, loginAsTestUser, waitForPagination, paginationStamp} = require('./test-utils');
const BASE = BASE_URL;
const psql = (sql) => execSync(
  `PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`,
  { encoding: 'utf-8' }).trim();

(async () => {
  // Scoped to THIS worker's user — a blanket user_id='test' wipe nuked
  // worker 1's in-flight suggestions when this ran on another worker.
  psql(`DELETE FROM suggested_change WHERE user_id='${TEST_USERNAME}'`);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  let failed = false;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed = true; };

  // login via API
  await page.goto(`${BASE}/login.html`);
  await page.evaluate(([u, p]) => { window.__TEST_USER = u; window.__TEST_PASS = p; }, [TEST_USERNAME, TEST_PASSWORD]);
  await page.evaluate(async () => {
    const r = await fetch('api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'include', body: JSON.stringify({ username: window.__TEST_USER, password: window.__TEST_PASS }) });
    const d = await r.json();
    localStorage.setItem('csrf_token', d.csrf_token);
  });
  await page.goto(TEST_URL);
  await waitForPagination(page, 60000);
  // import zones rebuild synchronously after pagination — the plusHidden
  // check below needs them present
  await page.waitForSelector('.import-zone', { timeout: 15000 });

  // pick two prose sentences a few apart
  const pair = await page.evaluate(() => {
    const ids = window.WriteSysRenderer.currentSentences.map(s => s.sentence_id || s.id);
    const spans = [...document.querySelectorAll('.sentence[data-sentence-id]')]
      .filter(s => s.textContent.trim().length > 30 && !s.closest('h1,h2,h3'));
    const a = spans[2], b = spans[6];
    return { aId: a.dataset.sentenceId, bId: b.dataset.sentenceId,
             between: ids.slice(ids.indexOf(a.dataset.sentenceId), ids.indexOf(b.dataset.sentenceId) + 1) };
  });
  check('picked a range of sentences', pair.between.length >= 3, `${pair.between.length} sentences`);

  await page.locator(`.sentence[data-sentence-id="${pair.aId}"]`).first().click();
  // plain click sets the range anchor synchronously in the click handler
  await page.waitForFunction((id) => window.WriteSysRangeDelete && window.WriteSysRangeDelete.anchorId === id, pair.aId);
  await page.locator(`.sentence[data-sentence-id="${pair.bId}"]`).first().click({ modifiers: ['Shift'] });
  // select() highlights + appends both gutter buttons synchronously
  await page.waitForFunction(() =>
    document.body.classList.contains('range-delete-mode') &&
    document.querySelector('.range-trash.range-del') &&
    document.querySelector('.range-trash.range-sketch'));

  const mode = await page.evaluate(() => {
    let trashGeom = null;
    if (document.querySelector('.range-stack')) {
      const stEl = document.querySelector('.range-stack');
      const st = stEl.getBoundingClientRect();
      const selR = [...document.querySelectorAll('.sentence.range-selected')]
        .map((el) => ({ el, r: el.getBoundingClientRect() })).filter((x) => x.r.height > 0);
      const top = Math.min(...selR.map((x) => x.r.top));
      const bottom = Math.max(...selR.map((x) => x.r.bottom));
      const first = selR.find((x) => x.r.top === top).el;
      const sheet = first.closest('.pagedjs_sheet') || first.closest('.pagedjs_page');
      const sr = sheet.getBoundingClientRect();
      // The floating stack (2026-10-23) stays WITHIN the selection's vertical
      // extent (centered on it when the selection is shorter than the stack).
      const shortSel = bottom - top <= st.height;
      const placed = shortSel
        ? Math.abs((st.top + st.bottom) / 2 - (top + bottom) / 2) <= 8
        : st.top >= top - 1 && st.bottom <= bottom + 1;
      trashGeom = { rightVsSheet: Math.round(st.right - sr.left), placed }; // right < 0: fully in the gutter
    }
    return {
      selected: new Set([...document.querySelectorAll('.sentence.range-selected')].map(e => e.dataset.sentenceId)).size,
      modeOn: document.body.classList.contains('range-delete-mode'),
      trash: document.querySelectorAll('.range-trash.range-del').length,
      sketchBtn: document.querySelectorAll('.range-trash.range-sketch').length,
      plusHidden: [...document.querySelectorAll('.import-zone')].every(z => getComputedStyle(z).display === 'none'),
      nativeSelection: String(window.getSelection() || ''),
      trashGeom,
    };
  });
  check('range highlighted', mode.selected === pair.between.length, `${mode.selected}/${pair.between.length}`);
  check('mode on + red trash shown (sketch button beside it)', mode.modeOn && mode.trash === 1 && mode.sketchBtn === 1);
  check('+ affordances hidden in mode', mode.plusHidden);
  check('NO native text selection after shift-click', mode.nativeSelection === '', mode.nativeSelection.slice(0, 40));
  check('button stack fully off the sheet, in the gutter', mode.trashGeom && mode.trashGeom.rightVsSheet < 0, JSON.stringify(mode.trashGeom));
  check('button stack sits within the selection (centered when it is short)', mode.trashGeom && mode.trashGeom.placed, JSON.stringify(mode.trashGeom));

  // first click arms, second applies
  await page.locator('.range-trash.range-del').click();
  const arming = await page.evaluate(() => document.querySelector('.range-trash.range-del').classList.contains('confirming'));
  check('first click arms (confirming)', arming);
  const before = psql(`SELECT COUNT(*) FROM suggested_change WHERE user_id='${TEST_USERNAME}'`);
  check('no suggestions before confirm', before === '0', before);
  const stamp = await paginationStamp(page);
  await page.locator('.range-trash.range-del').click();
  // apply() PUTs the suggestions then re-renders: wait for the NEW pagination
  // pass AND the old pages to be swapped out (suggested-delete marks live in
  // the fresh DOM). Timeout falls through so the checks below report the
  // actual failure.
  await page.waitForFunction((prev) =>
    (document.body.dataset.paginated || '0') !== prev &&
    document.querySelectorAll('.pagedjs_pages').length === 1 &&
    document.querySelector('.sentence.suggested-delete'),
    stamp, { timeout: 20000 }).catch(() => {});

  const rows = psql(`SELECT COUNT(*) FROM suggested_change WHERE user_id='${TEST_USERNAME}' AND text=''`);
  check('EMPTY suggestion on every sentence in range', rows === String(pair.between.length), `rows=${rows}`);
  const modeOff = await page.evaluate(() => !document.body.classList.contains('range-delete-mode') && !document.querySelector('.range-trash'));
  check('mode exits after apply', modeOff);
  // deleted sentences vanish from the effective preview
  const gone = await page.evaluate((ids) => {
    return ids.map((id) => {
      const el = document.querySelector(`.sentence[data-sentence-id="${id}"]`);
      if (!el) return { id, present: false };
      const cs = getComputedStyle(el);
      return { id, present: true, struck: el.classList.contains('suggested-delete') && cs.textDecorationLine.includes('line-through'), hasText: el.textContent.trim().length > 0 };
    });
  }, pair.between);
  check('range sentences STILL RENDER (deletion is a proposal, not applied)', gone.every(g => g.present && g.hasText), gone.filter(g => !g.present).map(g => g.id));
  check('every range sentence shows red strikethrough', gone.every(g => g.struck));

  // Escape exits a fresh selection without applying
  await page.evaluate(() => window.WriteSysRenderer.scrollToSentence && null);
  psql(`DELETE FROM suggested_change WHERE user_id='${TEST_USERNAME}'`);
  console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS');
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('Test crashed:', e); process.exit(1); });
