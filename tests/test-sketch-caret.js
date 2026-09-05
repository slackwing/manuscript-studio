// REGRESSION: basic caret behavior in a sketch's edit textarea — on the
// FIRST-CREATED widget (the reported breakage), not just re-entered ones.
// Create via the real toolbar menu, click into the empty widget, type, then:
//   - clicking mid-text MOVES the caret there;
//   - arrow keys move it;
//   - it stays movable across an autosave cycle;
//   - and again after leaving + re-entering edit mode.
// Run with BROWSER=firefox to exercise the user's actual engine.
const pw = require('playwright');
const engine = pw[process.env.BROWSER || 'chromium'];
const { TEST_URL, loginAsTestUser } = require('./test-utils');
const HOME_URL = new URL('home.html', TEST_URL).href;

(async () => {
  const browser = await engine.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('dialog', d => d.accept());
  let failed = false;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed = true; };

  await loginAsTestUser(page);
  await page.goto(HOME_URL);
  await page.waitForSelector('.card-ghost[data-ghost="scratchpad"]'); await page.click('.card-ghost[data-ghost="scratchpad"]');
  await page.waitForSelector('.spm-overlay .ProseMirror');
  await page.locator('.spm-editor .ProseMirror').click();

  // FIRST CREATE via the real toolbar path.
  await page.locator('#spm-toolbar .sn-btn', { hasText: 'Sketch' }).click();
  await page.locator('.sn-ins-new').click();
  await page.waitForSelector('.sn-widget .sn-render');
  await page.waitForTimeout(400);
  await page.locator('.sn-widget .sn-render').click(); // empty → edit
  await page.waitForSelector('.sn-widget textarea');
  await page.keyboard.type('alpha beta gamma delta');
  await page.waitForTimeout(150);

  const sel = () => page.evaluate(() => document.querySelector('.sn-widget textarea').selectionStart);
  check('typed 22 chars, caret at end', (await sel()) === 22, `sel=${await sel()}`);

  const box = await page.locator('.sn-widget textarea').boundingBox();
  await page.mouse.click(box.x + 50, box.y + 18);
  await page.waitForTimeout(150);
  let s = await sel();
  check('mid-click moves the caret (first-create widget)', s > 0 && s < 22, `sel=${s}`);

  await page.keyboard.press('ArrowRight');
  check('ArrowRight advances the caret', (await sel()) === s + 1, `sel=${await sel()}`);

  // Across an autosave cycle.
  await page.waitForTimeout(1200);
  await page.mouse.click(box.x + 95, box.y + 18);
  await page.waitForTimeout(150);
  const s2 = await sel();
  check('caret still movable after autosave', s2 > 0 && s2 !== s + 1, `sel=${s2}`);

  // Leave edit (blur to prose) and come back — still fine.
  await page.locator('.spm-editor .ProseMirror > p').first().click();
  await page.waitForTimeout(800);
  await page.locator('.sn-widget .sn-render').click();
  await page.waitForSelector('.sn-widget textarea');
  const box2 = await page.locator('.sn-widget textarea').boundingBox();
  await page.mouse.click(box2.x + 50, box2.y + 18);
  await page.waitForTimeout(150);
  const s3 = await sel();
  check('caret movable after re-entering edit', s3 > 0 && s3 < 22, `sel=${s3}`);

  console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS');
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('Test crashed:', e); process.exit(1); });
