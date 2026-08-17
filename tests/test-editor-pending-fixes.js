// FORMER pending-fix ledger (CODE_REVIEW_AUG_2026 Area 1 — the three ⚠ E
// rows), FLIPPED TO FATAL in the 2C-1 fix phase. All three bugs are fixed:
//
//   doc-save-inflight-typing  — the doc autosave now rides the shared
//     createAutosaver (edit-pane.js), whose in-flight "chase" keeps the
//     saver dirty when keystrokes land during a PUT; status/isDirty stay
//     honest and close flushes the tail.
//   notecache-staleness       — createScratchpadEditor clears the module
//     noteCache per open, so a note recolored between pad opens renders
//     fresh on reopen.
//   canonize-two-step-failure — import-scratchpad's go-button label is one
//     constant (GO_LABEL 'Place'); the error path restores it, and the
//     error mentions the already-saved suggestion.
//
// Every former `intended` check is now failing-is-fatal.
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const { TEST_URL, TEST_MANUSCRIPT_ID, cleanupTestNotes, loginAsTestUser, waitForPagination } = require('./test-utils');
const HOME_URL = new URL('home.html', TEST_URL).href;
function psql(sql) {
  return execSync(
    `PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8' }).trim();
}

(async () => {
  console.log('=== editor pending-fixes (FLIPPED: every check is fatal) ===\n');
  const browser = await chromium.launch({ headless: true });
  let fatal = 0;
  const check = (n, ok, extra) => {
    console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`);
    if (!ok) fatal++;
  };
  // Formerly non-fatal "intended semantics" — now identical to check.
  const intended = check;

  await cleanupTestNotes();

  // ==== 1. doc-save-inflight-typing =========================================
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('dialog', d => d.accept());
    await loginAsTestUser(page);
    await page.goto(HOME_URL);
    await page.waitForSelector('#home-new-pad');
    await page.click('#home-new-pad');
    await page.waitForSelector('.spm-overlay .ProseMirror');
    const padId = await page.evaluate(() => window.WriteSysScratchpad.scratchpadId);
    // Slow the doc PUT by ~1s so there's a real in-flight window.
    await page.route(`**/api/scratchpads/${padId}`, async (route) => {
      if (route.request().method() === 'PUT') await new Promise(r => setTimeout(r, 1000));
      return route.continue();
    });
    await page.locator('.spm-editor .ProseMirror').click();
    await page.keyboard.type('first words.');
    const putStarted = page.waitForRequest((r) =>
      r.url().includes(`/api/scratchpads/${padId}`) && r.method() === 'PUT', { timeout: 10000 });
    const putDone = page.waitForResponse((r) =>
      r.url().includes(`/api/scratchpads/${padId}`) && r.request().method() === 'PUT', { timeout: 15000 });
    await putStarted;
    await page.waitForTimeout(600); // land the keystrokes LATE in the flight
    await page.keyboard.type(' typed during flight');
    await putDone;
    const state = await page.evaluate(() => ({
      status: document.querySelector('#spm-status').textContent,
      dirty: window.WriteSysScratchpad.isDirty(),
    }));
    intended('in-flight keystrokes: status must NOT read Saved when the stale PUT resolves',
      state.status !== 'Saved', `status="${state.status}"`);
    intended('in-flight keystrokes: isDirty() must stay true', state.dirty === true, `dirty=${state.dirty}`);
    // Close IMMEDIATELY (inside the masked window, before the 1.2s debounce).
    await page.click('#spm-close');
    await page.waitForSelector('.spm-overlay', { state: 'detached', timeout: 15000 });
    await page.unroute(`**/api/scratchpads/${padId}`);
    const dbDoc = psql(`SELECT doc::text FROM scratchpad WHERE scratchpad_id=${padId}`);
    check('the pre-flight text persisted', /first words\./.test(dbDoc));
    intended('immediate close must not lose the in-flight keystrokes',
      /typed during flight/.test(dbDoc), 'text typed during the PUT was discarded on close');
    await page.close();
  }

  // ==== 2. notecache-staleness =============================================
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('dialog', d => d.accept());
    await loginAsTestUser(page);
    await page.goto(HOME_URL);
    await page.waitForSelector('#home-new-pad');
    await page.click('#home-new-pad');
    await page.waitForSelector('.spm-overlay .ProseMirror');
    const padId = await page.evaluate(() => window.WriteSysScratchpad.scratchpadId);
    await page.locator('.spm-editor .ProseMirror').click();
    await page.keyboard.type('A phrase that will carry a note.');
    await page.evaluate(() => {
      const ed = window.WriteSysScratchpad; const v = ed.view;
      let from = -1;
      v.state.doc.descendants((node, pos) => {
        if (from >= 0) return false;
        if (node.isText && node.text.includes('phrase that will')) { from = pos + node.text.indexOf('phrase that will'); return false; }
      });
      v.dispatch(v.state.tr.setSelection(ed.pm.TextSelection.create(v.state.doc, from, from + 'phrase that will'.length)));
    });
    await page.locator('.sn-note-colorbar .sn-note-colorbtn.color-yellow').click();
    await page.waitForSelector('.sn-note-ref');
    const noteId = parseInt(await page.locator('.sn-note-ref').getAttribute('data-note-id'), 10);
    check('note created yellow', noteId > 0 && psql(`SELECT color FROM note WHERE note_id=${noteId}`) === 'yellow');
    await page.locator('#spm-title').click(); // close float
    await page.waitForFunction(() => !document.querySelector('.sn-note-float'));
    await page.waitForFunction(() => document.querySelector('#spm-status').textContent === 'Saved');
    await page.click('#spm-close');
    await page.waitForSelector('.spm-overlay', { state: 'detached' });
    // Recolor BETWEEN pad opens (the landing grid / another surface).
    await page.evaluate((id) => window.WriteSysNoteAPI.update(id, { color: 'red' }), noteId);
    let recolored = false;
    for (let i = 0; i < 20; i++) {
      if (psql(`SELECT color FROM note WHERE note_id=${noteId}`) === 'red') { recolored = true; break; }
      await new Promise(r => setTimeout(r, 150));
    }
    check('note recolored red between pad opens', recolored);
    // Reopen WITHOUT a page reload — the module noteCache survives.
    await page.evaluate((id) => window.WriteSysScratchpadModal.open(id), padId);
    await page.waitForSelector('.spm-overlay .sn-note-ref');
    // Give any (absent today) refetch a beat to land.
    for (let i = 0; i < 4; i++) await page.waitForTimeout(300);
    const cls = await page.locator('.sn-note-ref').getAttribute('class');
    intended('reopened pad must render the FRESH note color (red, not the cached yellow)',
      /color-red/.test(cls), `class="${cls}" (noteCache never invalidated across modal opens)`);
    await page.click('#spm-close');
    await page.waitForSelector('.spm-overlay', { state: 'detached' });
    await page.close();
  }

  // ==== 3. canonize-two-step-failure =======================================
  {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } });
    page.on('dialog', d => d.accept());
    await loginAsTestUser(page);
    await page.goto(TEST_URL, { waitUntil: 'domcontentloaded' });
    // index.html seeds sessionStorage.csrf_token asynchronously from
    // /api/session — wait for it before making CSRF'd writes.
    await page.waitForFunction(() =>
      sessionStorage.getItem('csrf_token') || localStorage.getItem('csrf_token'), null, { timeout: 15000 });
    const sk = await page.evaluate(async () => {
      const csrf = (localStorage.getItem('csrf_token') || sessionStorage.getItem('csrf_token')) || '';
      const H = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf };
      const s = await (await fetch('api/sketches', { method: 'POST', headers: H, body: JSON.stringify({ mode: 'new' }) })).json();
      await fetch(`api/variations/${s.variation.variation_id}`, { method: 'PUT', headers: H, body: JSON.stringify({ text: 'Two step failure body.' }) });
      return { sketchId: s.sketch.sketch_id, varId: s.variation.variation_id };
    });
    await page.goto(TEST_URL);
    await waitForPagination(page);
    await page.waitForSelector('.import-zone .import-tab', { timeout: 20000 });
    await page.route('**/canonize', (route) => route.fulfill({ status: 500, body: 'db exploded' }));
    const boundaryId = await page.evaluate(() => {
      const z = document.querySelector('.import-zone');
      z.querySelector('.import-tab').click();
      return z.dataset.sentenceId;
    });
    await page.waitForSelector('.im-block');
    check('the button starts as "Place"', (await page.textContent('#im-go')).trim() === 'Place');
    await page.evaluate(() => {
      [...document.querySelectorAll('.im-block')].find(r => /Two step failure/.test(r.textContent)).querySelector('input').click();
    });
    await page.fill('#im-label', 'Doomed');
    await page.click('#im-go');
    await page.waitForFunction(() =>
      ((document.querySelector('#im-error') || {}).textContent || '').length > 0, null, { timeout: 20000 });
    const errText = await page.textContent('#im-error');
    intended('canonize-step failure error mentions the ALREADY-SAVED suggestion',
      /[Ss]uggestion saved/.test(errText), errText.slice(0, 90));
    const goLabel = (await page.textContent('#im-go')).trim();
    intended('error path restores the button to its ORIGINAL "Place" label',
      goLabel === 'Place', `label="${goLabel}" (drifts to "Canonize", import-scratchpad.js:147 vs :313)`);
    check('the suggestion from step 1 really was saved (the message must be honest)',
      psql(`SELECT count(*) FROM suggested_change WHERE sentence_id='${boundaryId}'`) === '1');
    await page.unroute('**/canonize');
    await page.close();
  }

  await cleanupTestNotes();
  await browser.close();

  console.log(fatal === 0 ? '\n✅ Test passed' : `\n❌ ${fatal} check(s) failed`);
  process.exit(fatal === 0 ? 0 : 1);
})().catch(e => { console.error('Test crashed:', e); process.exit(1); });
