// Session guard (session-guard.js): when the session expires mid-work, the
// app dims and offers an IN-PLACE re-login modal — no reload, unsaved work
// survives. Checks, inside an open scratchpad:
//   1. an expired session makes the autosave fail and AUTO-OPENS the modal
//      (any api/ 401 trips the fetch patch);
//   2. the save-failure status carries a "Session expired — log in" link;
//   3. logging in through the modal restores the session (fresh CSRF), the
//      pending save flushes immediately (ms:session-restored), and the pad
//      then closes cleanly.
const { chromium } = require('playwright');
const { TEST_URL, loginAsTestUser } = require('./test-utils');
const HOME_URL = new URL('home.html', TEST_URL).href;

const USERNAME = process.env.MS_TEST_WORKER && process.env.MS_TEST_WORKER !== '1'
  ? `test${process.env.MS_TEST_WORKER}` : 'test';

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const page = await context.newPage();
  page.on('dialog', d => d.accept());
  let failed = false;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed = true; };

  await loginAsTestUser(page);
  await page.goto(HOME_URL);
  await page.waitForSelector('#home-new-pad'); await page.click('#home-new-pad');
  await page.waitForSelector('.spm-overlay .ProseMirror');

  const pm = page.locator('.spm-editor .ProseMirror');
  await pm.click();
  await page.keyboard.type('words that must survive the expiry ');
  await page.waitForTimeout(1600); // first autosave lands
  const saved1 = await page.locator('#spm-status').textContent();
  check('initial autosave succeeds', saved1 === 'Saved', JSON.stringify(saved1));

  // Expire the session: drop the cookie client-side (equivalent to a
  // server-side expiry as far as requests are concerned — 401s follow).
  await context.clearCookies();
  await page.keyboard.type('typed after expiry ');
  // Autosave (1.2s debounce) fails → guard modal should auto-open.
  await page.waitForSelector('.msg-overlay', { timeout: 8000 });
  check('re-login modal auto-opens on save 401', true);

  const dimmed = await page.evaluate(() => {
    const o = document.querySelector('.msg-overlay');
    return o && getComputedStyle(o).position === 'fixed' && o.querySelector('#msg-pass') != null;
  });
  check('modal dims the app and has a password field', !!dimmed);

  // The status line should offer the re-login link (retry ladder + 401).
  await page.waitForTimeout(500);
  const statusHTML = await page.evaluate(() => document.querySelector('#spm-status').textContent);
  check('save status shows session-expired link', /log in/i.test(statusHTML), JSON.stringify(statusHTML));

  // Log back in through the modal.
  await page.fill('#msg-user', USERNAME);
  await page.fill('#msg-pass', 'test');
  await page.click('.msg-login');
  await page.waitForSelector('.msg-overlay', { state: 'detached', timeout: 8000 });
  check('modal closes after successful login', true);

  // ms:session-restored flushes the pending save immediately (no backoff wait).
  await page.waitForFunction(
    () => document.querySelector('#spm-status').textContent === 'Saved',
    { timeout: 8000 },
  );
  check('pending save flushes right after re-login', true);

  // The doc content survived the whole affair.
  const text = await page.evaluate(() => window.WriteSysScratchpad.view.state.doc.textContent);
  check('typed text survived (no reload)', text.includes('words that must survive the expiry')
    && text.includes('typed after expiry'), JSON.stringify(text.slice(0, 80)));

  // And the pad closes cleanly now that saves work again.
  await page.click('#spm-close');
  await page.waitForSelector('.spm-overlay', { state: 'detached', timeout: 8000 });
  check('pad closes cleanly after re-login', true);

  // Dismissing the modal ("not now") must also work: expire again, trip it,
  // dismiss, and confirm the link can re-open it.
  await page.click('#home-new-pad');
  await page.waitForSelector('.spm-overlay .ProseMirror');
  await page.locator('.spm-editor .ProseMirror').click();
  await page.keyboard.type('second pad ');
  await page.waitForTimeout(1600);
  await context.clearCookies();
  await page.keyboard.type('more ');
  await page.waitForSelector('.msg-overlay', { timeout: 8000 });
  await page.click('.msg-dismiss');
  await page.waitForSelector('.msg-overlay', { state: 'detached' });
  check('modal is dismissible (not now)', true);
  // Wait for the retry ladder to fail again and render the link, then use it.
  await page.waitForFunction(
    () => /log in/i.test(document.querySelector('#spm-status').textContent),
    { timeout: 15000 },
  );
  await page.locator('#spm-status a').click();
  await page.waitForSelector('.msg-overlay', { timeout: 4000 });
  check('status link re-opens the modal', true);
  await page.fill('#msg-pass', 'test');
  await page.click('.msg-login');
  await page.waitForSelector('.msg-overlay', { state: 'detached', timeout: 8000 });
  await page.waitForFunction(
    () => document.querySelector('#spm-status').textContent === 'Saved',
    { timeout: 10000 },
  );
  check('second recovery also saves', true);
  await page.click('#spm-close');
  await page.waitForSelector('.spm-overlay', { state: 'detached', timeout: 8000 });

  // 4. The LANDING PAGE recovers after an in-place re-login: its data
  //    fetches had 401'd, and home.js must reload them on
  //    ms:session-restored (this exact case once required a manual
  //    refresh).
  await context.clearCookies();
  await page.evaluate(() => window.dispatchEvent(new Event('scratchpad-modal-closed'))); // forces a home reload → 401
  await page.waitForSelector('.msg-overlay', { timeout: 8000 });
  check('home: expired reload trips the re-login modal', true);
  const brokeFirst = await page.evaluate(() => (document.getElementById('home-root') || {}).textContent || '');
  await page.fill('#msg-user', USERNAME);
  await page.fill('#msg-pass', 'test');
  await page.click('.msg-login');
  await page.waitForSelector('.msg-overlay', { state: 'detached', timeout: 8000 });
  await page.waitForFunction(() => {
    const t = (document.getElementById('home-root') || {}).textContent || '';
    return t && !/Failed to load/.test(t);
  }, { timeout: 10000 });
  check('home re-renders after modal login (no manual refresh)', true, `was: ${brokeFirst.slice(0, 40)}`);

  console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS');
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('Test crashed:', e); process.exit(1); });
