// Stateful tabs e2e: home.html is the SHELL — every pin is a live iframe
// panel that stays mounted across tab flips (sentinels prove no reload).
// Manuscript cards open in place; pads pin from the modal into a panel;
// framed pages hide their own chrome (html.embedded); × destroys panels
// (after a pad save flush); the bar itself is permanent with an
// uncloseable Home. Plus the ghost-card restyle checks.
const { chromium } = require('playwright');
const { TEST_URL, loginAsTestUser } = require('./test-utils');
const HOME_URL = new URL('home.html', TEST_URL).href;

(async () => {
  console.log('=== stateful tabs e2e ===\n');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  let failed = 0;
  const check = (n, ok, extra) => {
    console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`);
    if (!ok) failed++;
  };

  await loginAsTestUser(page);
  await page.goto(HOME_URL);
  await page.evaluate(() => localStorage.removeItem('ms_pinned_tabs'));
  await page.reload();
  await page.waitForSelector('.card-ghost[data-ghost="scratchpad"]');

  // ---- permanent bar: Home alone, active, uncloseable ----
  await page.waitForSelector('#ms-tabs .ms-tab-home', { timeout: 8000 });
  check('no pins → bar shows Home alone, active, no ×', await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('#ms-tabs .ms-tab')];
    return tabs.length === 1 && tabs[0].classList.contains('ms-tab-home')
      && tabs[0].classList.contains('active') && !tabs[0].querySelector('.ms-tab-x');
  }));
  check('layout claim is permanent (has-ms-tabs)', await page.evaluate(() =>
    document.documentElement.classList.contains('has-ms-tabs')));

  // ---- ghost cards: translucent at rest, card face on hover ----
  const ghost = page.locator('.card-ghost[data-ghost="manuscript"]');
  const rest = await ghost.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, border: cs.borderTopStyle, label: el.textContent.trim() };
  });
  check('ghost at rest: translucent, dashed, + only',
    /rgba\(.*0\.35\)/.test(rest.bg) && rest.border === 'dashed' && rest.label === '+',
    JSON.stringify(rest));
  await ghost.hover();
  await page.waitForTimeout(250); // the + color transitions 120ms
  const hov = await ghost.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, topW: cs.borderTopWidth, topC: cs.borderTopColor,
      plus: getComputedStyle(el.querySelector('.ghost-plus')).color };
  });
  check('manuscript ghost hover: white face, brown lining, brown +',
    hov.bg === 'rgb(255, 255, 255)' && hov.topW === '4px'
    && hov.topC === 'rgb(87, 80, 63)' && hov.plus === 'rgb(87, 80, 63)', JSON.stringify(hov));

  // ---- manuscript card → LIVE PANEL in place (no navigation) ----
  await page.click('a.card-manuscript');
  await page.waitForSelector('#ms-tab-panels .ms-panel.active', { timeout: 15000 });
  check('manuscript card opens a panel; URL stays on the shell',
    page.url().includes('home.html') && /#tab=m\d+/.test(page.url()), page.url());
  check('manuscript tab active beside Home', await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('#ms-tabs .ms-tab')];
    return tabs.length === 2 && tabs[1].classList.contains('ms-tab-manuscript')
      && tabs[1].classList.contains('active');
  }));
  const mFrame = page.frames().find((f) => f.url().includes('manuscript_id'));
  check('panel iframe exists', !!mFrame);
  await mFrame.waitForSelector('.pagedjs_page', { timeout: 60000 });
  const emb = await mFrame.evaluate(() => ({
    embedded: document.documentElement.classList.contains('embedded'),
    controlsHidden: getComputedStyle(document.getElementById('controls')).display === 'none',
    pagesTop: Math.round(document.querySelector('.pagedjs_pages').getBoundingClientRect().top),
  }));
  check('framed book page hides its own chrome and sits flush',
    emb.embedded && emb.controlsHidden && emb.pagesTop >= 0 && emb.pagesTop < 20,
    JSON.stringify(emb));
  await mFrame.evaluate(() => { window.__sentinel = 'alive'; });

  // ---- flip Home ↔ manuscript: NOTHING reloads ----
  await page.click('#ms-tabs .ms-tab-home');
  await page.waitForFunction(() => document.getElementById('ms-tab-panels').hidden === true);
  check('Home tab hides the panel layer (landing intact beneath)',
    await page.locator('.card-ghost[data-ghost="scratchpad"]').count() === 1);
  await page.click('#ms-tabs .ms-tab-manuscript');
  await page.waitForSelector('#ms-tab-panels .ms-panel.active', { timeout: 8000 });
  check('manuscript kept its state across the flip (no reload)',
    (await mFrame.evaluate(() => window.__sentinel).catch(() => 'GONE')) === 'alive');

  // ---- pad: card → windowed modal; PIN → live panel ----
  await page.click('#ms-tabs .ms-tab-home');
  await page.click('.card-ghost[data-ghost="scratchpad"]');
  await page.waitForSelector('.spm-overlay .ProseMirror', { timeout: 15000 });
  check('unpinned pad is a windowed modal (no panel)', await page.evaluate(() =>
    !document.querySelector('#ms-tab-panels iframe[src*="pad.html"]')));
  await page.fill('#spm-title', 'Live pad');
  await page.locator('.spm-editor .ProseMirror').click();
  await page.keyboard.type('remember me');
  await page.click('#spm-pin');
  await page.waitForSelector('#ms-tab-panels iframe[src*="pad.html"].active', { timeout: 15000 });
  check('pin turns the modal into a live panel (modal gone)',
    await page.locator('.spm-overlay').count() === 0);
  const padFrame = page.frames().find((f) => f.url().includes('pad.html'));
  await padFrame.waitForSelector('.spm-editor .ProseMirror', { timeout: 20000 });
  check('panel carries the pad content (typed text survived the pin flush)',
    (await padFrame.evaluate(() => document.querySelector('.spm-editor .ProseMirror').textContent)).includes('remember me'));
  check('pad tab label from the title', await page.evaluate(() => {
    const t = document.querySelector('#ms-tabs .ms-tab-scratchpad .ms-tab-label');
    return !!t && t.textContent === 'Live pad';
  }));
  await padFrame.evaluate(() => { window.__padSentinel = 42; });

  // ---- flip between the two panels: both stay alive ----
  await page.click('#ms-tabs .ms-tab-manuscript');
  await page.waitForFunction(() =>
    !!document.querySelector('#ms-tab-panels .ms-panel.active[src*="manuscript_id"]'));
  check('manuscript still alive after pad detour',
    (await mFrame.evaluate(() => window.__sentinel).catch(() => 'GONE')) === 'alive');
  await page.click('#ms-tabs .ms-tab-scratchpad');
  await page.waitForFunction(() =>
    !!document.querySelector('#ms-tab-panels .ms-panel.active[src*="pad.html"]'));
  check('pad still alive after manuscript detour',
    (await padFrame.evaluate(() => window.__padSentinel).catch(() => 'GONE')) === 42);

  // ---- reload restores the ACTIVE tab (fresh panel, right place) ----
  await page.reload();
  await page.waitForSelector('#ms-tab-panels iframe[src*="pad.html"].active', { timeout: 15000 });
  check('reload restores the active pad tab from #tab=', true);
  check('tabs survived reload', await page.evaluate(() =>
    document.querySelectorAll('#ms-tabs .ms-tab').length === 3));

  // ---- × destroys the panel; active falls back to Home ----
  await page.hover('#ms-tabs .ms-tab-scratchpad');
  await page.click('#ms-tabs .ms-tab-scratchpad .ms-tab-x');
  await page.waitForFunction(() => !document.querySelector('#ms-tab-panels iframe[src*="pad.html"]'));
  check('× destroys the pad panel and its tab; Home takes over', await page.evaluate(() => {
    const active = document.querySelector('#ms-tabs .ms-tab.active');
    return document.querySelectorAll('#ms-tabs .ms-tab').length === 2
      && active && active.classList.contains('ms-tab-home')
      && document.getElementById('ms-tab-panels').hidden;
  }));
  await page.hover('#ms-tabs .ms-tab-manuscript');
  await page.click('#ms-tabs .ms-tab-manuscript .ms-tab-x');
  check('closing the last pin leaves the permanent bar with Home', await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('#ms-tabs .ms-tab')];
    return tabs.length === 1 && tabs[0].classList.contains('ms-tab-home')
      && !document.getElementById('ms-tabs').hidden
      && !document.querySelector('#ms-tab-panels iframe');
  }));

  // ---- standalone book page (old link): pins, and its tabs route to the shell ----
  await page.goto(TEST_URL);
  await page.waitForSelector('#ms-tabs .ms-tab-manuscript', { timeout: 30000 });
  check('standalone book visit auto-pins (bar present, manuscript active)',
    await page.evaluate(() => {
      const active = document.querySelector('#ms-tabs .ms-tab.active');
      return !!active && active.classList.contains('ms-tab-manuscript');
    }));
  await page.click('#ms-tabs .ms-tab-home');
  await page.waitForURL(/home\.html/, { timeout: 15000 });
  check('Home tab from a standalone page navigates to the shell', true);
  await page.waitForSelector('#ms-tabs .ms-tab-manuscript', { timeout: 8000 });
  await page.click('#ms-tabs .ms-tab-manuscript');
  await page.waitForSelector('#ms-tab-panels .ms-panel.active', { timeout: 15000 });
  check('manuscript tab in the shell opens the live panel (URL stays home)',
    page.url().includes('home.html'));

  await page.evaluate(() => localStorage.removeItem('ms_pinned_tabs'));
  await browser.close();
  console.log(failed ? `\n❌ ${failed} check(s) failed` : '\n✅ Test passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('Test crashed:', e); process.exit(1); });
