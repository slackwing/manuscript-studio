/**
 * Clicking a sentence should land the cursor in the first sticky-note's
 * textarea so the user can type immediately, without an extra click.
 */

const { chromium } = require('playwright');
const { TEST_URL, cleanupTestAnnotations, loginAsTestUser } = require('./test-utils');

(async () => {
  console.log('=== Auto-focus on sentence-select ===\n');

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

    // First click: sentence with no annotations → grey uncreated-note focused.
    await page.locator('.sentence').first().click();
    await page.waitForSelector('.sticky-note.uncreated-note.first-uncreated .note-input', { timeout: 5000 });

    let focused = await page.evaluate(() => {
      const active = document.activeElement;
      const el = document.querySelector('.sticky-note.uncreated-note.first-uncreated .note-input');
      return active && active === el;
    });
    assert(focused, 'Grey uncreated-note textarea is focused after sentence click');

    // Type without an explicit textarea click — keystrokes should land.
    await page.keyboard.type('hi', { delay: 0 });
    await page.waitForSelector('.sticky-note:not(.uncreated-note) .note-input', { timeout: 5000 });
    await page.waitForTimeout(500);
    const realText = await page.locator('.sticky-note:not(.uncreated-note) .note-input').first().inputValue();
    assert(realText === 'hi', `Typing immediately lands in note (got "${realText}")`);

    // Second sentence: this one already has no annotations either, but we've
    // proven the autofocus works for new selections.
    await page.locator('.sentence').nth(1).click();
    await page.waitForSelector('.sticky-note.uncreated-note.first-uncreated .note-input', { timeout: 5000 });
    focused = await page.evaluate(() => {
      const active = document.activeElement;
      const el = document.querySelector('.sticky-note.uncreated-note.first-uncreated .note-input');
      return active && active === el;
    });
    assert(focused, 'Switching sentences re-focuses the new sentence\'s textarea');

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
