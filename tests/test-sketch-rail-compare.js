// The sketch widget under the SHARED pane-widget shell (pane-widget.js):
//  - LEFT pane = self, its rail carrying the identity letter; RIGHT pane =
//    peers, collapsed to just its rail until a sibling letter is clicked;
//  - clicking a sibling opens the split (left self/editable, right the
//    sibling read-only); same letter closes it, another letter swaps it;
//  - actions live in the header while collapsed, in per-pane action rows
//    when split; sibling letters color-code state (frozen bluish,
//    superseded reddish);
//  - superseded variations are EXCLUDED from the wordcount representative
//    ("canonized wins, then most recent non-superseded").
const { chromium } = require('playwright');
const { TEST_URL, TEST_MANUSCRIPT_ID, loginAsTestUser, cleanupTestNotes } = require('./test-utils');
const HOME_URL = new URL('home.html', TEST_URL).href;
const SYSTEM_TOKEN = 'dev-system-token-not-for-production';
const API = TEST_URL.replace(/\/$/, '') + '/api';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('dialog', d => d.accept());
  let failed = false;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed = true; };

  await cleanupTestNotes(); // stray linked sketches skew the wordcount check
  await loginAsTestUser(page);
  await page.goto(HOME_URL);
  await page.waitForSelector('.card-ghost[data-ghost="scratchpad"]'); await page.click('.card-ghost[data-ghost="scratchpad"]');
  await page.waitForSelector('.spm-overlay .ProseMirror');
  await page.locator('.spm-editor .ProseMirror').click();

  // Sketch with 9 extra variations → 10 letters total.
  const ids = await page.evaluate(async () => {
    const ed = window.WriteSysScratchpad;
    const a = await ed.insertSketch();
    await ed.variationApi.saveText(a.variation.variation_id, 'alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha'); // 10 words
    const sibs = [];
    for (let i = 0; i < 9; i++) sibs.push((await ed.variationApi.createFrom(a.variation.variation_id)).variation.variation_id);
    return { a: a.variation.variation_id, sibs, sketch: a.sketch.sketch_id };
  });
  const padId = await page.evaluate(() => window.WriteSysScratchpad.scratchpadId);
  await page.click('#spm-close');
  await page.waitForSelector('.spm-overlay', { state: 'detached' });
  await page.evaluate((id) => window.WriteSysScratchpadModal.open(id), padId);
  await page.waitForSelector('.spm-editor .sn-widget .sn-rail');
  await page.waitForTimeout(600);

  const rail = await page.evaluate(() => {
    const w = document.querySelector('.sn-widget');
    return {
      peers: [...w.querySelectorAll('.pw-rail-right .sn-rail-btn')].map(b => b.textContent.trim()),
      selfRail: [...w.querySelectorAll('.pw-rail-left .sn-rail-btn')].map(b => b.textContent.trim()),
      collapsed: w.querySelector('.pw-right').classList.contains('pw-collapsed'),
      corner: !!w.querySelector('.sn-selfletter'),
      overflow: !!w.querySelector('.sn-more-btn'),
      leftRowActions: w.querySelectorAll('.pw-actionrow-left .pw-actbtn').length,
      firstTitle: w.querySelectorAll('.pw-rail-right .sn-rail-peer')[0].title,
    };
  });
  check('right rail lists the 9 SIBLINGS; left rail is the self letter; right pane collapsed',
    rail.peers.length === 9 && rail.selfRail.join('') === 'A' && rail.collapsed && !rail.overflow, JSON.stringify(rail));
  check('no corner letter (identity lives in the left rail now)', !rail.corner);
  check('collapsed: self actions on the left pane row (never the header)', rail.leftRowActions >= 5, String(rail.leftRowActions));
  check('sibling tooltip says "Compare to variation …"', /^Compare to variation [A-Z]\./.test(rail.firstTitle), rail.firstTitle);

  // Open compare with B, swap to C, close on second click.
  const w = page.locator('.sn-widget').first();
  await w.locator('.pw-rail-right .sn-rail-peer', { hasText: 'B' }).click();
  await page.waitForTimeout(700);
  check('split opens (right pane un-collapses)',
    !(await w.locator('.pw-right').evaluate(el => el.classList.contains('pw-collapsed'))));
  const paneB = await w.evaluate(el => ({
    ordinal: el.querySelector('.pw-content-right').dataset.ordinal,
    active: (el.querySelector('.pw-rail-right .sn-rail-btn.active') || {}).textContent || '',
    peerBtns: [...el.querySelectorAll('.pw-actionrow-right .pw-actbtn')].map(b => b.className.replace('pw-actbtn ', '').split(' ')[0]).join(','),
    selfActionsInRow: el.querySelectorAll('.pw-actionrow-left .pw-actbtn').length,
    headerActions: el.querySelectorAll('.pw-header-actions .pw-actbtn').length,
    selfStillInRail: !!el.querySelector('.pw-rail-left .sn-rail-self'),
  }));
  check('right pane is B (rail letter active)', paneB.ordinal === '2' && paneB.active === 'B', JSON.stringify(paneB));
  check('peer actions in the RIGHT action row: goto, branch, supersede, freeze, copy — no trash',
    paneB.peerBtns === 'sn-goto-ext,sn-branch,sn-supersede,sn-freeze,sn-copyref', paneB.peerBtns);
  check('self actions stay on the LEFT action row; header carries none',
    paneB.selfActionsInRow >= 5 && paneB.headerActions === 0);
  check('self letter stays in the left rail', paneB.selfStillInRail);
  await w.locator('.pw-rail-right .sn-rail-peer', { hasText: 'C' }).click();
  await page.waitForTimeout(700);
  const paneC = await w.locator('.pw-content-right').evaluate(el => ({ ordinal: el.dataset.ordinal }));
  check('clicking C swaps the right pane', paneC.ordinal === '3', JSON.stringify(paneC));

  // Peer FREEZE from the split header: state lands on the DB, the compare
  // stays open, the button shows pressed.
  await w.locator('.pw-actionrow-right .sn-freeze').click();
  await page.waitForFunction(() =>
    document.querySelector('.pw-actionrow-right .sn-freeze.pw-on'), null, { timeout: 8000 });
  check('compare survives the peer state change (freeze button pressed + tinted)',
    !(await w.locator('.pw-right').evaluate(el => el.classList.contains('pw-collapsed'))));
  await w.locator('.pw-actionrow-right .sn-freeze').click(); // un-freeze back
  await page.waitForFunction(() =>
    document.querySelector('.pw-actionrow-right .sn-freeze:not(.pw-on)'), null, { timeout: 8000 });
  check('peer un-freezes from its action row too', true);

  // Read-only pane → CLICK opens the raw source in a readOnly mono pane
  // (selectable/copyable, disabled bg, no caret); blur returns the render.
  await w.locator('.pw-content-right .sn-render').click();
  await page.waitForSelector('.pw-content-right textarea.sn-mono-ro.sn-peer-ro', { timeout: 5000 });
  const mono = await w.locator('.pw-content-right textarea.sn-mono-ro').evaluate(ta => ({
    readOnly: ta.readOnly, text: ta.value, caret: getComputedStyle(ta).caretColor,
  }));
  check('mono view is readOnly with the raw source', mono.readOnly && /alpha alpha/.test(mono.text), JSON.stringify({ ro: mono.readOnly }));
  check('no blinking caret (transparent)', /transparent|rgba\(0, 0, 0, 0\)/.test(mono.caret), mono.caret);
  await w.locator('.pw-content-right textarea.sn-mono-ro').evaluate(ta => ta.blur());
  await page.waitForSelector('.pw-content-right .sn-render', { timeout: 5000 });
  check('blur returns the rendered view', true);

  await w.locator('.pw-rail-right .sn-rail-peer', { hasText: 'C' }).click();
  await page.waitForTimeout(500);
  check('clicking C again collapses the right pane',
    await w.locator('.pw-right').evaluate(el => el.classList.contains('pw-collapsed')));
  const closedRail = await w.evaluate(el => ({
    selfInRail: !!el.querySelector('.pw-rail-left .sn-rail-self'),
    leftRowShown: !el.querySelector('.pw-actionrow-left').hidden
      && el.querySelectorAll('.pw-actionrow-left .pw-actbtn').length >= 5,
    rightRowHidden: el.querySelector('.pw-actionrow-right').hidden,
    headerEmpty: el.querySelectorAll('.pw-header-actions .pw-actbtn').length === 0,
    railsFlush: (() => {
      const l = el.querySelector('.pw-rail-left').getBoundingClientRect();
      const r = el.querySelector('.pw-rail-right').getBoundingClientRect();
      return Math.abs(r.left - l.right) < 2;
    })(),
  }));
  check('closed: self letter + actions stay on the left pane, header empty, rails flush',
    closedRail.selfInRail && closedRail.leftRowShown && closedRail.rightRowHidden
    && closedRail.headerEmpty && closedRail.railsFlush, JSON.stringify(closedRail));

  // Left pane stays editable while split.
  await w.locator('.pw-rail-right .sn-rail-peer', { hasText: 'B' }).click();
  await page.waitForTimeout(700);
  await w.locator('.pw-content-left .sn-render').click();
  check('left pane is the editable self pane', await w.locator('.pw-content-left textarea').count() === 1);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);

  // State colors in the rail: supersede B, freeze C (via API + widget refresh).
  const csrf = await page.evaluate(() => sessionStorage.getItem('csrf_token'));
  const bId = ids.sibs[0], cId = ids.sibs[1];
  const put = (id, state) => page.evaluate(async ({ id, state, csrf }) => {
    const r = await fetch(`api/variations/${id}/state`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({ state }),
    });
    return r.status;
  }, { id, state, csrf });
  check('supersede B via API', (await put(bId, 'superseded')) === 204);
  check('freeze C via API', (await put(cId, 'frozen')) === 204);
  // Reopen the pad so widget A re-reads sibling states.
  await page.click('#spm-close');
  await page.waitForSelector('.spm-overlay', { state: 'detached' });
  await page.evaluate((id) => window.WriteSysScratchpadModal.open(id), padId);
  await page.waitForSelector('.spm-editor .sn-widget .sn-rail');
  await page.waitForTimeout(600);
  const colors = await page.evaluate(() => {
    const w = document.querySelector('.sn-widget');
    const byLetter = {};
    w.querySelectorAll('.pw-rail-right .sn-rail-peer').forEach(b => { byLetter[b.textContent.trim()] = b.className; });
    return byLetter;
  });
  check('B rail letter reddish (superseded)', /st-superseded/.test(colors.B), colors.B);
  check('C rail letter bluish (frozen)', /st-frozen/.test(colors.C), colors.C);

  // The Related/Based-on picker EXCLUDES superseded variations (frozen stay).
  const picker = await page.evaluate(async () => {
    const r = await fetch('api/variations?q=');
    return (await r.json()).variations.map((x) => x.variation_id);
  });
  check('picker excludes superseded B', !picker.includes(bId), JSON.stringify(picker.slice(0, 8)));
  check('picker still includes frozen C', picker.includes(cId));

  // Wordcount: link the sketch to the test manuscript, make B the MOST RECENT
  // (but superseded) — the representative must skip it.
  await page.evaluate(async ({ sketch, bId, csrf, mid }) => {
    await fetch(`api/sketches/${sketch}/link`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({ manuscript_id: mid }),
    });
  }, { sketch: ids.sketch, bId, csrf, mid: TEST_MANUSCRIPT_ID });
  // B superseded → can't save text; flip to draft, give it 3 words (most
  // recent now), then supersede again.
  await put(bId, 'draft');
  await page.evaluate(async ({ bId, csrf }) => {
    await fetch(`api/variations/${bId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({ text: 'beta beta beta' }),
    });
  }, { bId, csrf });
  await put(bId, 'superseded');
  const wc = await page.evaluate(async ({ tok, mid }) => {
    await fetch('api/admin/wordcount-compute', { method: 'POST', headers: { Authorization: 'Bearer ' + tok } });
    const r = await fetch(`api/manuscripts/${mid}/wordcount-history`);
    const rows = (await r.json()).rows || [];
    return rows.length ? rows[rows.length - 1] : null;
  }, { tok: SYSTEM_TOKEN, mid: TEST_MANUSCRIPT_ID });
  check('wordcount computed', !!wc, JSON.stringify(wc));
  // A (10 words) represents the group — NOT superseded B (3 words, most recent).
  check('representative skips superseded B (10 words, not 3)',
    wc && wc.words_sketches === 10, `words_sketches=${wc && wc.words_sketches}`);

  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('Test crashed:', e); process.exit(1); });
