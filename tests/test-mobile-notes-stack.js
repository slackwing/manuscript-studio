// MOBILE notes (the margin is hidden ≤1239px): double-tapping a sentence
// opens the suggest-edit modal pinned to the TOP, with the sentence's notes
// floating BELOW it as cards on the same dark backdrop (#sgm-notes-stack).
// Clicking the backdrop closes modal + stack together. Desktop is untouched
// (the stack is never built above the breakpoint).
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const { TEST_URL, TEST_USERNAME, loginAsTestUser, waitForPagination } = require('./test-utils');
const psql = (sql) => execSync(
  `PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`,
  { encoding: 'utf-8' }).trim();
const BODY = `Mobile stack note (${TEST_USERNAME})`;

(async () => {
  const browser = await chromium.launch();
  let failed = false;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed = true; };

  psql(`DELETE FROM note WHERE user_id='${TEST_USERNAME}' AND body='${BODY}'`);

  // ---- phone viewport: modal at top, notes float below ----
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await loginAsTestUser(page);
  await page.goto(TEST_URL);
  await waitForPagination(page);
  const sid = await page.evaluate(() => document.querySelectorAll('.sentence[data-sentence-id]')[2].dataset.sentenceId);
  psql(`INSERT INTO note (sentence_id, user_id, color, body, position) VALUES ('${sid}', '${TEST_USERNAME}', 'yellow', '${BODY}', 'a0')`);
  await page.reload();
  await waitForPagination(page);
  // notes preload with the manuscript — wait until the cache has ours
  await page.waitForFunction((b) =>
    (window.WriteSysRenderer && window.WriteSysRenderer.currentNotes || []).some(n => n.body === b),
    BODY, { timeout: 15000 });

  await page.locator(`.sentence[data-sentence-id="${sid}"]`).first().dblclick();
  await page.waitForSelector('#suggestion-modal', { timeout: 8000 });
  await page.waitForSelector('#sgm-notes-stack .sticky-note', { timeout: 8000 });
  const geo = await page.evaluate((b) => {
    const m = document.getElementById('suggestion-modal').getBoundingClientRect();
    const s = document.getElementById('sgm-notes-stack');
    const sr = s.getBoundingClientRect();
    const note = s.querySelector('.sticky-note');
    return {
      modalTop: m.top, gap: sr.top - m.bottom,
      noteShown: !!note && ((note.querySelector('.note-input') || {}).value || note.textContent).includes(b),
      closeBtn: !!document.querySelector('.sgm-close'),
      overlayDark: getComputedStyle(document.getElementById('suggestion-modal-overlay')).backgroundColor,
    };
  }, BODY);
  check('modal pinned near the top on mobile', geo.modalTop <= 20, `top=${geo.modalTop}`);
  check('note card floats BELOW the modal (dark gap between)', geo.gap >= 6, `gap=${geo.gap}`);
  check('the card is the sentence note', geo.noteShown);
  check('no × close button', !geo.closeBtn);
  check('dark backdrop present', /0\.35|0, 0, 0/.test(geo.overlayDark), geo.overlayDark);

  // Backdrop click closes BOTH
  await page.mouse.click(195, 830);
  await page.waitForSelector('#suggestion-modal', { state: 'detached', timeout: 8000 });
  check('backdrop click closes modal + stack',
    (await page.locator('#sgm-notes-stack').count()) === 0);
  await page.close();

  // ---- desktop viewport: no stack, margin untouched ----
  const desk = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await loginAsTestUser(desk);
  await desk.goto(TEST_URL);
  await waitForPagination(desk);
  await desk.waitForFunction((b) =>
    (window.WriteSysRenderer && window.WriteSysRenderer.currentNotes || []).some(n => n.body === b),
    BODY, { timeout: 15000 });
  await desk.locator(`.sentence[data-sentence-id="${sid}"]`).first().dblclick();
  await desk.waitForSelector('#suggestion-modal', { timeout: 8000 });
  check('desktop: NO floating stack (margin owns notes)',
    (await desk.locator('#sgm-notes-stack').count()) === 0);
  await desk.locator('.suggestion-modal-textarea').press('Escape');
  await desk.waitForSelector('#suggestion-modal', { state: 'detached', timeout: 8000 });

  psql(`DELETE FROM note WHERE user_id='${TEST_USERNAME}' AND body='${BODY}'`);
  console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS');
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('Test crashed:', e); process.exit(1); });
