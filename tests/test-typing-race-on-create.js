/**
 * Typing into the grey uncreated note triggers an async POST to create the
 * annotation, after which the textarea is destroyed and replaced. Characters
 * the user types during that round-trip used to be lost because they landed
 * in the about-to-be-destroyed textarea.
 *
 * This test types a long string fast and asserts the entire string ends up
 * in the new sticky note.
 */

const { chromium } = require('playwright');
const { TEST_URL, cleanupTestAnnotations, loginAsTestUser } = require('./test-utils');

(async () => {
  console.log('=== Typing-race on note create ===\n');

  await cleanupTestAnnotations();

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1400, height: 900 });

  let failed = false;
  function assert(cond, msg) {
    if (cond) console.log(`✓ ${msg}`);
    else { console.log(`✗ ${msg}`); failed = true; }
  }

  try {
    await loginAsTestUser(page);
    await page.goto(TEST_URL);
    await page.waitForSelector('.pagedjs_page', { timeout: 30000 });
    await page.waitForSelector('.sentence', { timeout: 10000 });
    await page.waitForTimeout(1500);

    await page.locator('.sentence').first().click();
    await page.waitForSelector('.sticky-note.uncreated-note.first-uncreated .note-input', { timeout: 5000 });

    const textarea = page.locator('.sticky-note.uncreated-note.first-uncreated .note-input');
    await textarea.click();

    const phrase = 'hello, world! the quick brown fox jumps.';
    // Fast keystrokes — delay 0 simulates a fast typist sending events
    // before the annotation create round-trip resolves.
    await page.keyboard.type(phrase, { delay: 0 });

    // Wait for the real note to appear and the typing flow to settle.
    await page.waitForSelector('.sticky-note:not(.uncreated-note) .note-input', { timeout: 5000 });
    await page.waitForTimeout(800);

    const finalValue = await page.locator('.sticky-note:not(.uncreated-note) .note-input').first().inputValue();
    assert(finalValue === phrase,
      `All keystrokes preserved (expected ${phrase.length} chars, got ${finalValue.length}: "${finalValue}")`);

    // Cursor should be at end so the user can keep typing.
    const cursorAtEnd = await page.evaluate(() => {
      const el = document.querySelector('.sticky-note:not(.uncreated-note) .note-input');
      return el && el.selectionStart === el.value.length && el.selectionEnd === el.value.length;
    });
    assert(cursorAtEnd, 'Cursor positioned at end of preserved text');

    // Reload should preserve the full text.
    await page.reload();
    await page.waitForSelector('.pagedjs_page', { timeout: 30000 });
    await page.waitForSelector('.sentence', { timeout: 10000 });
    await page.waitForTimeout(1500);
    await page.locator('.sentence').first().click();
    await page.waitForSelector('.sticky-note:not(.uncreated-note) .note-input', { timeout: 5000 });
    const reloadedValue = await page.locator('.sticky-note:not(.uncreated-note) .note-input').first().inputValue();
    assert(reloadedValue === phrase, `Full text persists across reload (got "${reloadedValue}")`);

  } catch (e) {
    console.log(`✗ Test errored: ${e.message}`);
    failed = true;
  } finally {
    await browser.close();
    await cleanupTestAnnotations();
  }

  if (failed) {
    console.log('\n❌ Test failed');
    process.exit(1);
  }
  console.log('\n✅ Test passed');
})().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
