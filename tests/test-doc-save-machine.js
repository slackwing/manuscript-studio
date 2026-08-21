// The scratchpad doc save machine + close guard (CODE_REVIEW_AUG_2026 Area 1,
// "Save machine & close guard" — the 7 non-⚠ E rows; the in-flight-typing ⚠
// row lives in test-editor-pending-fixes.js):
//   - doc-save-retry-ladder: failing PUTs → countdown 2s then 4s, live
//     countdown tick, success resets the ladder back to 2s;
//   - close-refused-while-failing: Escape / backdrop / × all leave the pad
//     open while the server 500s; recovery lets it close;
//   - close-refused-by-variation-flush: doc PUT fine but a widget flusher
//     failing → saveNow() false, pad stays open;
//   - destroyed-saver-no-retry: destroy() with a pending failure → no retry
//     PUTs after teardown;
//   - title-input-autosaves: a title edit alone marks Unsaved and persists;
//   - session-restored-flushes-variations: dirty variation + the
//     ms:session-restored event → immediate flush (not the backoff);
//   - frozen-409-pins-status: variation frozen under an open editor →
//     "frozen — not saved" pinned, no retry loop.
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const { TEST_URL, TEST_USERNAME, cleanupTestNotes, loginAsTestUser } = require('./test-utils');
const HOME_URL = new URL('home.html', TEST_URL).href;
function psql(sql) {
  return execSync(
    `PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8' }).trim();
}

(async () => {
  console.log('=== doc save machine & close guard ===\n');
  const browser = await chromium.launch({ headless: true });
  let failed = 0;
  const check = (n, ok, extra) => {
    console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`);
    if (!ok) failed++;
  };

  await cleanupTestNotes();

  // Fresh page + pad per scenario — save-machine state is per editor instance.
  const newPadPage = async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('dialog', d => d.accept());
    await loginAsTestUser(page);
    await page.goto(HOME_URL);
    await page.waitForSelector('.card-ghost[data-ghost="scratchpad"]');
    await page.click('.card-ghost[data-ghost="scratchpad"]');
    await page.waitForSelector('.spm-overlay .ProseMirror');
    const padId = await page.evaluate(() => window.WriteSysScratchpad.scratchpadId);
    return { page, padId };
  };
  const status = (page) => page.textContent('#spm-status');
  const waitStatus = (page, re, timeout = 15000) =>
    page.waitForFunction((src) => new RegExp(src).test(document.querySelector('#spm-status').textContent),
      re.source, { timeout });

  // ---- doc-save-retry-ladder ------------------------------------------------
  {
    const { page, padId } = await newPadPage();
    let block = true;
    await page.route(`**/api/scratchpads/${padId}`, (route) => {
      if (route.request().method() === 'PUT' && block) return route.fulfill({ status: 500, body: 'boom' });
      return route.continue();
    });
    await page.locator('.spm-editor .ProseMirror').click();
    await page.keyboard.type('ladder test');
    check('typing marks Unsaved', (await status(page)) === 'Unsaved');
    await waitStatus(page, /Trying again in 2s/);
    check('first failure schedules 2s retry', true);
    await waitStatus(page, /Trying again in 1s/, 4000);
    check('countdown ticks down live (2s → 1s)', true);
    await waitStatus(page, /Trying again in 4s/);
    check('second failure backs off to 4s', true);
    block = false; // the pending 4s retry now succeeds
    await waitStatus(page, /^Saved$/, 10000);
    check('retry after recovery saves (status Saved)', true);
    block = true;
    await page.keyboard.type(' more');
    await waitStatus(page, /Trying again in 2s/);
    check('success reset the ladder (next failure starts at 2s again)', true);
    block = false;
    await waitStatus(page, /^Saved$/, 10000);
    const dbDoc = psql(`SELECT doc::text FROM scratchpad WHERE scratchpad_id=${padId}`);
    check('typed text persisted after recovery', /ladder test more/.test(dbDoc));
    await page.close();
  }

  // ---- close-refused-while-failing -----------------------------------------
  {
    const { page, padId } = await newPadPage();
    let block = true;
    await page.route(`**/api/scratchpads/${padId}`, (route) => {
      if (route.request().method() === 'PUT' && block) return route.fulfill({ status: 500, body: 'down' });
      return route.continue();
    });
    await page.locator('.spm-editor .ProseMirror').click();
    await page.keyboard.type('must not be lost');
    await waitStatus(page, /Trying again/);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => /Failed to save/.test(document.querySelector('#spm-status').textContent), null, { timeout: 5000 });
    check('Escape leaves the pad open while failing', (await page.locator('.spm-overlay').count()) === 1);
    await page.mouse.click(8, 8); // backdrop
    await page.waitForFunction(() => /Failed to save/.test(document.querySelector('#spm-status').textContent), null, { timeout: 5000 });
    check('backdrop click leaves the pad open while failing', (await page.locator('.spm-overlay').count()) === 1);
    await page.click('#spm-close');
    await page.waitForFunction(() => /Failed to save/.test(document.querySelector('#spm-status').textContent), null, { timeout: 5000 });
    check('× leaves the pad open while failing', (await page.locator('.spm-overlay').count()) === 1);
    check('countdown stays visible on the refused close', /Trying again in \d+s/.test(await status(page)));
    block = false;
    await page.click('#spm-close');
    await page.waitForSelector('.spm-overlay', { state: 'detached', timeout: 15000 });
    check('recovered server → close succeeds', true);
    const dbDoc = psql(`SELECT doc::text FROM scratchpad WHERE scratchpad_id=${padId}`);
    check('nothing lost across the refused closes', /must not be lost/.test(dbDoc));
    await page.close();
  }

  // ---- close-refused-by-variation-flush ------------------------------------
  {
    const { page, padId } = await newPadPage();
    const ctx = await page.evaluate(() => window.WriteSysScratchpad.insertSketch());
    const vid = ctx.variation.variation_id;
    await page.waitForSelector('.sn-widget .sn-render');
    await page.locator('.sn-widget .sn-render').click();
    await page.waitForSelector('.sn-widget textarea.sn-text');
    let block = true;
    await page.route(`**/api/variations/${vid}`, (route) => {
      if (route.request().method() === 'PUT' && block) return route.fulfill({ status: 500, body: 'nope' });
      return route.continue();
    });
    await page.locator('.sn-widget textarea.sn-text').fill('widget words');
    // The variation autosaver fails on its own debounce → loud per-widget error.
    await page.waitForFunction(() => /Failed to save/.test((document.querySelector('.sn-widget .sn-save') || {}).textContent || ''), null, { timeout: 8000 });
    const saved = await page.evaluate(() => window.WriteSysScratchpad.saveNow());
    check('saveNow() returns false when a widget flusher fails (doc PUT itself fine)', saved === false);
    check('doc status itself reads Saved (failure is the variation, not the doc)', (await status(page)) === 'Saved');
    await page.click('#spm-close');
    await page.waitForFunction(() => /Failed to save/.test((document.querySelector('.sn-widget .sn-save') || {}).textContent || ''), null, { timeout: 5000 });
    check('close refused while the variation flush fails', (await page.locator('.spm-overlay').count()) === 1);
    block = false;
    await page.click('#spm-close');
    await page.waitForSelector('.spm-overlay', { state: 'detached', timeout: 15000 });
    check('close succeeds once the variation flush works', true);
    const dbText = psql(`SELECT text FROM variation WHERE variation_id=${vid}`);
    check('variation text persisted by the close flush', dbText === 'widget words', JSON.stringify(dbText));
    await page.close();
  }

  // ---- destroyed-saver-no-retry --------------------------------------------
  {
    const { page, padId } = await newPadPage();
    let puts = 0;
    await page.route(`**/api/scratchpads/${padId}`, (route) => {
      if (route.request().method() === 'PUT') { puts++; return route.fulfill({ status: 500, body: 'down' }); }
      return route.continue();
    });
    await page.locator('.spm-editor .ProseMirror').click();
    await page.keyboard.type('doomed');
    await waitStatus(page, /Trying again/);
    const putsBeforeDestroy = puts;
    await page.evaluate(() => window.WriteSysScratchpad.destroy());
    // destroy() makes one final saveNow attempt (saveState !== 'saved'); the
    // failure must NOT schedule a retry because destroyed is already set.
    const putsAfterDestroy = puts;
    check('destroy makes at most one final save attempt', putsAfterDestroy - putsBeforeDestroy <= 1, `delta=${putsAfterDestroy - putsBeforeDestroy}`);
    // Negative window: nothing may fire after teardown (first retry would be 2s).
    for (let i = 0; i < 5; i++) await page.waitForTimeout(700);
    check('no retry PUTs after teardown (3.5s window)', puts === putsAfterDestroy, `puts=${puts} vs ${putsAfterDestroy}`);
    await page.close(); // overlay is intentionally stranded; discard the page
  }

  // ---- title-input-autosaves -----------------------------------------------
  {
    const { page, padId } = await newPadPage();
    await page.waitForFunction(() => document.querySelector('#spm-status').textContent === 'Saved');
    await page.fill('#spm-title', 'Title Only Edit'); // fill fires one input event
    check('title edit alone marks Unsaved', (await status(page)) === 'Unsaved');
    await waitStatus(page, /^Saved$/);
    const dbTitle = psql(`SELECT title FROM scratchpad WHERE scratchpad_id=${padId}`);
    check('title persisted by the autosave', dbTitle === 'Title Only Edit', JSON.stringify(dbTitle));
    await page.click('#spm-close');
    await page.waitForSelector('.spm-overlay', { state: 'detached' });
    await page.close();
  }

  // ---- session-restored-flushes-variations ---------------------------------
  {
    const { page } = await newPadPage();
    const ctx = await page.evaluate(() => window.WriteSysScratchpad.insertSketch());
    const vid = ctx.variation.variation_id;
    await page.waitForSelector('.sn-widget .sn-render');
    await page.locator('.sn-widget .sn-render').click();
    await page.waitForSelector('.sn-widget textarea.sn-text');
    let block = true;
    await page.route(`**/api/variations/${vid}`, (route) => {
      if (route.request().method() === 'PUT' && block) return route.fulfill({ status: 500, body: 'expired' });
      return route.continue();
    });
    const FINAL = 'restored after session comeback';
    await page.locator('.sn-widget textarea.sn-text').fill(FINAL);
    // Two failures → the variation saver sits in a 4s backoff window.
    await page.waitForFunction(() => /Trying again in 4s/.test((document.querySelector('.sn-widget .sn-save') || {}).textContent || ''), null, { timeout: 12000 });
    block = false;
    const t0 = Date.now();
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('ms:session-restored')));
    let flushedAt = -1;
    for (let i = 0; i < 20; i++) {
      if (psql(`SELECT text FROM variation WHERE variation_id=${vid}`) === FINAL) { flushedAt = Date.now() - t0; break; }
      await new Promise(r => setTimeout(r, 100));
    }
    check('ms:session-restored flushes the dirty variation immediately',
      flushedAt >= 0 && flushedAt < 2000, `flushed after ${flushedAt}ms (backoff retry was ≥2.5s away)`);
    await page.close();
  }

  // ---- frozen-409-pins-status ----------------------------------------------
  {
    const { page } = await newPadPage();
    const ctx = await page.evaluate(() => window.WriteSysScratchpad.insertSketch());
    const vid = ctx.variation.variation_id;
    await page.waitForSelector('.sn-widget .sn-render');
    await page.locator('.sn-widget .sn-render').click();
    await page.waitForSelector('.sn-widget textarea.sn-text');
    await page.locator('.sn-widget textarea.sn-text').fill('about to freeze');
    // Wait for the PERSISTED text (sn-save is also '' before any save ran).
    let saved0 = false;
    for (let i = 0; i < 40; i++) {
      if (psql(`SELECT text FROM variation WHERE variation_id=${vid}`) === 'about to freeze') { saved0 = true; break; }
      await new Promise(r => setTimeout(r, 200));
    }
    check('pre-freeze text persisted', saved0);
    // Freeze underneath the open editor (another tab / API).
    const st = await page.evaluate(async (vid) => {
      const csrf = (localStorage.getItem('csrf_token') || sessionStorage.getItem('csrf_token')) || '';
      const r = await fetch(`api/variations/${vid}/state`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ state: 'frozen' }),
      });
      return r.status;
    }, vid);
    check('variation frozen via API under the open editor', st === 204, `status=${st}`);
    let puts = 0;
    await page.route(`**/api/variations/${vid}`, (route) => {
      if (route.request().method() === 'PUT') puts++;
      return route.continue();
    });
    await page.locator('.sn-widget textarea.sn-text').click();
    await page.keyboard.type(' — too late');
    await page.waitForFunction(() => ((document.querySelector('.sn-widget .sn-save') || {}).textContent || '') === 'frozen — not saved', null, { timeout: 8000 });
    check('409 pins the status to "frozen — not saved"', true);
    const putsAtPin = puts;
    for (let i = 0; i < 5; i++) await page.waitForTimeout(700);
    check('fatal 409 does NOT retry (no PUTs after the pin, 3.5s window)', puts === putsAtPin, `puts=${puts} vs ${putsAtPin}`);
    const dbText = psql(`SELECT text FROM variation WHERE variation_id=${vid}`);
    check('frozen text untouched on the server', dbText === 'about to freeze', JSON.stringify(dbText));
    await page.close();
  }

  await cleanupTestNotes();
  await browser.close();
  console.log(failed === 0 ? '\n✅ Test passed' : `\n❌ ${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('Test crashed:', e); process.exit(1); });
