// Feature test: shift-click range selection → red trash (two-click) → empty
// suggestions on every sentence in the range. Runs against the WORKTREE
// server on :5002.
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const {BASE_URL, TEST_URL, TEST_USERNAME, TEST_PASSWORD, loginAsTestUser} = require('./test-utils');
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
  await page.waitForSelector('.sentence[data-sentence-id]', { timeout: 60000 });
  await page.waitForTimeout(4000);

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
  await page.waitForTimeout(300);
  await page.locator(`.sentence[data-sentence-id="${pair.bId}"]`).first().click({ modifiers: ['Shift'] });
  await page.waitForTimeout(400);

  const mode = await page.evaluate(() => {
    const trashEl = document.querySelector('.range-trash');
    let trashGeom = null;
    if (trashEl) {
      const tr = trashEl.getBoundingClientRect();
      const sheet = trashEl.closest('.pagedjs_sheet') || trashEl.closest('.pagedjs_page');
      const sr = sheet.getBoundingClientRect();
      const sel = [...document.querySelectorAll('.sentence.range-selected')]
        .filter((el) => (el.closest('.pagedjs_sheet') || el.closest('.pagedjs_page')) === sheet)
        .map((el) => el.getBoundingClientRect()).filter((r) => r.height > 0);
      const top = Math.min(...sel.map((r) => r.top));
      const bottom = Math.max(...sel.map((r) => r.bottom));
      trashGeom = {
        rightVsSheet: Math.round(tr.right - sr.left),          // < 0: fully in the gutter
        centerOffset: Math.round((tr.top + tr.bottom) / 2 - (top + bottom) / 2), // ≈ 0: centered on range
      };
    }
    return {
      selected: new Set([...document.querySelectorAll('.sentence.range-selected')].map(e => e.dataset.sentenceId)).size,
      modeOn: document.body.classList.contains('range-delete-mode'),
      trash: document.querySelectorAll('.range-trash:not(.range-sketch)').length,
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
  check('trash fully off the sheet, in the gutter', mode.trashGeom && mode.trashGeom.rightVsSheet < 0, mode.trashGeom);
  check('trash vertically centered on the range (±8px)', mode.trashGeom && Math.abs(mode.trashGeom.centerOffset) <= 8, mode.trashGeom);

  // first click arms, second applies
  await page.locator('.range-trash:not(.range-sketch)').click();
  const arming = await page.evaluate(() => document.querySelector('.range-trash:not(.range-sketch)').classList.contains('confirming'));
  check('first click arms (confirming)', arming);
  const before = psql(`SELECT COUNT(*) FROM suggested_change WHERE user_id='${TEST_USERNAME}'`);
  check('no suggestions before confirm', before === '0', before);
  await page.locator('.range-trash:not(.range-sketch)').click();
  await page.waitForTimeout(2500);

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
