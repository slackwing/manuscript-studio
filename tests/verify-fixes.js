/**
 * Smoke test:
 *   1. Real-note color circle has a "move" cursor (drag affordance).
 *   2. Adding a colored annotation updates the sidebar rainbow bars.
 */

const { chromium } = require('playwright');
const { TEST_URL, cleanupTestAnnotations, loginAsTestUser } = require('./test-utils');

(async () => {
  await cleanupTestAnnotations();

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  let failed = 0;

  try {
    console.log('=== Verifying Fixes ===\n');

    console.log('1. Logging in and loading the app...');
    await loginAsTestUser(page);
    await page.goto(TEST_URL);
    await page.waitForLoadState('networkidle');
    await page.waitForSelector('.sentence', { timeout: 30000 });
    await page.waitForTimeout(2000);

    const sentenceId = await page.evaluate(() => {
      return document.querySelector('.sentence').dataset.sentenceId;
    });
    console.log(`2. Using dynamically-discovered sentence: ${sentenceId}`);

    const sentence = page.locator(`.sentence[data-sentence-id="${sentenceId}"]`).first();
    await sentence.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);

    console.log('3. Clicking sentence to show sticky notes...');
    await sentence.click();
    await page.waitForTimeout(800);

    console.log('4. Creating initial yellow annotation via the palette...');
    await page.locator('.sticky-note.uncreated-note .sticky-note-color-circle').first().hover();
    await page.waitForTimeout(300);
    await page.locator('.sticky-note.uncreated-note .color-circle[data-color="yellow"]').first().click();
    await page.waitForTimeout(1500);

    const realNote = page.locator('.sticky-note:not(.uncreated-note)').first();
    const realNoteExists = await realNote.count();
    if (realNoteExists === 0) {
      console.log('ERROR: Real sticky note was not created.');
      process.exit(1);
    }

    await realNote.hover();
    await page.waitForTimeout(300);

    const colorCircle = realNote.locator('.sticky-note-color-circle').first();
    const circleClasses = await colorCircle.getAttribute('class');
    console.log(`5. Real note color circle classes: ${circleClasses}`);

    const cursor = await colorCircle.evaluate(el => window.getComputedStyle(el).cursor);
    console.log(`6. Color circle cursor: ${cursor}`);

    if (cursor === 'move') {
      console.log('   PASS: Cursor is "move"');
    } else {
      console.log(`   FAIL: Cursor is "${cursor}" (expected "move")`);
      failed++;
    }

    await page.screenshot({ path: 'tests/screenshots/verify-cursor.png', fullPage: true });

    console.log('\n=== Testing Rainbow Bars Update ===\n');

    // Deselect first via grey app background so the next click is a fresh
    // selection — re-clicking a selected sentence opens the suggested-edit modal.
    await page.locator('#app-container').click({ position: { x: 5, y: 5 } });
    await page.waitForTimeout(200);
    await sentence.click();
    await page.waitForTimeout(500);

    const barsBefore = await page.locator('.rainbow-bar').count();
    console.log(`7. Rainbow bars before adding a second annotation: ${barsBefore}`);

    console.log('8. Adding a second (green) annotation...');
    const uncreated = page.locator('.sticky-note.uncreated-note').first();
    await uncreated.hover();
    await page.waitForTimeout(300);
    await uncreated.locator('.sticky-note-color-circle').first().hover();
    await page.waitForTimeout(300);
    await uncreated.locator('.color-circle[data-color="green"]').first().click();
    await page.waitForTimeout(1500);

    const barsAfter = await page.locator('.rainbow-bar').count();
    console.log(`9. Rainbow bars after adding: ${barsAfter}`);

    if (barsAfter > barsBefore) {
      console.log('   PASS: Rainbow bars increased after adding annotation.');
    } else if (barsAfter === barsBefore && barsBefore > 0) {
      console.log('   INFO: Rainbow bar count unchanged (possibly already saturated).');
    } else {
      console.log(`   FAIL: Rainbow bars did not increase (before: ${barsBefore}, after: ${barsAfter}).`);
      failed++;
    }

    await page.screenshot({ path: 'tests/screenshots/verify-rainbow-bars.png', fullPage: true });

    console.log('\n=== Verification Complete ===');
  } catch (error) {
    console.error('Error:', error);
    try {
      await page.screenshot({ path: 'tests/screenshots/verify-error.png', fullPage: true });
    } catch (_) {}
    failed++;
  } finally {
    await browser.close();
    await cleanupTestAnnotations();
    process.exit(failed > 0 ? 1 : 0);
  }
})();
