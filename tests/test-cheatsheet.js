const { chromium } = require('playwright');
const { TEST_URL, loginAsTestUser } = require('./test-utils');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  let failed = false;
  const check = (name, ok, extra) => {
    console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
    if (!ok) failed = true;
  };

  await loginAsTestUser(page);
  await page.goto(TEST_URL);
  await page.waitForTimeout(4000);

  // Icon exists, right of Logout.
  const iconExists = await page.locator('#cheatsheet-icon').count();
  check('cheatsheet icon present', iconExists === 1);

  const order = await page.evaluate(() => {
    const kids = Array.from(document.querySelectorAll('.control-group-right > *'));
    const li = kids.findIndex(k => k.id === 'logout-btn');
    const ci = kids.findIndex(k => k.id === 'cheatsheet-icon');
    return { li, ci };
  });
  check('icon sits right of Logout', order.ci > order.li && order.li >= 0, `logout@${order.li} cheat@${order.ci}`);

  // Panel hidden initially (off-screen via transform).
  const openBefore = await page.locator('#cheatsheet-panel').evaluate(el => el.classList.contains('is-open'));
  check('panel closed on load', openBefore === false);

  // Click opens it.
  await page.locator('#cheatsheet-icon').click();
  await page.waitForTimeout(400);
  const openAfter = await page.locator('#cheatsheet-panel').evaluate(el => el.classList.contains('is-open'));
  check('click opens panel', openAfter === true);

  // Content: expected headings + the salvia-style gotcha wording present.
  const body = await page.locator('#cheatsheet-panel').innerText();
  check('has "Block commands"', /Block commands/i.test(body));
  check('has "Inline commands"', /Inline commands/i.test(body));
  check('has &meta settings', /meta settings/i.test(body));
  check('explains inline-anchor gotcha', /NOT show in the outline|not appear in the outline|its own line/i.test(body));
  check('shows &chapter example', body.includes('&chapter'));

  // Backdrop visible while open.
  const backdropShown = await page.locator('#cheatsheet-backdrop').evaluate(el => !el.hidden);
  check('backdrop shown when open', backdropShown === true);

  // Escape closes.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const openAfterEsc = await page.locator('#cheatsheet-panel').evaluate(el => el.classList.contains('is-open'));
  check('Escape closes panel', openAfterEsc === false);

  // Re-open, screenshot for eyeball.
  await page.locator('#cheatsheet-icon').click();
  await page.waitForTimeout(400);
  const fs = require('fs');
  if (!fs.existsSync('tests/screenshots')) fs.mkdirSync('tests/screenshots', { recursive: true });
  await page.screenshot({ path: 'tests/screenshots/cheatsheet.png' });
  console.log('📸 tests/screenshots/cheatsheet.png');

  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
