// Pinned tabs e2e: the row under the top bar (tabs.js) — pin a pad from
// the modal's pin button, pin the book from the strip's pin button, tabs
// persist (localStorage), navigate, unpin. Plus the ghost-card restyle:
// translucent at rest, real-card face with kind lining on hover.
const { chromium } = require('playwright');
const { TEST_URL, TEST_MANUSCRIPT_ID, loginAsTestUser, waitForPagination } = require('./test-utils');
const HOME_URL = new URL('home.html', TEST_URL).href;

(async () => {
  console.log('=== pinned tabs e2e ===\n');
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

  // ---- empty state: no row, no layout claim ----
  check('no pins → row hidden', await page.locator('#ms-tabs[hidden]').count() === 1);
  check('no pins → no layout claim (--tabs-h 0)', await page.evaluate(() =>
    !document.documentElement.classList.contains('has-ms-tabs')));

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
  const ghostPad = page.locator('.card-ghost[data-ghost="scratchpad"]');
  await ghostPad.hover();
  const hov2 = await ghostPad.evaluate((el) => getComputedStyle(el).borderTopColor);
  check('scratchpad ghost hover: blue lining', hov2 === 'rgb(42, 111, 176)', hov2);

  // ---- pin a pad from the modal: Home tab + fullscreen pad tab ----
  await ghostPad.click();
  await page.waitForSelector('.spm-overlay .ProseMirror', { timeout: 15000 });
  check('unpinned pad opens as a windowed modal',
    await page.locator('.spm-dialog.spm-full').count() === 0);
  await page.fill('#spm-title', 'Tab pad');
  await page.click('#spm-pin');
  check('pinning spawns TWO tabs: Home + the pad', await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('#ms-tabs .ms-tab')];
    return tabs.length === 2 && tabs[0].classList.contains('ms-tab-home')
      && tabs[1].classList.contains('ms-tab-scratchpad')
      && tabs[1].querySelector('.ms-tab-label').textContent === 'Tab pad';
  }));
  check('Home tab has no ×; pad tab has one', await page.evaluate(() => {
    const [home, pad] = document.querySelectorAll('#ms-tabs .ms-tab');
    return !home.querySelector('.ms-tab-x') && !!pad.querySelector('.ms-tab-x');
  }));
  check('pinned pad goes fullscreen', await page.locator('.spm-dialog.spm-full').count() === 1);
  check('pad tab is the active one', await page.evaluate(() => {
    const active = document.querySelector('#ms-tabs .ms-tab.active');
    return !!active && active.classList.contains('ms-tab-scratchpad');
  }));
  check('pad pin: button reads pinned', await page.locator('#spm-pin.pinned').count() === 1);
  check('row claims layout (has-ms-tabs)', await page.evaluate(() =>
    document.documentElement.classList.contains('has-ms-tabs')));

  // ---- Home tab: back to the landing page (closes the pad) ----
  await page.click('#ms-tabs .ms-tab-home');
  await page.waitForSelector('.spm-overlay', { state: 'detached', timeout: 10000 });
  check('Home tab closes the pad and takes the active state', await page.evaluate(() => {
    const active = document.querySelector('#ms-tabs .ms-tab.active');
    return !!active && active.classList.contains('ms-tab-home');
  }));

  // ---- persistence + click-to-open (fullscreen since pinned) ----
  await page.reload();
  await page.waitForSelector('#ms-tabs .ms-tab-scratchpad', { timeout: 8000 });
  check('tabs survive reload', true);
  await page.click('#ms-tabs .ms-tab-scratchpad');
  await page.waitForSelector('.spm-overlay .ProseMirror', { timeout: 15000 });
  check('pad tab reopens the pad FULLSCREEN',
    await page.locator('.spm-dialog.spm-full').count() === 1);
  // Re-opening the pad that's already showing is a FOCUS: same editor, no
  // teardown (card clicks and tab clicks converge here).
  check('re-opening the open pad focuses, not reloads', await page.evaluate(async () => {
    const overlay = document.querySelector('.spm-overlay');
    overlay.dataset.probe = 'kept';
    await window.WriteSysScratchpadModal.open(
      JSON.parse(localStorage.getItem('ms_pinned_tabs'))[0].id);
    const now = document.querySelector('.spm-overlay');
    return now === overlay && now.dataset.probe === 'kept';
  }));
  await page.keyboard.press('Escape');
  await page.waitForSelector('.spm-overlay', { state: 'detached', timeout: 10000 }).catch(() => {});

  // ---- second pad: pinning appends a third tab ----
  await page.click('.card-ghost[data-ghost="scratchpad"]');
  await page.waitForSelector('.spm-overlay .ProseMirror', { timeout: 15000 });
  await page.fill('#spm-title', 'Second pad');
  await page.click('#spm-pin');
  check('second pin appends a third tab', await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('#ms-tabs .ms-tab')];
    return tabs.length === 3
      && tabs[2].querySelector('.ms-tab-label').textContent === 'Second pad'
      && tabs[2].classList.contains('active');
  }));
  // × on the OPEN pad's tab closes pad + tab together.
  await page.hover('#ms-tabs .ms-tab:nth-child(3)');
  await page.click('#ms-tabs .ms-tab:nth-child(3) .ms-tab-x');
  await page.waitForSelector('.spm-overlay', { state: 'detached', timeout: 10000 });
  check('× on the open pad tab closes the pad and drops the tab', await page.evaluate(() =>
    document.querySelectorAll('#ms-tabs .ms-tab').length === 2));

  // ---- book page: auto-pin joins the row after Home ----
  await page.goto(TEST_URL);
  await waitForPagination(page);
  await page.waitForSelector('#ms-tabs .ms-tab-manuscript', { timeout: 8000 });
  check('book page row: Home, pad, manuscript (active)', await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('#ms-tabs .ms-tab')];
    return tabs.length === 3 && tabs[0].classList.contains('ms-tab-home')
      && tabs[1].classList.contains('ms-tab-scratchpad')
      && tabs[2].classList.contains('ms-tab-manuscript')
      && tabs[2].classList.contains('active');
  }));
  await page.waitForSelector('#mc-pin.pinned', { timeout: 8000 });
  check('book pin button reads pinned', true);
  await page.waitForFunction(() => {
    const t = document.querySelector('#ms-tabs .ms-tab-manuscript .ms-tab-label');
    return !!t && t.textContent.length > 0 && t.textContent !== 'Manuscript';
  }, null, { timeout: 10000 });
  check('tab label follows the async display name', true);

  // ---- pad tab over the book: fullscreen, active flips, close restores ----
  await page.click('#ms-tabs .ms-tab-scratchpad');
  await page.waitForSelector('.spm-overlay .ProseMirror', { timeout: 15000 });
  check('pad tab opens fullscreen over the book, pad tab active', await page.evaluate(() =>
    !!document.querySelector('.spm-dialog.spm-full')
    && document.querySelector('#ms-tabs .ms-tab.active').classList.contains('ms-tab-scratchpad')));
  await page.keyboard.press('Escape');
  await page.waitForSelector('.spm-overlay', { state: 'detached', timeout: 10000 });
  check('closing the pad re-activates the manuscript tab', await page.evaluate(() =>
    document.querySelector('#ms-tabs .ms-tab.active').classList.contains('ms-tab-manuscript')));

  // ---- Home tab navigates off the book page ----
  await page.click('#ms-tabs .ms-tab-home');
  await page.waitForURL(/home\.html/, { timeout: 15000 });
  await page.waitForSelector('#ms-tabs .ms-tab-home.active', { timeout: 8000 });
  check('Home tab navigates to the landing page and is active', true);

  // ---- manuscript tab navigates from home ----
  await page.click('#ms-tabs .ms-tab-manuscript');
  await page.waitForURL(/manuscript_id=/, { timeout: 15000 });
  check('manuscript tab navigates to the book', true);

  // ---- × on the manuscript you're reading → back to the landing page ----
  await page.waitForSelector('#ms-tabs .ms-tab-manuscript', { timeout: 8000 });
  await page.hover('#ms-tabs .ms-tab-manuscript');
  await page.click('#ms-tabs .ms-tab-manuscript .ms-tab-x');
  await page.waitForURL(/home\.html/, { timeout: 15000 });
  check('closing the current book tab lands on the landing page', true);
  await page.waitForSelector('#ms-tabs .ms-tab-scratchpad', { timeout: 8000 });
  await page.hover('#ms-tabs .ms-tab-scratchpad');
  await page.click('#ms-tabs .ms-tab-scratchpad .ms-tab-x');
  check('closing the last pin hides the row (Home goes with it)',
    await page.locator('#ms-tabs[hidden]').count() === 1);
  check('…and releases the layout claim', await page.evaluate(() =>
    !document.documentElement.classList.contains('has-ms-tabs')));

  await page.evaluate(() => localStorage.removeItem('ms_pinned_tabs'));
  await browser.close();
  console.log(failed ? `\n❌ ${failed} check(s) failed` : '\n✅ Test passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('Test crashed:', e); process.exit(1); });
