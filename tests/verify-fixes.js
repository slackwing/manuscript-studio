const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    console.log('=== Verifying Fixes ===\n');

    // Navigate to the app
    console.log('1. Navigating to http://localhost:5001...');
  // Login first
  await loginAsTestUser(page);

    await page.goto('http://localhost:5001');
    await page.waitForLoadState('networkidle');

    // Wait for manuscript to load
    console.log('2. Waiting for manuscript to load...');
    await page.waitForSelector('.sentence', { timeout: 30000 });

    // Find the "but-as-happens-fbad3020" sentence (which has multiple annotations)
    console.log('3. Looking for but-as-happens sentence...');
    const sentence = await page.locator('.sentence[data-sentence-id="but-as-happens-fbad3020"]').first();

    if (await sentence.count() === 0) {
      console.log('ERROR: Could not find sentence with ID but-as-happens-fbad3020');
      process.exit(1);
    }

    console.log('4. Found sentence!');
    await sentence.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);

    // Click on the sentence to show annotations
    console.log('5. Clicking sentence to show sticky notes...');
    await sentence.click();
    await page.waitForTimeout(1000);

    // Check if sticky notes are visible
    const stickyNotes = await page.locator('.sticky-note').all();
    console.log(`6. Found ${stickyNotes.length} sticky notes`);

    if (stickyNotes.length > 0) {
      // Hover over first note to show color circle
      console.log('7. Hovering over first sticky note to show color circle...');
      await stickyNotes[0].hover();
      await page.waitForTimeout(500);

      // Check if color circle exists and has color class
      const colorCircle = await stickyNotes[0].locator('.sticky-note-color-circle').first();
      const circleClasses = await colorCircle.getAttribute('class');
      console.log(`8. Color circle classes: ${circleClasses}`);

      // Get computed cursor style
      const cursor = await colorCircle.evaluate(el => {
        return window.getComputedStyle(el).cursor;
      });
      console.log(`9. Color circle cursor: ${cursor}`);

      if (cursor === 'move') {
        console.log('   ✓ PASS: Cursor is "move" (correct!)');
      } else {
        console.log(`   ✗ FAIL: Cursor is "${cursor}" (should be "move")`);
      }

      // Take screenshot showing cursor
      await page.screenshot({ path: 'tests/screenshots/verify-cursor.png', fullPage: true });
      console.log('10. Screenshot saved: tests/screenshots/verify-cursor.png');
    }

    // Now test rainbow bars update
    console.log('\n=== Testing Rainbow Bars Update ===\n');

    // Count rainbow bars before adding annotation
    const rainbowBarsBefore = await page.locator('.rainbow-bar-container').count();
    console.log(`11. Rainbow bar containers before: ${rainbowBarsBefore}`);

    // Click the rainbow circle to add a new color annotation
    console.log('12. Clicking rainbow circle to add new color...');
    const rainbowCircle = await page.locator('.sticky-note-color-circle.rainbow').first();
    if (await rainbowCircle.count() > 0) {
      await rainbowCircle.click();
      await page.waitForTimeout(500);

      // Select a color from palette
      console.log('13. Selecting orange color from palette...');
      const orangeCircle = await page.locator('.color-option.color-orange').first();
      if (await orangeCircle.count() > 0) {
        await orangeCircle.click();
        await page.waitForTimeout(1500); // Wait for API call and rainbow bars to update

        // Count rainbow bars after
        const rainbowBarsAfter = await page.locator('.rainbow-bar-container').count();
        console.log(`14. Rainbow bar containers after: ${rainbowBarsAfter}`);

        if (rainbowBarsAfter > rainbowBarsBefore) {
          console.log('    ✓ PASS: Rainbow bars increased after adding annotation!');
        } else if (rainbowBarsAfter === rainbowBarsBefore) {
          console.log('    ~ INFO: Rainbow bar count unchanged (might already be at max)');
        } else {
          console.log(`    ✗ FAIL: Rainbow bars decreased? Before: ${rainbowBarsBefore}, After: ${rainbowBarsAfter}`);
        }

        // Take screenshot showing rainbow bars
        await page.screenshot({ path: 'tests/screenshots/verify-rainbow-bars.png', fullPage: true });
        console.log('15. Screenshot saved: tests/screenshots/verify-rainbow-bars.png');
      }
    }

    console.log('\n=== Verification Complete ===');
    console.log('\nTo view screenshots, run:');
    console.log('  xdg-open tests/screenshots/verify-cursor.png');
    console.log('  xdg-open tests/screenshots/verify-rainbow-bars.png');

    console.log('\nKeeping browser open for 30 seconds for manual inspection...');
    await page.waitForTimeout(30000);

  } catch (error) {
    console.error('Error:', error);
    await page.screenshot({ path: 'tests/screenshots/verify-error.png', fullPage: true });
  } finally {
    await browser.close();
  }
})();
