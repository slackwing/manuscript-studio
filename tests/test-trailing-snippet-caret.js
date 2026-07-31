// Trailing-node guarantee: when a snippet is the last element in a pad, the
// editor appends an empty paragraph, so there is ALWAYS a place to click and
// keep writing below the widget (gap cursor exists but is undiscoverable at
// the doc edge). Deleting that paragraph just re-appends it.
const { chromium } = require('playwright');
const { TEST_URL, loginAsTestUser } = require('./test-utils');
const HOME_URL = new URL('home.html', TEST_URL).href;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  page.on('dialog', d => d.accept());
  let failed = false;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed = true; };

  await loginAsTestUser(page);
  await page.goto(HOME_URL);
  await page.waitForSelector('#home-new-pad'); await page.click('#home-new-pad');
  await page.waitForSelector('.spm-overlay .ProseMirror');
  await page.locator('.spm-editor .ProseMirror').click();
  await page.keyboard.type('prose before the widget');

  // Insert a snippet with the cursor at the very end — the snippet becomes the
  // last content node, and the plugin must append a paragraph after it.
  await page.evaluate(() => window.WriteSysScratchpad.insertSnippet());
  await page.waitForSelector('.spm-editor .sn-widget');
  await page.waitForTimeout(300);

  const shape = () => page.evaluate(() =>
    window.WriteSysScratchpad.view.state.doc.content.content.map(n => n.type.name));
  let types = await shape();
  check('snippet inserted', types.includes('snippet'), JSON.stringify(types));
  check('doc auto-ends with a paragraph after the snippet',
    types[types.length - 1] === 'paragraph' && types[types.indexOf('snippet') - 0 + 1] !== undefined,
    JSON.stringify(types));

  // The trailing paragraph is CLICKABLE: click it and type.
  await page.locator('.spm-editor .ProseMirror > p').last().click();
  await page.keyboard.type('continuing after the widget');
  const text = await page.evaluate(() => window.WriteSysScratchpad.view.state.doc.textContent);
  check('typing lands after the widget', text.endsWith('continuing after the widget'), JSON.stringify(text.slice(-40)));

  // Wipe the trailing paragraph's text and Backspace into the widget's edge —
  // the guarantee holds: still a trailing paragraph (re-appended if removed).
  await page.keyboard.press('Control+a');
  await page.keyboard.press('End');
  for (let i = 0; i < 'continuing after the widget'.length + 2; i++) await page.keyboard.press('Backspace');
  await page.waitForTimeout(300);
  types = await shape();
  check('trailing paragraph survives deletion attempts',
    types[types.length - 1] === 'paragraph', JSON.stringify(types));

  console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS');
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('Test crashed:', e); process.exit(1); });
