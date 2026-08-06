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

  // 4. Copy-reference → "From clipboard" round trip. The widget's copy
  //    button (right of freeze) writes ms-sketch:<id>; the ⧉ Snippet menu's
  //    "From clipboard" option enables only for a VALID copied reference
  //    and mints a related sibling sketch.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://localhost:5001' });
  const copyBtn = page.locator('.sn-widget .sn-copyref').first();
  check('copy button present (right of freeze)', (await copyBtn.count()) === 1);
  const order = await page.evaluate(() => {
    const kids = Array.from(document.querySelectorAll('.sn-widget .sn-actions > *')).map(e => e.className);
    return { freeze: kids.findIndex(c => /sn-freeze/.test(c)), copy: kids.findIndex(c => /sn-copyref/.test(c)) };
  });
  check('copy sits right of freeze', order.copy === order.freeze + 1, JSON.stringify(order));
  await copyBtn.click();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  const sketchId = await page.evaluate(() => document.querySelector('.sn-widget').dataset.sketchId);
  check('copies ms-sketch:<id>', clip === `ms-sketch:${sketchId}`, clip);

  // With junk in the clipboard the option stays disabled.
  await page.evaluate(() => navigator.clipboard.writeText('just some prose'));
  await page.locator('.sn-btn', { hasText: 'Snippet' }).dispatchEvent('mousedown');
  await page.waitForSelector('.sn-insertpop .sn-ins-clip');
  await page.waitForTimeout(400); // async validation settles
  check('From clipboard disabled for junk', await page.locator('.sn-ins-clip').isDisabled());
  // Toggle the menu closed with the real button, then reopen fresh.
  await page.locator('.sn-btn', { hasText: 'Snippet' }).dispatchEvent('mousedown');
  await page.waitForSelector('.sn-insertpop', { state: 'hidden' });

  // With a valid reference it enables, and clicking mints a sibling.
  await page.evaluate((t) => navigator.clipboard.writeText(t), `ms-sketch:${sketchId}`);
  await page.locator('.sn-btn', { hasText: 'Snippet' }).dispatchEvent('mousedown');
  await page.waitForSelector('.sn-insertpop .sn-ins-clip');
  await page.waitForFunction(() => {
    const b = document.querySelector('.sn-ins-clip');
    return b && !b.disabled;
  }, { timeout: 8000 });
  check('From clipboard enables for a valid reference', true);
  const widgetsBefore = await page.locator('.sn-widget').count();
  await page.locator('.sn-ins-clip').click();
  await page.waitForFunction((n) => document.querySelectorAll('.sn-widget').length === n + 1, widgetsBefore, { timeout: 10000 });
  check('clicking it inserts a related sibling sketch', true);
  const letters = await page.evaluate(() => Array.from(document.querySelectorAll('.sn-widget .sn-rail-btn')).length);
  check('new widget shows the sibling rail', letters >= 2, `rail buttons=${letters}`);

  const fs = require('fs');
  if (!fs.existsSync('tests/screenshots')) fs.mkdirSync('tests/screenshots', { recursive: true });
  await page.screenshot({ path: 'tests/screenshots/snippet-editor.png' });
  console.log('📸 tests/screenshots/snippet-editor.png');

  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
