// With >8 sketches in a snippet group, the tab bar collapses the overflow into
// a ▾ dropdown. The list must start CLOSED (a display:flex rule used to
// override [hidden] — permanently open), open on ▾ click, close when picking a
// sketch from it, and close on an outside click.
const { chromium } = require('playwright');
const { TEST_URL, loginAsTestUser } = require('./test-utils');
const HOME_URL = new URL('home.html', TEST_URL).href;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('dialog', d => d.accept());
  let failed = false;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed = true; };

  await loginAsTestUser(page);
  await page.goto(HOME_URL);
  await page.waitForSelector('#home-new-pad'); await page.click('#home-new-pad');
  await page.waitForSelector('.spm-overlay .ProseMirror');
  await page.locator('.spm-editor .ProseMirror').click();

  // One snippet + 9 related sketches → 10 tabs → overflow dropdown appears.
  await page.evaluate(async () => {
    const ed = window.WriteSysScratchpad;
    const ctx = await ed.insertSnippet();
    for (let i = 0; i < 9; i++) await ed.sketchApi.createFrom(ctx.sketch.sketch_id);
  });
  // Rebuild the widget with the full sibling list (refresh happens on group
  // changes in the UI; here just reopen the pad).
  const padId = await page.evaluate(() => window.WriteSysScratchpad.scratchpadId);
  await page.click('#spm-close');
  await page.waitForSelector('.spm-overlay', { state: 'detached' });
  await page.evaluate((id) => window.WriteSysScratchpadModal.open(id), padId);
  await page.waitForSelector('.spm-editor .sn-widget .sn-tab-more', { timeout: 10000 });

  const vis = () => page.evaluate(() => {
    const l = document.querySelector('.sn-more-list');
    return l ? getComputedStyle(l).display !== 'none' : null;
  });

  check('dropdown starts closed', (await vis()) === false, `visible=${await vis()}`);

  await page.click('.sn-more-btn');
  check('▾ click opens it', (await vis()) === true);

  // Picking a sketch from the list closes it (and switches the tab).
  await page.locator('.sn-more-list button[data-tab]').first().click();
  await page.waitForTimeout(400);
  check('picking a sketch closes it', (await vis()) === false);

  await page.click('.sn-more-btn');
  check('reopens', (await vis()) === true);
  const box = await page.locator('.spm-editor').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height - 30);
  await page.waitForTimeout(200);
  check('outside click closes it', (await vis()) === false);

  console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS');
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('Test crashed:', e); process.exit(1); });
