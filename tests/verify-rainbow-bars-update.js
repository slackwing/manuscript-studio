/**
 * verify-rainbow-bars-update.js
 *
 * Verifies that the rainbow bars on a sentence update live when an
 * annotation is deleted. The sentence needs to have multiple annotations
 * for bars to be visible (a single-color sentence shows solid highlight,
 * not bars). We create two annotations with different colors and then
 * delete one.
 *
 * Previously this test hardcoded a sentence ID ("but-as-happens-fbad3020")
 * that no longer exists. Now the first .sentence is discovered at
 * runtime and the needed annotations are created via the palette.
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
    console.log('=== Testing Rainbow Bars Update ===\n');

    await loginAsTestUser(page);
    await page.goto(TEST_URL);
    await page.waitForLoadState('networkidle');
    await page.waitForSelector('.sentence', { timeout: 30000 });
    await page.waitForTimeout(2000);

    // Discover a sentence dynamically.
    const sentenceId = await page.evaluate(() => {
      return document.querySelector('.sentence').dataset.sentenceId;
    });
    console.log(`1. Using dynamically-discovered sentence: ${sentenceId}`);

    const sentence = page.locator(`.sentence[data-sentence-id="${sentenceId}"]`).first();
    await sentence.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);

    // Click sentence to open sticky notes panel.
    console.log('2. Clicking sentence to open sticky notes...');
    await sentence.click();
    await page.waitForTimeout(800);

    // Create two annotations in different colors so rainbow bars appear.
    async function addNote(color) {
      const uncreated = page.locator('.sticky-note.uncreated-note').first();
      await uncreated.hover();
      await page.waitForTimeout(250);
      await uncreated.locator('.sticky-note-color-circle').first().hover();
      await page.waitForTimeout(300);
      await uncreated.locator(`.color-circle[data-color="${color}"]`).first().click();
      await page.waitForTimeout(1200);
    }

    console.log('3. Creating yellow annotation...');
    await addNote('yellow');
    console.log('4. Creating blue annotation...');
    await addNote('blue');

    // Re-select sentence (in case focus shifted). Deselect first by clicking
    // the grey app background — re-clicking the same selected sentence would
    // open the suggested-edit modal.
    await page.locator('#app-container').click({ position: { x: 5, y: 5 } });
    await page.waitForTimeout(200);
    await sentence.click();
    await page.waitForTimeout(500);

    const barsBefore = await page.locator('.rainbow-bar').count();
    console.log(`5. Rainbow bars BEFORE deletion: ${barsBefore}`);
    if (barsBefore < 1) {
      console.log('   FAIL: Expected at least one rainbow bar after creating two notes.');
      failed++;
    }

    // Find a real (persisted) note and click its trash icon twice to delete.
    const firstNote = page.locator('.sticky-note:not(.uncreated-note)').first();
    await firstNote.hover();
    await page.waitForTimeout(300);

    const trash = firstNote.locator('.note-trash');
    const trashCount = await trash.count();
    if (trashCount === 0) {
      console.log('   FAIL: No trash icon found on real sticky note.');
      failed++;
    } else {
      console.log('6. Clicking trash (1st click: confirm)...');
      await trash.click();
      await page.waitForTimeout(400);
      console.log('7. Clicking trash (2nd click: delete)...');
      await trash.click();
      await page.waitForTimeout(2000);

      const barsAfter = await page.locator('.rainbow-bar').count();
      console.log(`8. Rainbow bars AFTER deletion: ${barsAfter}`);

      if (barsAfter !== barsBefore) {
        console.log(`   PASS: Rainbow bars changed (${barsBefore} -> ${barsAfter}).`);
      } else {
        console.log(`   FAIL: Rainbow bars did not change (still ${barsBefore}).`);
        failed++;
      }

      await page.screenshot({
        path: 'tests/screenshots/rainbow-bars-after-delete.png',
        fullPage: true
      });
    }

    console.log('\n=== Test Complete ===');
  } catch (error) {
    console.error('Error:', error);
    try {
      await page.screenshot({ path: 'tests/screenshots/rainbow-bars-error.png', fullPage: true });
    } catch (_) {}
    failed++;
  } finally {
    await browser.close();
    await cleanupTestAnnotations();
    process.exit(failed > 0 ? 1 : 0);
  }
})();
