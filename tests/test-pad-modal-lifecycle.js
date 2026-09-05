// Scratchpad modal lifecycle e2e (CODE_REVIEW_AUG_2026 Area 1, the
// modal.mjs / scratchpad-modal.js half of the last table — 9 rows):
//   open-serialization, escape-scoping, backdrop-vs-dialog-click,
//   hash-lifecycle, editor-open-failure, opened-stamp, pad-link-put-failure,
//   lazy-load-once, restore-from-hash-matrix.
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const { TEST_URL, cleanupTestNotes, loginAsTestUser } = require('./test-utils');
const HOME_URL = new URL('home.html', TEST_URL).href;
function psql(sql) {
  return execSync(
    `PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8' }).trim();
}

(async () => {
  console.log('=== scratchpad modal lifecycle e2e ===\n');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1300, height: 950 } });
  const dialogs = [];
  page.on('dialog', d => { dialogs.push(d.message()); d.accept().catch(() => {}); });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  let modalMjsRequests = 0;
  page.on('request', (r) => { if (/scratchpad\/modal\.mjs/.test(r.url())) modalMjsRequests++; });
  let failed = 0;
  const check = (n, ok, extra) => {
    console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`);
    if (!ok) failed++;
  };
  const currentId = () => page.evaluate(() => {
    const M = window.WriteSysScratchpadModal;
    return M._mod ? M._mod.ScratchpadModal.currentId() : 0;
  });

  await cleanupTestNotes();
  await loginAsTestUser(page);
  await page.goto(HOME_URL);
  await page.waitForSelector('.card-ghost[data-ghost="scratchpad"]');

  try {
    // padA: seeded with one sketch widget (for escape-scoping + deep links);
    // padB: empty.
    const seed = await page.evaluate(async () => {
      const csrf = (localStorage.getItem('csrf_token') || sessionStorage.getItem('csrf_token')) || '';
      const H = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf };
      const padA = (await (await fetch('api/scratchpads', { method: 'POST', headers: H, body: JSON.stringify({ title: 'pad A' }) })).json()).scratchpad_id;
      const padB = (await (await fetch('api/scratchpads', { method: 'POST', headers: H, body: JSON.stringify({ title: 'pad B' }) })).json()).scratchpad_id;
      const sk = await (await fetch('api/sketches', { method: 'POST', headers: H, body: JSON.stringify({ mode: 'new', scratchpad_id: padA }) })).json();
      await fetch(`api/scratchpads/${padA}`, {
        method: 'PUT', headers: H,
        body: JSON.stringify({
          title: 'pad A',
          doc: { type: 'doc', content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'pad A prose' }] },
            { type: 'sketch', attrs: { variationId: sk.variation.variation_id } },
            { type: 'paragraph' },
          ] },
        }),
      });
      return { padA, padB, sketchId: sk.sketch.sketch_id, varId: sk.variation.variation_id };
    });

    // ---- lazy-load-once + open-serialization ------------------------------
    // FINDING (upstream, order-nondeterministic): if the RACE below is the
    // page's FIRST open, both wrapper calls run `await this._load()`
    // concurrently (scratchpad-modal.js:11–16) — two import() promises whose
    // resolution order is unspecified — so either open can reach the
    // serialized ScratchpadModal.open first and the LOSER opens last. Warm
    // the loader first: the modal.mjs:27–39 serialization contract ("second
    // open wins") only holds once the module is loaded.
    const serial = await page.evaluate(async (s) => {
      const M = window.WriteSysScratchpadModal;
      await M._load();
      // Two opens racing: the second must WAIT for the first, then win.
      await Promise.all([M.open(s.padA), M.open(s.padB)]);
      const mod1 = M._mod;
      const afterRace = {
        overlays: document.querySelectorAll('.spm-overlay').length,
        current: M._mod.ScratchpadModal.currentId(),
      };
      await M.close();
      await M.open(s.padA);
      return { afterRace, sameModule: M._mod === mod1 };
    }, seed);
    check('racing opens serialize — ONE overlay, the second open wins',
      serial.afterRace.overlays === 1 && serial.afterRace.current === seed.padB, JSON.stringify(serial.afterRace));
    check('modal module is imported once and reused across opens', serial.sameModule === true);
    check('modal.mjs fetched from the network exactly once', modalMjsRequests === 1, `requests=${modalMjsRequests}`);

    // ---- escape-scoping ---------------------------------------------------
    await page.waitForSelector('.spm-overlay .sn-widget .sn-render');
    await page.locator('.sn-widget .sn-render').click();
    await page.waitForSelector('.sn-widget textarea.sn-text');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.sn-widget .sn-render');
    check('Escape inside the sketch textarea exits edit ONLY (pad stays open)',
      (await page.locator('.spm-overlay').count()) === 1);
    await page.waitForFunction(() => document.querySelector('#spm-status').textContent === 'Saved');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.spm-overlay', { state: 'detached' });
    check('second Escape closes the pad', true);

    // ---- open-while-close-refused (the serialization guard's other half) --
    {
      await page.evaluate((id) => window.WriteSysScratchpadModal.open(id), seed.padB);
      await page.waitForSelector('.spm-overlay .ProseMirror');
      let block = true;
      await page.route(`**/api/scratchpads/${seed.padB}`, (route) => {
        if (route.request().method() === 'PUT' && block) return route.fulfill({ status: 500, body: 'down' });
        return route.continue();
      });
      await page.locator('.spm-editor .ProseMirror').click();
      await page.keyboard.type('unsaved words');
      await page.waitForFunction(() => /Failed to save/.test(document.querySelector('#spm-status').textContent), null, { timeout: 15000 });
      await page.evaluate((id) => window.WriteSysScratchpadModal.open(id), seed.padA);
      const state = await page.evaluate(() => ({
        overlays: document.querySelectorAll('.spm-overlay').length,
        current: window.WriteSysScratchpadModal._mod.ScratchpadModal.currentId(),
      }));
      check('open while close is refused ABORTS without stacking (pad B still up)',
        state.overlays === 1 && state.current === seed.padB, JSON.stringify(state));
      block = false;
      await page.unroute(`**/api/scratchpads/${seed.padB}`);
      await page.click('#spm-close');
      await page.waitForSelector('.spm-overlay', { state: 'detached' });
    }

    // ---- backdrop-vs-dialog-click + expand toggle -------------------------
    await page.evaluate((id) => window.WriteSysScratchpadModal.open(id), seed.padB);
    await page.waitForSelector('.spm-overlay .ProseMirror');
    await page.locator('.spm-dialog').dispatchEvent('mousedown', { bubbles: true });
    await page.waitForTimeout(300);
    check('mousedown INSIDE the dialog does not close', (await page.locator('.spm-overlay').count()) === 1);
    // The expander became the PIN (tabs feature): clicking pins the pad as
    // a tab under the top bar; clicking again unpins.
    await page.click('#spm-pin');
    check('pin adds the pad to the tab row',
      await page.locator('#ms-tabs .ms-tab-scratchpad').count() === 1
      && await page.locator('#spm-pin.pinned').count() === 1);
    await page.click('#spm-pin');
    check('re-click unpins (pad tab gone; Home stays — the bar is permanent)',
      await page.locator('#ms-tabs .ms-tab-scratchpad').count() === 0
      && await page.locator('#ms-tabs .ms-tab-home').count() === 1
      && await page.locator('#ms-tabs[hidden]').count() === 0)

    // ---- hash-lifecycle ---------------------------------------------------
    {
      const histBefore = await page.evaluate(() => history.length);
      await page.evaluate((id) => window.WriteSysScratchpadModal.open(id), seed.padB);
      await page.waitForSelector('.spm-overlay .ProseMirror');
      check('open stamps #scratchpad=N', (await page.evaluate(() => location.hash)) === `#scratchpad=${seed.padB}`);
      check('replaceState only — history.length unchanged',
        (await page.evaluate(() => history.length)) === histBefore);
      await page.click('#spm-close');
      await page.waitForSelector('.spm-overlay', { state: 'detached' });
      check('close clears the scratchpad hash', (await page.evaluate(() => location.hash)) === '');
      // Deep-link params survive the open (sketch=&variation= preserved).
      await page.evaluate((s) => { location.hash = `#scratchpad=${s.padA}&sketch=${s.sketchId}&variation=1`; }, seed);
      await page.waitForSelector('.spm-overlay .ProseMirror');
      const h = await page.evaluate(() => location.hash);
      check('deep-link sketch/variation params preserved through the open',
        h.includes(`sketch=${seed.sketchId}`) && h.includes('variation=1'), h);
      // A NON-scratchpad hash set while the pad is open must survive close.
      await page.evaluate(() => { location.hash = '#foo'; });
      await page.waitForTimeout(200); // hashchange → restoreFromHash no-ops
      await page.waitForFunction(() => document.querySelector('#spm-status').textContent === 'Saved');
      await page.click('#spm-close');
      await page.waitForSelector('.spm-overlay', { state: 'detached' });
      check('close clears ONLY scratchpad hashes (#foo survives)',
        (await page.evaluate(() => location.hash)) === '#foo');
      await page.evaluate(() => { location.hash = ''; });
    }

    // ---- opened-stamp -----------------------------------------------------
    {
      let stamps = 0;
      let block = false;
      await page.route('**/opened', (route) => {
        stamps++;
        if (block) return route.fulfill({ status: 500, body: 'nope' });
        return route.continue();
      });
      await page.evaluate((id) => window.WriteSysScratchpadModal.open(id), seed.padB);
      await page.waitForSelector('.spm-overlay .ProseMirror');
      check('open POSTs the /opened recency stamp exactly once', stamps === 1, `stamps=${stamps}`);
      await page.click('#spm-close');
      await page.waitForSelector('.spm-overlay', { state: 'detached' });
      block = true;
      errs.length = 0;
      await page.evaluate((id) => window.WriteSysScratchpadModal.open(id), seed.padB);
      await page.waitForSelector('.spm-overlay .ProseMirror');
      check('a failing /opened stamp is ignored (pad opens fine)',
        (await page.locator('.spm-overlay .ProseMirror').count()) === 1 && errs.length === 0);
      await page.click('#spm-close');
      await page.waitForSelector('.spm-overlay', { state: 'detached' });
      await page.unroute('**/opened');
    }

    // ---- pad-link-put-failure --------------------------------------------
    {
      let block = true;
      await page.route(`**/api/scratchpads/${seed.padB}/link`, (route) =>
        block ? route.fulfill({ status: 500, body: 'no link' }) : route.continue());
      await page.evaluate((id) => window.WriteSysScratchpadModal.open(id), seed.padB);
      await page.waitForSelector('#spm-link .ms-chip.unlinked');
      dialogs.length = 0;
      await page.locator('#spm-link .ms-chip.unlinked').click();
      await page.waitForSelector('.note-linkpop button[data-mid]');
      await page.locator('.note-linkpop button[data-mid]').first().click();
      let alerted = false;
      for (let i = 0; i < 30 && !alerted; i++) {
        alerted = dialogs.some(m => /Could not link scratchpad/.test(m));
        if (!alerted) await page.waitForTimeout(100);
      }
      check('link PUT 500 → alert surfaces the failure', alerted, dialogs.join('; ').slice(0, 80));
      check('chip stays unlinked in the UI', (await page.locator('#spm-link .ms-chip.unlinked').count()) === 1);
      check('nothing linked server-side',
        psql(`SELECT linked_manuscript_id IS NULL FROM scratchpad WHERE scratchpad_id=${seed.padB}`) === 't');
      block = false;
      await page.unroute(`**/api/scratchpads/${seed.padB}/link`);
      await page.click('#spm-close');
      await page.waitForSelector('.spm-overlay', { state: 'detached' });
    }

    // ---- editor-open-failure ---------------------------------------------
    {
      let block = true;
      await page.route(`**/api/scratchpads/${seed.padB}`, (route) => {
        if (route.request().method() === 'GET' && block) return route.fulfill({ status: 500, body: 'broken pad' });
        return route.continue();
      });
      await page.evaluate((id) => window.WriteSysScratchpadModal.open(id), seed.padB);
      await page.waitForFunction(() =>
        /Failed to open scratchpad/.test((document.querySelector('#spm-editor') || {}).textContent || ''));
      check('GET 500 → error rendered in the editor slot', true);
      await page.click('#spm-close');
      await page.waitForSelector('.spm-overlay', { state: 'detached' });
      check('a failed-open pad still closes cleanly', true);
      block = false;
      await page.unroute(`**/api/scratchpads/${seed.padB}`);
    }

    // ---- restore-from-hash-matrix (fresh page = fresh module state) -------
    {
      const p2 = await browser.newPage({ viewport: { width: 1300, height: 950 } });
      p2.on('dialog', d => d.accept());
      await loginAsTestUser(p2);
      await p2.goto(`${HOME_URL}#scratchpad=${seed.padA}`);
      await p2.waitForSelector('.spm-overlay .ProseMirror', { timeout: 20000 });
      check('page load with #scratchpad=N auto-opens the pad', true);
      await p2.evaluate(() => { document.querySelector('.spm-overlay').__ov = true; });
      // Same-pad hashchange with a deep-link → scroll only, NO re-open.
      await p2.evaluate((s) => { location.hash = `#scratchpad=${s.padA}&sketch=${s.sketchId}&variation=1`; }, seed);
      await p2.waitForSelector(`.sn-widget[data-sketch-id="${seed.sketchId}"]`);
      let flashed = false;
      for (let i = 0; i < 30 && !flashed; i++) {
        flashed = (await p2.locator('.sn-widget.sn-flash').count()) > 0;
        if (!flashed) await p2.waitForTimeout(150);
      }
      const sameOverlay = await p2.evaluate(() => !!document.querySelector('.spm-overlay').__ov);
      check('same-pad hashchange keeps the SAME overlay (scroll only)', sameOverlay);
      check('…and flashes the deep-linked widget', flashed);
      // Different-pad hashchange swaps pads.
      await p2.waitForFunction(() => document.querySelector('#spm-status').textContent === 'Saved');
      await p2.evaluate((s) => { location.hash = `#scratchpad=${s.padB}`; }, seed);
      await p2.waitForFunction((s) => {
        const M = window.WriteSysScratchpadModal;
        const ov = document.querySelector('.spm-overlay');
        return ov && !ov.__ov && M._mod && M._mod.ScratchpadModal.currentId() === s.padB;
      }, seed, { timeout: 20000 });
      check('different-pad hashchange swaps to the new pad (fresh overlay)', true);
      await p2.close();
    }

    check('no page errors', errs.length === 0, errs.slice(0, 3).join('; '));
  } finally {
    await cleanupTestNotes();
    await browser.close();
  }

  console.log(failed === 0 ? '\n✅ Test passed' : `\n❌ ${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('Test crashed:', e); process.exit(1); });
