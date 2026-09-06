// Split-pane e2e (SPLIT_PANE_PLAN.md): the shell splits its panel area into
// two panes with a tab bar each. Split button eligibility; splitting moves
// the focused tab right and the left pane shows its next most recent;
// panels NEVER reload on a pane move (sentinels); each pane is its own
// iframe viewport so the 1239px mobile breakpoint fires per pane; tabs
// drag between bars; the last right tab leaving (drag or ×) collapses the
// split; the layout survives reload; the divider drags and persists.
const { chromium } = require('playwright');
const { TEST_URL, loginAsTestUser, cleanupTestAnnotations } = require('./test-utils');
const HOME_URL = new URL('home.html', TEST_URL).href;

(async () => {
  console.log('=== split pane e2e ===\n');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  let failed = 0;
  const check = (n, ok, extra) => {
    console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`);
    if (!ok) failed++;
  };
  const splitState = () => page.evaluate(() => JSON.parse(localStorage.getItem('ms_split') || '{}'));
  const barKeys = (side) => page.evaluate((s) =>
    [...document.querySelectorAll(`.ms-tabbar-${s} .ms-tab[data-key]`)].map((t) => t.dataset.key), side);
  // Native HTML5 DnD, dispatched by hand (Playwright has no dataTransfer
  // plumbing): dragstart on the tab, dragover on the destination bar's
  // empty area (→ append), dragend commits from the DOM.
  const dragTabToBar = (key, side) => page.evaluate(({ key, side }) => {
    const tab = document.querySelector(`.ms-tab[data-key="${key}"]`);
    const bar = document.querySelector(`.ms-tabbar-${side}`);
    const dt = new DataTransfer();
    tab.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    bar.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }));
    bar.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
    tab.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
  }, { key, side });

  await cleanupTestAnnotations();
  await loginAsTestUser(page);
  await page.goto(HOME_URL);
  await page.evaluate(() => { localStorage.removeItem('ms_pinned_tabs'); localStorage.removeItem('ms_split'); sessionStorage.removeItem('ms_split_session'); });
  await page.reload();
  await page.waitForSelector('a.card-manuscript', { timeout: 15000 });

  // ---- seed: manuscript panel + two API pads ----
  await page.click('a.card-manuscript');
  await page.waitForSelector('#ms-tab-panels .ms-panel.active', { timeout: 15000 });
  const mKey = await page.evaluate(() => JSON.parse(localStorage.getItem('ms_pinned_tabs')).map((p) => p.type[0] + p.id)[0]);

  check('two tabs (Home + manuscript) → split button disabled',
    await page.evaluate(() => document.getElementById('ms-split-btn').disabled));

  const pads = await page.evaluate(async () => {
    const csrf = (localStorage.getItem('csrf_token') || sessionStorage.getItem('csrf_token')) || '';
    const H = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf };
    const a = (await (await fetch('api/scratchpads', { method: 'POST', headers: H, body: JSON.stringify({ title: 'split pad A' }) })).json()).scratchpad_id;
    const b = (await (await fetch('api/scratchpads', { method: 'POST', headers: H, body: JSON.stringify({ title: 'split pad B' }) })).json()).scratchpad_id;
    return { a, b };
  });
  await page.evaluate(({ a, b }) => {
    window.WriteSysTabs.openPad(a, 'split pad A');
    window.WriteSysTabs.openPad(b, 'split pad B');
  }, pads);
  const keyA = 's' + pads.a, keyB = 's' + pads.b;
  await page.waitForSelector(`#ms-tab-panels iframe[src*="scratchpad_id=${pads.b}"].active`, { timeout: 15000 });

  check('home tab focused → split button disabled even with 3 pins', await page.evaluate(() => {
    document.querySelector('#ms-tabs .ms-tab-home').click();
    return document.getElementById('ms-split-btn').disabled;
  }));
  await page.evaluate((k) => document.querySelector(`.ms-tab[data-key="${k}"]`).click(), keyB);
  check('pin focused with ≥2 pins → split button enabled',
    await page.evaluate(() => !document.getElementById('ms-split-btn').disabled));

  // ---- split: focused tab moves right, next most recent stays left ----
  const frameB = page.frames().find((f) => f.url().includes('scratchpad_id=' + pads.b));
  await frameB.waitForSelector('.spm-editor .ProseMirror', { timeout: 20000 });
  await frameB.evaluate(() => { window.__sentinelB = 'alive'; });
  await page.click('#ms-split-btn');
  await page.waitForSelector('#ms-tabs.split', { timeout: 8000 });
  check('split → two bars; focused tab went right; pad A (next most recent) left-active',
    JSON.stringify(await barKeys('right')) === JSON.stringify([keyB])
    && await page.evaluate((k) =>
      document.querySelector(`.ms-tabbar-left .ms-tab[data-key="${k}"]`).classList.contains('active'), keyA));
  check('two live panels, geometry split at 50vw', await page.evaluate(() => {
    const vis = [...document.querySelectorAll('#ms-tab-panels .ms-panel.active')];
    if (vis.length !== 2) return false;
    const [l, r] = vis[0].classList.contains('pane-right') ? [vis[1], vis[0]] : [vis[0], vis[1]];
    // r.right must reach the viewport edge — width:auto on an iframe
    // collapses to its intrinsic 300px (replaced element), which once
    // shipped a 300px right pane. Assert the full box, not just the seam.
    return Math.abs(l.getBoundingClientRect().width - 800) < 3
      && Math.abs(r.getBoundingClientRect().left - 800) < 3
      && Math.abs(r.getBoundingClientRect().right - 1600) < 3;
  }));
  check('no reload on split (sentinel survived)',
    (await frameB.evaluate(() => window.__sentinelB).catch(() => 'GONE')) === 'alive');
  check('right pane is focused after split; left bar dims its active tab',
    await page.evaluate(() =>
      document.querySelector('.ms-tabbar-right').classList.contains('focused')
      && document.querySelector('.ms-tabbar-left').classList.contains('unfocused')));

  // ---- per-pane mobile mode: 800px pane < 1239px breakpoint ----
  await page.evaluate((k) => document.querySelector(`.ms-tab[data-key="${k}"]`).click(), mKey);
  const mFrame = page.frames().find((f) => f.url().includes('manuscript_id'));
  await mFrame.waitForSelector('.pagedjs_page', { timeout: 60000 });
  check('manuscript pane at ~800px sees ITSELF as mobile (iframe = viewport)',
    await mFrame.evaluate(() =>
      window.innerWidth < 1240 && window.matchMedia('(max-width: 1239px)').matches));

  // ---- reload: layout survives ----
  await page.reload();
  await page.waitForSelector('#ms-tabs.split', { timeout: 15000 });
  check('reload restores the split (right set + both panes live)',
    JSON.stringify(await barKeys('right')) === JSON.stringify([keyB])
    && await page.evaluate(() => document.querySelectorAll('#ms-tab-panels .ms-panel.active').length === 2));
  check('divider present after reload', await page.locator('#ms-split-divider').count() === 1);

  // ---- divider drag persists; dblclick resets ----
  await page.dispatchEvent('#ms-split-divider', 'pointerdown', { pointerId: 7, clientX: 800, clientY: 500 });
  await page.dispatchEvent('#ms-split-divider', 'pointermove', { pointerId: 7, clientX: 1100, clientY: 500 });
  await page.dispatchEvent('#ms-split-divider', 'pointerup', { pointerId: 7, clientX: 1100, clientY: 500 });
  const pct = (await splitState()).dividerPct;
  check('divider drag → dividerPct persisted (~68.75)', Math.abs(pct - 68.75) < 1, String(pct));
  await page.dispatchEvent('#ms-split-divider', 'dblclick');
  check('divider dblclick → back to 50/50', Math.abs((await splitState()).dividerPct - 50) < 0.01);

  // ---- Home in the left pane: landing stays interactive beside the pane ----
  await page.click('#ms-tabs .ms-tab-home');
  await page.waitForSelector('#ms-tab-panels.split.home-left', { timeout: 8000 });
  check('Home on the left: host shrinks right, landing clickable, right pane intact',
    await page.evaluate(() => {
      const host = document.getElementById('ms-tab-panels');
      const el = document.elementFromPoint(200, 400); // left region → landing page
      return !host.hidden && Math.abs(host.getBoundingClientRect().left - 800) < 3
        && !host.contains(el)
        && document.querySelectorAll('#ms-tab-panels .ms-panel.active').length === 1;
    }));

  // ---- duplicates: reopening an open pad focuses it, no second pin ----
  await page.evaluate((id) => window.WriteSysTabs.openPad(id, 'split pad B'), pads.b);
  check('reopening an open doc adds no pin; focuses its pane', await page.evaluate(() =>
    JSON.parse(localStorage.getItem('ms_pinned_tabs')).length === 3
    && document.querySelector('.ms-tabbar-right').classList.contains('focused')));

  // ---- drag across bars: move without reload ----
  // (Panels are lazy — pad A has no frame since the reload until activated;
  // pad B's frame + sentinel from before the reload are gone, re-arm both.)
  await page.evaluate((k) => document.querySelector(`.ms-tab[data-key="${k}"]`).click(), keyA);
  await page.waitForSelector(`#ms-tab-panels iframe[src*="scratchpad_id=${pads.a}"].active`, { timeout: 15000 });
  const frameA = page.frames().find((f) => f.url().includes('scratchpad_id=' + pads.a));
  const frameB2 = page.frames().find((f) => f.url().includes('scratchpad_id=' + pads.b));
  await frameB2.waitForSelector('.spm-editor .ProseMirror', { timeout: 20000 });
  await frameB2.evaluate(() => { window.__sentinelB = 'alive'; });
  await frameA.waitForSelector('.spm-editor .ProseMirror', { timeout: 20000 });
  await frameA.evaluate(() => { window.__sentinelA = 'alive'; });
  await dragTabToBar(keyA, 'right');
  await page.waitForFunction((k) =>
    [...document.querySelectorAll('.ms-tabbar-right .ms-tab[data-key]')].some((t) => t.dataset.key === k), keyA);
  check('dragged pad A to the right bar; it becomes right-active; no reload',
    await page.evaluate((k) =>
      document.querySelector(`.ms-tabbar-right .ms-tab[data-key="${k}"]`).classList.contains('active'), keyA)
    && (await frameA.evaluate(() => window.__sentinelA).catch(() => 'GONE')) === 'alive');

  // ---- last right tab dragged left → split collapses, nothing reloads ----
  await dragTabToBar(keyA, 'left');
  await dragTabToBar(keyB, 'left');
  await page.waitForFunction(() => !document.querySelector('#ms-tabs.split'));
  check('last right tab moved over → split closes; one bar, no divider', await page.evaluate(() =>
    document.querySelectorAll('.ms-tabbar').length === 1
    && !document.getElementById('ms-split-divider')
    && JSON.parse(localStorage.getItem('ms_split')).right.length === 0));
  check('both pads alive through every move (never reloaded)',
    (await frameA.evaluate(() => window.__sentinelA).catch(() => 'GONE')) === 'alive'
    && (await frameB2.evaluate(() => window.__sentinelB).catch(() => 'GONE')) === 'alive');

  // ---- × on the last right tab also collapses the split ----
  await page.evaluate((k) => document.querySelector(`.ms-tab[data-key="${k}"]`).click(), keyB);
  await page.click('#ms-split-btn');
  await page.waitForSelector('#ms-tabs.split', { timeout: 8000 });
  await page.hover(`.ms-tabbar-right .ms-tab[data-key="${keyB}"]`);
  await page.click(`.ms-tabbar-right .ms-tab[data-key="${keyB}"] .ms-tab-x`);
  await page.waitForFunction(() => !document.querySelector('#ms-tabs.split'));
  check('× on the last right tab → split closes, pin gone', await page.evaluate(() =>
    JSON.parse(localStorage.getItem('ms_pinned_tabs')).length === 2
    && JSON.parse(localStorage.getItem('ms_split')).right.length === 0));

  await page.evaluate(() => { localStorage.removeItem('ms_pinned_tabs'); localStorage.removeItem('ms_split'); sessionStorage.removeItem('ms_split_session'); });
  await cleanupTestAnnotations();
  await browser.close();
  console.log(failed ? `\n❌ ${failed} check(s) failed` : '\n✅ Test passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('Test crashed:', e); process.exit(1); });
