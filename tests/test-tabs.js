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

  // ---- pin a pad from the modal ----
  await ghostPad.click();
  await page.waitForSelector('.spm-overlay .ProseMirror', { timeout: 15000 });
  await page.fill('#spm-title', 'Tab pad');
  await page.click('#spm-pin');
  check('pad pin: tab appears with the pad title', await page.evaluate(() => {
    const t = document.querySelector('#ms-tabs .ms-tab-scratchpad .ms-tab-label');
    return !!t && t.textContent === 'Tab pad';
  }));
  check('pad pin: button reads pinned', await page.locator('#spm-pin.pinned').count() === 1);
  check('row claims layout (has-ms-tabs)', await page.evaluate(() =>
    document.documentElement.classList.contains('has-ms-tabs')));
  await page.keyboard.press('Escape');
  await page.waitForSelector('.spm-overlay', { state: 'detached', timeout: 10000 }).catch(() => {});

  // ---- persistence + click-to-open ----
  await page.reload();
  await page.waitForSelector('#ms-tabs .ms-tab-scratchpad', { timeout: 8000 });
  check('tab survives reload', true);
  await page.click('#ms-tabs .ms-tab-scratchpad');
  await page.waitForSelector('.spm-overlay .ProseMirror', { timeout: 15000 });
  check('clicking the pad tab opens the pad', true);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.spm-overlay', { state: 'detached', timeout: 10000 }).catch(() => {});

  // ---- book page: pin button in the strip ----
  await page.goto(TEST_URL);
  await waitForPagination(page);
  check('tab row rides along to the book page',
    await page.locator('#ms-tabs .ms-tab-scratchpad').count() === 1);
  await page.waitForSelector('#mc-pin', { timeout: 8000 });
  await page.click('#mc-pin');
  await page.waitForSelector('#ms-tabs .ms-tab-manuscript', { timeout: 8000 });
  check('book pin: manuscript tab appears, ACTIVE on its own page',
    await page.locator('#ms-tabs .ms-tab-manuscript.active').count() === 1);
  check('book pin button reads pinned', await page.locator('#mc-pin.pinned').count() === 1);

  // ---- pad tab opens the pad IN PLACE on the book page ----
  await page.click('#ms-tabs .ms-tab-scratchpad');
  await page.waitForSelector('.spm-overlay .ProseMirror', { timeout: 15000 });
  check('pad tab opens the pad over the book (no landing-page round trip)', true);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.spm-overlay', { state: 'detached', timeout: 10000 }).catch(() => {});

  // ---- manuscript tab navigates from home ----
  await page.goto(HOME_URL);
  await page.waitForSelector('#ms-tabs .ms-tab-manuscript', { timeout: 8000 });
  await page.click('#ms-tabs .ms-tab-manuscript');
  await page.waitForURL(/manuscript_id=/, { timeout: 15000 });
  check('manuscript tab navigates to the book', true);

  // ---- unpin via × ----
  await page.waitForSelector('#ms-tabs .ms-tab-scratchpad', { timeout: 8000 });
  await page.hover('#ms-tabs .ms-tab-scratchpad');
  await page.click('#ms-tabs .ms-tab-scratchpad .ms-tab-x');
  await page.hover('#ms-tabs .ms-tab-manuscript');
  await page.click('#ms-tabs .ms-tab-manuscript .ms-tab-x');
  check('unpinning everything hides the row',
    await page.locator('#ms-tabs[hidden]').count() === 1);
  check('…and releases the layout claim', await page.evaluate(() =>
    !document.documentElement.classList.contains('has-ms-tabs')));

  await page.evaluate(() => localStorage.removeItem('ms_pinned_tabs'));
  await browser.close();
  console.log(failed ? `\n❌ ${failed} check(s) failed` : '\n✅ Test passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('Test crashed:', e); process.exit(1); });
