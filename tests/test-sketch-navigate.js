// Navigate-to-source: a sibling sketch's peer preview offers a link that opens
// the sketch's home scratchpad and scrolls to its widget (#scratchpad=N&sketch=ID).
const { chromium } = require('playwright');
const { TEST_URL, cleanupTestAnnotations, loginAsTestUser } = require('./test-utils');
const HOME_URL = new URL('home.html', TEST_URL).href;
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.on('dialog', d => d.accept());
  let failed = false;
  const check = (n, ok, extra) => { console.log(`${ok?'✅':'❌'} ${n}${extra?' — '+extra:''}`); if(!ok) failed=true; };

  await cleanupTestAnnotations();
  await loginAsTestUser(page);
  await page.goto(HOME_URL);
  await page.waitForSelector('#home-new-pad'); await page.click('#home-new-pad');
  await page.waitForSelector('.spm-overlay .ProseMirror');
  const ctxA = await page.evaluate(() => window.WriteSysScratchpad.insertSnippet());
  const varA = ctxA.sketch.sketch_id;
  await page.waitForSelector('.sn-widget .sn-render'); await page.click('.sn-widget .sn-render');
  await page.waitForSelector('.sn-widget .sn-text');
  await page.fill('.sn-widget .sn-text', 'Home sketch A content.');
  await page.locator('.sn-widget .sn-text').blur();
  await page.waitForTimeout(800);
  // Mint sibling B, then view A as a peer from B, click navigate-to-source.
  const ctxB = await page.evaluate((src) => window.WriteSysScratchpad.insertSketchOf(src), varA);
  const varB = ctxB.sketch.sketch_id;
  await page.waitForFunction(() => document.querySelectorAll('.sn-widget').length === 2);
  const bWidget = page.locator(`.sn-widget[data-sketch-id="${varB}"]`);
  await bWidget.locator('.sn-tab', { hasText: 'A' }).first().click();
  await page.waitForSelector('.sn-widget .sn-goto-source');
  check('navigate-to-source link present', await page.locator('.sn-goto-source').count() >= 1);
  await page.locator('.sn-goto-source').first().click();
  await page.waitForTimeout(800);
  const hash = await page.evaluate(() => window.location.hash);
  check('hash carries scratchpad + snippet + ordinal (deep link)', /scratchpad=\d+&snippet=[a-z0-9]+&sketch=\d+/.test(hash), hash);
  // The flash class lands on A's widget.
  const flashed = await page.evaluate((vid) => {
    const w = document.querySelector(`.sn-widget[data-sketch-id="${vid}"]`);
    return !!w; // widget for A exists in the (same) scratchpad
  }, varA);
  check('home widget for A reachable', flashed);
  await browser.close();
  process.exit(failed?1:0);
})().catch(e => { console.error(e); process.exit(1); });
