// Regression: interacting with a sketch widget (click-to-edit, freeze, tab
// switch) must NOT scroll the pad back to the top of the widget. Root cause was
// DOM rebuilds + textarea focus re-anchoring scroll; fixed by preserveScroll +
// focus({preventScroll:true}).
//
// NOTE: headless Chromium doesn't always exhibit the focus/rebuild scroll jump
// that real browsers do, so the scroll checks below may pass even without the
// fix — they still catch a REGRESSION that jumps headlessly too (e.g. an
// accidental scrollIntoView). The frozen-background check has full teeth.
const { chromium } = require('playwright');
const { TEST_URL, cleanupTestAnnotations, loginAsTestUser } = require('./test-utils');
const HOME_URL = new URL('home.html', TEST_URL).href;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 700 } });
  page.on('dialog', d => d.accept());
  let failed = false;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed = true; };

  await cleanupTestAnnotations();
  await loginAsTestUser(page);
  await page.goto(HOME_URL);
  await page.waitForSelector('#home-new-pad'); await page.click('#home-new-pad');
  await page.waitForSelector('.spm-overlay .ProseMirror');

  // Type enough lines ABOVE the sketch that the pad scrolls, then insert a
  // sketch at the end and give it content.
  await page.click('.spm-editor .ProseMirror');
  // Type many newlines to create scroll height above the sketch.
  await page.keyboard.type('Top of pad.');
  for (let i = 0; i < 40; i++) await page.keyboard.press('Enter');
  const ctx = await page.evaluate(() => window.WriteSysScratchpad.insertSketch());
  const vid = ctx.variation.variation_id;
  await page.waitForSelector(`.sn-widget[data-variation-id="${vid}"] .sn-render`);
  // give it text so preview renders (click to edit, type, blur)
  await page.click(`.sn-widget[data-variation-id="${vid}"] .sn-render`);
  await page.waitForSelector(`.sn-widget[data-variation-id="${vid}"] .sn-text`);
  await page.fill(`.sn-widget[data-variation-id="${vid}"] .sn-text`, 'Line one.\n\nLine two of the sketch.');
  await page.locator(`.sn-widget[data-variation-id="${vid}"] .sn-text`).blur();
  await page.waitForTimeout(600);

  const host = '.spm-editor';
  // Scroll the pad so the widget sits mid-viewport (some scroll offset > 0).
  await page.evaluate((sel) => {
    const el = document.querySelector('.sn-widget');
    el.scrollIntoView({ block: 'center' });
  }, host);
  await page.waitForTimeout(200);
  const beforeEdit = await page.evaluate((sel) => document.querySelector(sel).scrollTop, host);

  // 1) Click to edit — must not jump.
  await page.click(`.sn-widget[data-variation-id="${vid}"] .sn-render`);
  await page.waitForSelector(`.sn-widget[data-variation-id="${vid}"] .sn-text`);
  await page.waitForTimeout(250);
  const afterEdit = await page.evaluate((sel) => document.querySelector(sel).scrollTop, host);
  check('click-to-edit does not scroll the pad', Math.abs(afterEdit - beforeEdit) <= 8,
    `before=${beforeEdit} after=${afterEdit}`);

  // blur back to preview
  await page.locator(`.sn-widget[data-variation-id="${vid}"] .sn-text`).blur();
  await page.waitForTimeout(300);
  const beforeFreeze = await page.evaluate((sel) => document.querySelector(sel).scrollTop, host);

  // 2) Toggle freeze — must not jump.
  await page.click(`.sn-widget[data-variation-id="${vid}"] [data-act="freeze"]`);
  await page.waitForTimeout(350);
  const afterFreeze = await page.evaluate((sel) => document.querySelector(sel).scrollTop, host);
  check('freeze does not scroll the pad', Math.abs(afterFreeze - beforeFreeze) <= 8,
    `before=${beforeFreeze} after=${afterFreeze}`);

  // 3) frozen preview shows the light-blue background.
  const frozenBg = await page.evaluate((v) => {
    const r = document.querySelector(`.sn-widget[data-variation-id="${v}"] .sn-render.sn-frozen`);
    return r ? getComputedStyle(r).backgroundColor : null;
  }, vid);
  check('frozen variation preview has the light-blue background',
    frozenBg === 'rgb(238, 244, 251)', `bg=${frozenBg}`);

  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
