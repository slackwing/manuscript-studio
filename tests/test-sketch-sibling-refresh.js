// Regression: adding a new related sketch must update the tab bar of the
// EXISTING sibling widgets immediately (not only after a reload). Previously
// insertSketchOf/insertVariation placed the new widget but didn't refresh the
// live siblings, so their "Related:" tab list was stale.
const { chromium } = require('playwright');
const { TEST_URL, cleanupTestAnnotations, loginAsTestUser } = require('./test-utils');
const HOME_URL = new URL('home.html', TEST_URL).href;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.on('dialog', d => d.accept());
  let failed = false;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed = true; };

  await cleanupTestAnnotations();
  await loginAsTestUser(page);
  await page.goto(HOME_URL);
  await page.waitForSelector('#home-new-pad'); await page.click('#home-new-pad');
  await page.waitForSelector('.spm-overlay .ProseMirror');

  // A: a fresh snippet (sketch A). B: a sibling of A. Now two widgets exist.
  const ctxA = await page.evaluate(() => window.WriteSysScratchpad.insertSnippet());
  const varA = ctxA.sketch.sketch_id;
  await page.waitForSelector(`.sn-widget[data-sketch-id="${varA}"]`);
  const ctxB = await page.evaluate((src) => window.WriteSysScratchpad.insertSketchOf(src), varA);
  const varB = ctxB.sketch.sketch_id;
  await page.waitForFunction(() => document.querySelectorAll('.sn-widget').length === 2);

  // How many sibling (peer) tabs does widget A show right now? (B should be one.)
  const tabsBefore = await page.evaluate((vid) =>
    document.querySelector(`.sn-widget[data-sketch-id="${vid}"]`)
      .querySelectorAll('.sn-tab-peer').length, varA);
  check('widget A shows B as a related tab', tabsBefore >= 1, `peers=${tabsBefore}`);

  // Add C as another sibling (from A). Widget A must now show BOTH B and C
  // without any reload.
  const ctxC = await page.evaluate((src) => window.WriteSysScratchpad.insertSketchOf(src), varA);
  const varC = ctxC.sketch.sketch_id;
  await page.waitForFunction(() => document.querySelectorAll('.sn-widget').length === 3);
  await page.waitForTimeout(400); // let the sibling refresh settle

  const tabsAfter = await page.evaluate((vid) =>
    document.querySelector(`.sn-widget[data-sketch-id="${vid}"]`)
      .querySelectorAll('.sn-tab-peer').length, varA);
  check('widget A gained C as a related tab immediately (no reload)',
    tabsAfter >= 2, `peers before=${tabsBefore} after=${tabsAfter}`);

  // And widget B should also show C (and A) — every sibling stays in sync.
  const tabsB = await page.evaluate((vid) =>
    document.querySelector(`.sn-widget[data-sketch-id="${vid}"]`)
      .querySelectorAll('.sn-tab-peer').length, varB);
  check('widget B also shows the two other siblings', tabsB >= 2, `peers=${tabsB}`);

  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
