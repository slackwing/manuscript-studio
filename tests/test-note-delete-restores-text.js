// Deleting a scratchpad note's inline ref RESTORES the original highlighted
// text (it's stored in the ref's attrs.text), rather than removing it. So a
// note on "two" in "one two three", when deleted, leaves the doc as
// "one two three" again — the words come back as plain prose, no gap.
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
  await page.waitForSelector('.card-ghost[data-ghost="scratchpad"]'); await page.click('.card-ghost[data-ghost="scratchpad"]');
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
  // Ref creation is async (note POST + doc transaction) — wait on the ref
  // atom, not a fixed sleep; the fixed 600ms lost races under suite load.
  await page.waitForSelector('.sn-note-ref', { timeout: 20000 });

  // The ref sits between the two spaces, so textContent shows a gap.
  const before = await page.evaluate(docText);
  // While the ref is present, its text isn't part of the paragraph's plain
  // textContent (it's an atom), so we see the gap "one  three".
  check('ref replaces the highlighted word while present', before === 'one  three', JSON.stringify(before));

  // Delete the note via its trash (two-click confirm).
  await page.locator('.spm-title').click();
  // The trash is hover-revealed: attached to the DOM but CSS-hidden, and the
  // deletion below dispatches events on it directly — so wait on attachment.
  await page.waitForSelector('.sn-note-ref-trash', { state: 'attached', timeout: 20000 });
  await page.evaluate(() => {
    const t = document.querySelector('.sn-note-ref-trash');
    t.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    t.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
  await page.waitForTimeout(600);

  const after = await page.evaluate(docText);
  check('deleting the note restores the original text (not nothing)', after === 'one two three', JSON.stringify(after));
  check('no ref remains in the doc', (await page.locator('.sn-note-ref').count()) === 0);

  await browser.close();
  console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS');
  process.exit(failed ? 1 : 0);
})();
