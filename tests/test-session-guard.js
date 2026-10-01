// Session guard (session-guard.js): when the session expires mid-work, the
// app dims and offers an IN-PLACE re-login modal — no reload, unsaved work
// survives. Checks, inside an open scratchpad:
//   1. an expired session makes the autosave fail and AUTO-OPENS the modal
//      (any api/ 401 trips the fetch patch);
//   2. the save-failure status carries a "Session expired — log in" link;
//   3. logging in through the modal restores the session (fresh CSRF), the
//      pending save flushes immediately (ms:session-restored), and the pad
//      then closes cleanly.
// Then, because an in-place re-login means no reload, each VIEW has to
// refresh its own 401'd data on ms:session-restored:
//   4. the landing page re-renders its cards;
//   5. the book page picks up work done elsewhere while it sat expired;
//   6. except under an OPEN suggestion editor, where that refresh defers to
//      the modal's close path rather than re-rendering out from under it.
// And in the tabbed shell, where every tab is an iframe:
//   7. an expiry seen inside a tab opens ONE modal over the WHOLE window
//      (tab bar included), not one inside the tab, and the login it takes
//      fires ms:session-restored inside the tab too.
const { chromium } = require('playwright');
const { TEST_URL, loginAsTestUser, waitForPagination, psql, suggestEditor } = require('./test-utils');
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
  await page.waitForSelector('.card-ghost[data-ghost="scratchpad"]'); await page.click('.card-ghost[data-ghost="scratchpad"]');
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
  await page.click('.card-ghost[data-ghost="scratchpad"]');
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

  // 5. The BOOK PAGE recovers after an in-place re-login (owner's report,
  //    2026-09-27): "I edited the manuscript on another device, came back to
  //    this one, the session had expired, I re-logged in — and the manuscript
  //    did not refresh to show the new suggestions until I manually
  //    refreshed."
  //
  //    Note the shape that matters. A session already dead when the page is
  //    OPENED just redirects to login.html and loads fresh — that path was
  //    never broken. The bug is a tab that was already open when the session
  //    died: the guard re-logs in place (by design, so unsaved work lives),
  //    and without a listener the book keeps rendering its pre-expiry data.
  await page.goto(TEST_URL);
  await waitForPagination(page);
  const sid = await page.evaluate(
    () => (document.querySelector('.sentence[data-sentence-id]') || {}).dataset?.sentenceId || '');
  check('book loaded a sentence to work with', !!sid, sid);

  // "Another device" adds a suggestion while this tab sits there.
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await loginAsTestUser(otherPage);
  await otherPage.goto(TEST_URL);
  await waitForPagination(otherPage);
  const ELSEWHERE = 'FROMOTHERDEVICE' + Date.now();
  const putStatus = await otherPage.evaluate(async ({ s, text }) => {
    const res = await authenticatedFetch(`api/sentences/${s}/suggestion`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    return res.status;
  }, { s: sid, text: ELSEWHERE + ' rest of the sentence.' });
  check('other device wrote a suggestion', putStatus >= 200 && putStatus < 300, `HTTP ${putStatus}`);
  await other.close();

  // This tab's session expires; any api call trips the guard.
  await context.clearCookies();
  await page.evaluate(() => fetch('api/session', { credentials: 'include' }));
  await page.waitForSelector('.msg-overlay', { timeout: 8000 });
  check('book: expiry trips the re-login modal', true);

  const staleBefore = await page.evaluate(() => document.body.textContent || '');
  check('book does NOT yet show the other device\'s text', !staleBefore.includes(ELSEWHERE));

  await page.fill('#msg-user', USERNAME);
  await page.fill('#msg-pass', 'test');
  await page.click('.msg-login');
  await page.waitForSelector('.msg-overlay', { state: 'detached', timeout: 8000 });

  // THE REGRESSION: without renderer.js's ms:session-restored listener this
  // never becomes true, and the owner has to hit reload.
  await page.waitForFunction(
    (mark) => (document.body.textContent || '').includes(mark),
    ELSEWHERE,
    { timeout: 20000 },
  ).catch(() => {});
  const sawElsewhere = await page.evaluate(() => document.body.textContent || '');
  check("book shows the other device's suggestion after re-login (no manual refresh)",
    sawElsewhere.includes(ELSEWHERE));

  psql(`DELETE FROM suggested_change WHERE user_id = '${USERNAME}'`);

  // 6. ...but NOT while a suggestion editor is open. Re-rendering the book
  //    would tear the modal's anchor out mid-edit, and a bare row refetch
  //    would race the editor's own restore-flush and cache the pre-edit text
  //    over the user's live words. So the refresh DEFERS to the close path.
  //    The editor autosaves, so its text is never the thing at risk.
  await page.goto(TEST_URL);
  await waitForPagination(page);
  const ids = await page.evaluate(
    () => [...new Set([...document.querySelectorAll('.sentence[data-sentence-id]')]
      .map(e => e.dataset.sentenceId))]);
  const mineSid = ids[0];
  const theirSid = ids[1];

  const other2 = await browser.newContext();
  const otherPage2 = await other2.newPage();
  await loginAsTestUser(otherPage2);
  await otherPage2.goto(TEST_URL);
  await waitForPagination(otherPage2);
  const ELSEWHERE2 = 'OTHERDEV' + Date.now();
  await otherPage2.evaluate(async ({ s, text }) => {
    await authenticatedFetch(`api/sentences/${s}/suggestion`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  }, { s: theirSid, text: ELSEWHERE2 + ' their sentence.' });
  await other2.close();

  // Open MY editor and type, then expire mid-edit.
  await page.evaluate((s) => window.WriteSysSuggestions.openModal(s), mineSid);
  await page.waitForSelector('#suggestion-modal', { timeout: 8000 });
  const ta = await suggestEditor(page);
  const MINE = 'MYEDIT' + Date.now();
  await ta.fill(MINE + ' my edited sentence.');
  await page.waitForTimeout(400);

  await context.clearCookies();
  await page.evaluate(() => fetch('api/session', { credentials: 'include' }));
  await page.waitForSelector('.msg-overlay', { timeout: 10000 });
  await page.fill('#msg-user', USERNAME);
  await page.fill('#msg-pass', 'test');
  await page.click('.msg-login');
  await page.waitForSelector('.msg-overlay', { state: 'detached', timeout: 8000 });
  // The refresh must have DEFERRED rather than run: wait on the flag the
  // renderer sets for the close path, not on a clock.
  await page.waitForFunction(
    () => !!(window.WriteSysRenderer && window.WriteSysRenderer._refreshWhenEditorCloses),
    null,
    { timeout: 10000 },
  );
  check('post-relogin refresh deferred instead of re-rendering', true);

  check('editor survives the re-login', await page.locator('#suggestion-modal').count() === 1);
  const still = await page.locator('.suggestion-modal-textarea').inputValue().catch(() => '');
  check('typed text intact through the re-login', still.includes(MINE));
  const duringEdit = await page.evaluate(() => document.body.textContent || '');
  check('book does NOT re-render under the open editor', !duringEdit.includes(ELSEWHERE2));

  // Closing runs the deferred refresh: their work arrives, mine survives.
  await page.keyboard.press('Escape');
  await page.waitForSelector('#suggestion-modal', { state: 'detached', timeout: 15000 }).catch(() => {});
  await page.waitForFunction(
    (m) => (document.body.textContent || '').includes(m),
    ELSEWHERE2,
    { timeout: 25000 },
  ).catch(() => {});
  const afterClose = await page.evaluate(() => document.body.textContent || '');
  check('closing the editor runs the deferred refresh', afterClose.includes(ELSEWHERE2));
  check('the user\'s own edit survived that refresh', afterClose.includes(MINE));

  psql(`DELETE FROM suggested_change WHERE user_id = '${USERNAME}'`);

  // 7. The modal belongs to the WINDOW, not the tab (owner's report,
  //    2026-10-01: "the session expired modal appears only over my
  //    manuscript tab"). Tabs are iframes, each with its own guard copy.
  await page.goto(HOME_URL);
  await page.evaluate(() => localStorage.removeItem('ms_pinned_tabs'));
  await page.reload();
  await page.click('a.card-manuscript');
  await page.waitForSelector('#ms-tab-panels .ms-panel.active', { timeout: 15000 });
  const tabFrame = page.frames().find((f) => f.url().includes('manuscript_id'));
  await tabFrame.waitForSelector('.pagedjs_page', { timeout: 60000 });
  await tabFrame.evaluate(() => {
    window.__restored = 0;
    document.addEventListener('ms:session-restored', () => { window.__restored++; });
  });

  await context.clearCookies();
  await tabFrame.evaluate(() => fetch('api/session', { credentials: 'include' }));
  await page.waitForSelector('.msg-overlay', { timeout: 8000 }).catch(() => {});
  check('tab expiry opens the modal in the TOP window',
    await page.locator('.msg-overlay').count() === 1);
  check('...and not inside the tab', await tabFrame.locator('.msg-overlay').count() === 0);
  check('the modal covers the tab bar', await page.evaluate(() => {
    const r = document.getElementById('ms-tabs').getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!(hit && hit.closest('.msg-overlay'));
  }));

  // A second 401, from the shell itself, joins the same modal.
  await page.evaluate(() => fetch('api/session', { credentials: 'include' }));
  await tabFrame.evaluate(() => fetch('api/session', { credentials: 'include' }));
  check('one modal no matter how many frames 401',
    await page.locator('.msg-overlay').count() === 1
    && await tabFrame.locator('.msg-overlay').count() === 0);

  await page.fill('#msg-user', USERNAME);
  await page.fill('#msg-pass', 'test');
  await page.click('.msg-login');
  await page.waitForSelector('.msg-overlay', { state: 'detached', timeout: 8000 }).catch(() => {});
  await tabFrame.waitForFunction(() => window.__restored > 0, null, { timeout: 8000 }).catch(() => {});
  check('login in the top modal fires ms:session-restored inside the tab',
    await tabFrame.evaluate(() => window.__restored) === 1);
  await page.evaluate(() => localStorage.removeItem('ms_pinned_tabs'));

  console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS');
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('Test crashed:', e); process.exit(1); });
