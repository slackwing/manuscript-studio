const { chromium } = require('playwright');
const { TEST_URL, TEST_MANUSCRIPT_ID, cleanupTestAnnotations } = require('./test-utils');

(async () => {
  console.log('=== Trash Can Deletion Test ===\n');

  await cleanupTestAnnotations();

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    // Load the page
  // Login first
  await loginAsTestUser(page);

    await page.goto(TEST_URL);
    await page.waitForSelector('.pagedjs_page', { timeout: 30000 });
    await page.waitForSelector('.sentence', { timeout: 5000 });
    await page.waitForTimeout(2000);

    // ===== Test 1: Trash icon appears when annotation exists =====
    console.log('Test 1: Trash icon appears when annotation exists...');

    const firstSentence = await page.locator('.sentence').first();
    await firstSentence.click();
    await page.waitForTimeout(300);

    // Trash should not be visible initially (no annotation)
    const trashIcon = await page.locator('#trash-icon');
    const palette = await page.locator('#color-palette');
    const paletteVisible = await palette.evaluate(el => el.classList.contains('visible'));

    if (!paletteVisible) {
      console.log('✗ Color palette should be visible');
      process.exit(1);
    }

    // Create annotation
    const yellowCircle = await page.locator('.color-circle[data-color="yellow"]');
    await yellowCircle.click();
    await page.waitForTimeout(500);

    // Trash should be visible now
    const trashVisible = await trashIcon.isVisible();

    if (!trashVisible) {
      console.log('✗ Trash icon should be visible when annotation exists');
      process.exit(1);
    }
    console.log('✓ Trash icon appears with annotation');

    // ===== Test 2: First click makes trash "run away" and shows X =====
    console.log('\nTest 2: First click makes trash run away and shows cancel X...');

    // Click trash first time
    await trashIcon.click();
    await page.waitForTimeout(300);

    // Check if trash has "ran-away" class
    const hasRanAway = await trashIcon.evaluate(el => el.classList.contains('ran-away'));

    if (!hasRanAway) {
      console.log('✗ Trash should have ran-away class after first click');
      process.exit(1);
    }

    // Check if cancel X is visible
    const cancelX = await page.locator('#cancel-delete');
    const cancelVisible = await cancelX.evaluate(el => el.classList.contains('visible'));

    if (!cancelVisible) {
      console.log('✗ Cancel X should be visible after trash runs away');
      process.exit(1);
    }

    console.log('✓ Trash runs away and cancel X appears');

    // ===== Test 3: Clicking X cancels and returns trash to normal =====
    console.log('\nTest 3: Clicking X cancels deletion...');

    await cancelX.click();
    await page.waitForTimeout(300);

    // Trash should be back to normal
    const stillRanAway = await trashIcon.evaluate(el => el.classList.contains('ran-away'));

    if (stillRanAway) {
      console.log('✗ Trash should return to normal after cancel');
      process.exit(1);
    }

    // X should be hidden
    const cancelStillVisible = await cancelX.evaluate(el => el.classList.contains('visible'));

    if (cancelStillVisible) {
      console.log('✗ Cancel X should be hidden after click');
      process.exit(1);
    }

    // Annotation should still exist
    const hasYellow = await firstSentence.evaluate(el => el.classList.contains('highlight-yellow'));

    if (!hasYellow) {
      console.log('✗ Annotation should still exist after cancel');
      process.exit(1);
    }

    console.log('✓ Cancel X returns trash to normal and preserves annotation');

    // ===== Test 4: Second click on "ran away" trash actually deletes =====
    console.log('\nTest 4: Second click on ran-away trash deletes annotation...');

    // Make trash run away again
    await trashIcon.click();
    await page.waitForTimeout(300);

    // Click the ran-away trash to actually delete
    await trashIcon.click();
    await page.waitForTimeout(500);

    // Annotation should be gone
    const hasYellowAfterDelete = await firstSentence.evaluate(el => el.classList.contains('highlight-yellow'));

    if (hasYellowAfterDelete) {
      console.log('✗ Annotation should be deleted after second trash click');
      process.exit(1);
    }

    // Trash should be back to normal (no ran-away class)
    const trashStillRanAway = await trashIcon.evaluate(el => el.classList.contains('ran-away'));

    if (trashStillRanAway) {
      console.log('✗ Trash should return to normal after deletion');
      process.exit(1);
    }

    console.log('✓ Second click on ran-away trash deletes annotation');

    // ===== Test 5: Clicking same color again does nothing (no toggle) =====
    console.log('\nTest 5: Clicking same color again does nothing...');

    const secondSentence = await page.locator('.sentence').nth(1);
    await secondSentence.click();
    await page.waitForTimeout(300);

    const blueCircle = await page.locator('.color-circle[data-color="blue"]');
    await blueCircle.click();
    await page.waitForTimeout(500);

    // Verify blue is applied
    const hasBlue = await secondSentence.evaluate(el => el.classList.contains('highlight-blue'));

    if (!hasBlue) {
      console.log('✗ Blue highlight should be applied');
      process.exit(1);
    }

    // Click blue again
    await blueCircle.click();
    await page.waitForTimeout(300);

    // Should still have blue (no toggle)
    const stillHasBlue = await secondSentence.evaluate(el => el.classList.contains('highlight-blue'));

    if (!stillHasBlue) {
      console.log('✗ Should still have blue after clicking same color (no toggle)');
      process.exit(1);
    }

    console.log('✓ Clicking same color does not toggle/delete');

    console.log('\n✅ All Trash Deletion Tests Passed!');

    await cleanupTestAnnotations();

  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
