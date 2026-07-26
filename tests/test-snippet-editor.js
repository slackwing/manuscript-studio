/**
 * Snippet editor literal-editing behaviors: Tab inserts \t (Shift-Tab escapes),
 * auto-grow (no internal scroll), and the grey → tab-marker overlay aligns with
 * the textarea's tabs. Drives the real scratchpad modal on dev.
 */
const { chromium } = require('playwright');
const { TEST_URL, cleanupTestAnnotations, loginAsTestUser } = require('./test-utils');
const HOME_URL = new URL('home.html', TEST_URL).href;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  let failed = false;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed = true; };

  await cleanupTestAnnotations();
  await loginAsTestUser(page);
  await page.goto(HOME_URL);
  // Create a pad (opens the modal), insert a snippet, flip into the editor.
  await page.waitForSelector('#home-new-pad', { timeout: 20000 });
  await page.click('#home-new-pad');
  await page.waitForSelector('.spm-overlay .ProseMirror', { timeout: 20000 });
  await page.evaluate(() => window.WriteSysScratchpad.insertSnippet());
  await page.waitForSelector('.sn-widget .sn-render', { timeout: 10000 });
  await page.click('.sn-widget .sn-render');
  await page.waitForSelector('.sn-widget .sn-text', { timeout: 5000 });
  const ta = page.locator('.sn-widget .sn-text').first();

  // 1. Tab inserts a real \t at the caret (not focus change).
  await ta.click();
  await ta.fill('east coasters');
  await ta.press('End');
  await ta.press('Enter');
  await ta.press('Tab');
  await ta.type('yeah well adrian');
  const val = await ta.inputValue();
  check('Tab inserts \\t (\\n\\t present)', val.includes('east coasters\n\tyeah well adrian'), JSON.stringify(val));

  // 2. Shift-Tab escapes (blurs the textarea).
  await ta.press('Shift+Tab');
  await page.waitForTimeout(200);
  const stillFocused = await page.evaluate(() => document.activeElement && document.activeElement.classList.contains('sn-text'));
  check('Shift+Tab escapes the field', stillFocused === false);

  // Re-enter edit for geometry checks.
  await page.click('.sn-widget .sn-render');
  await page.waitForSelector('.sn-widget .sn-text', { timeout: 5000 });
  const ta2 = page.locator('.sn-widget .sn-text').first();

  // 3. Never scrolls internally: scrollHeight <= clientHeight (auto-grown).
  const geo = await ta2.evaluate(el => ({ sh: el.scrollHeight, ch: el.clientHeight, overflow: getComputedStyle(el).overflowY }));
  check('editor auto-grew (no internal scroll)', geo.sh <= geo.ch + 2, JSON.stringify(geo));

  // 4. Overlay renders a → marker per tab, and aligns near the textarea tab.
  const overlay = await page.evaluate(() => {
    const o = document.querySelector('.sn-widget .sn-text-overlay');
    if (!o) return null;
    const tabs = o.querySelectorAll('.sn-tab');
    const before = tabs.length ? getComputedStyle(tabs[0], '::before').content : '';
    return { markers: tabs.length, arrow: before };
  });
  check('overlay has a tab marker', overlay && overlay.markers >= 1, JSON.stringify(overlay));
  check('marker draws → glyph', overlay && /→|2192|→/.test(overlay.arrow), JSON.stringify(overlay && overlay.arrow));

  const fs = require('fs');
  if (!fs.existsSync('tests/screenshots')) fs.mkdirSync('tests/screenshots', { recursive: true });
  await page.screenshot({ path: 'tests/screenshots/snippet-editor.png' });
  console.log('📸 tests/screenshots/snippet-editor.png');

  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
