// Deleting a scratchpad note's inline ref must not leave a doubled space. The
// ref replaces a selected word, so it commonly sits between two spaces
// (one<ref>three); removing only the ref would leave "one  three". The delete
// collapses the redundant space.
const { chromium } = require('playwright');
const { TEST_URL, cleanupTestNotes, loginAsTestUser } = require('./test-utils');
const HOME_URL = new URL('home.html', TEST_URL).href;
const docText = () => window.WriteSysScratchpad.view.state.doc.textContent;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  page.on('dialog', d => d.accept());
  let failed = false;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed = true; };

  await cleanupTestNotes();
  await loginAsTestUser(page);
  await page.goto(HOME_URL);
  await page.waitForSelector('#home-new-pad'); await page.click('#home-new-pad');
  await page.waitForSelector('.spm-overlay .ProseMirror');

  const pm = page.locator('.spm-editor .ProseMirror');
  await pm.click();
  await page.keyboard.type('one two three');
  // Select the middle word "two" (chars 4..7) — flanked by spaces.
  await page.keyboard.press('Home');
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.down('Shift'); for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight'); await page.keyboard.up('Shift');
  await page.waitForTimeout(150);
  await page.locator('.sn-note-colorbar .sn-note-colorbtn').first().click();
  await page.waitForTimeout(600);

  // The ref sits between the two spaces, so textContent shows a gap.
  const before = await page.evaluate(docText);
  check('ref created between the two flanking spaces', before === 'one  three', JSON.stringify(before));

  // Delete the note via its trash (two-click confirm).
  await page.locator('.spm-title').click(); await page.waitForTimeout(200);
  await page.evaluate(() => {
    const t = document.querySelector('.sn-note-ref-trash');
    t.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    t.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
  await page.waitForTimeout(600);

  const after = await page.evaluate(docText);
  check('delete leaves a single space, not a doubled one', after === 'one three', JSON.stringify(after));

  await browser.close();
  console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS');
  process.exit(failed ? 1 : 0);
})();
