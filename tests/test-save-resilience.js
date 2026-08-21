// "THIS SHOULD NEVER HAPPEN" — the two shields added after the 2026-08-01
// data loss (4 minutes of variation edits 403'd away by cross-tab CSRF skew):
//   1. CSRF SELF-HEAL: a re-login in another tab rotates the session cookie;
//      this tab's stored token goes stale → saves 403. The session guard now
//      resyncs the token from GET /api/session silently; the retry ladder's
//      next attempt succeeds. No user action, nothing lost.
//   2. LOCAL DRAFT NET: while saves fail, every keystroke mirrors to
//      localStorage; after a crash/reload the widget restores the draft and
//      pushes it up as soon as saves work.
const { chromium } = require('playwright');
const { TEST_URL, loginAsTestUser } = require('./test-utils');
const { execSync } = require('child_process');
const HOME_URL = new URL('home.html', TEST_URL).href;
const psql = (sql) => execSync(
  `PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`,
  { encoding: 'utf-8' }).trim();

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('dialog', d => d.accept());
  let failed = false;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed = true; };

  await loginAsTestUser(page);
  await page.goto(HOME_URL);
  await page.waitForSelector('.card-ghost[data-ghost="scratchpad"]'); await page.click('.card-ghost[data-ghost="scratchpad"]');
  await page.waitForSelector('.spm-overlay .ProseMirror');
  await page.locator('.spm-editor .ProseMirror').click();
  const variationId = await page.evaluate(async () => {
    const ctx = await window.WriteSysScratchpad.insertSketch();
    return ctx.variation.variation_id;
  });
  await page.waitForSelector('.sn-widget .sn-render');
  await page.locator('.sn-widget .sn-render').click();
  await page.waitForSelector('.sn-widget textarea');
  await page.keyboard.type('first line saves fine. ');
  await page.waitForTimeout(1500);
  check('baseline save landed', psql(`SELECT text FROM variation WHERE variation_id=${variationId}`).includes('first line'), '');

  // ---- 1. CSRF skew → silent self-heal ----
  await page.evaluate(() => localStorage.setItem('csrf_token', 'bogus-after-other-tab-relogin'));
  await page.keyboard.type('typed during csrf skew. ');
  // First save 403s; the guard heals the token from /api/session; the retry
  // ladder (2s) then succeeds. Give it up to 8s.
  let healed = false;
  for (let i = 0; i < 16 && !healed; i++) {
    await page.waitForTimeout(500);
    healed = psql(`SELECT text FROM variation WHERE variation_id=${variationId}`).includes('csrf skew');
  }
  check('CSRF skew self-heals — text saved with NO user action', healed);
  const tok = await page.evaluate(() => localStorage.getItem('csrf_token'));
  check('stored token was resynced from the session', tok !== 'bogus-after-other-tab-relogin');
  const status1 = await page.evaluate(() => document.querySelector('.sn-save').textContent);
  check('save status settled clean', status1 === '' || /restored/.test(status1), JSON.stringify(status1));

  // ---- 2. Draft net across a crash while saves fail ----
  await page.route('**/api/variations/*', (route) =>
    route.request().method() === 'PUT' ? route.abort() : route.continue());
  await page.locator('.sn-widget textarea').click();
  await page.keyboard.press('End');
  await page.keyboard.type('PRECIOUS unsaved words. ');
  await page.waitForTimeout(1200); // save fails, draft mirrored
  const errStatus = await page.evaluate(() => {
    const el = document.querySelector('.sn-save');
    return { text: el.textContent, loud: el.classList.contains('sn-save-err') };
  });
  check('failing save is LOUD (red status)', errStatus.loud && /Failed to save/.test(errStatus.text), JSON.stringify(errStatus));
  const draft = await page.evaluate((id) => localStorage.getItem(`ms-draft-variation-${id}`), variationId);
  check('draft mirrored to localStorage', !!draft && draft.includes('PRECIOUS'), '');

  // CRASH: reload the page with saves still broken, then let them work again.
  await page.unroute('**/api/variations/*');
  const padId = await page.evaluate(() => window.WriteSysScratchpad.scratchpadId);
  await page.reload();
  await page.waitForSelector('.card-ghost[data-ghost="scratchpad"]');
  await page.evaluate((id) => window.WriteSysScratchpadModal.open(id), padId);
  await page.waitForSelector('.sn-widget .sn-render', { timeout: 15000 });
  await page.waitForTimeout(500);
  await page.locator('.sn-widget .sn-render').click(); // enter edit → draft restore
  await page.waitForSelector('.sn-widget textarea');
  const restoredVal = await page.locator('.sn-widget textarea').inputValue();
  check('draft RESTORED into the editor after the crash', restoredVal.includes('PRECIOUS unsaved words'), JSON.stringify(restoredVal.slice(-40)));
  let pushed = false;
  for (let i = 0; i < 12 && !pushed; i++) {
    await page.waitForTimeout(500);
    pushed = psql(`SELECT text FROM variation WHERE variation_id=${variationId}`).includes('PRECIOUS unsaved words');
  }
  check('restored draft pushed to the server automatically', pushed);
  const draftAfter = await page.evaluate((id) => localStorage.getItem(`ms-draft-variation-${id}`), variationId);
  check('draft cleared after the successful save', !draftAfter, JSON.stringify(draftAfter));

  console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS');
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('Test crashed:', e); process.exit(1); });
