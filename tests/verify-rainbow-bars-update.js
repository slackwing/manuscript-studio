const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    console.log('=== Testing Rainbow Bars Update ===\n');

  // Login first
  await loginAsTestUser(page);

    await page.goto('http://localhost:5001');
    await page.waitForLoadState('networkidle');
    await page.waitForSelector('.sentence', { timeout: 30000 });

    // Find a sentence with multiple annotations
    console.log('1. Looking for sentence with multiple annotations...');
    const sentence = await page.locator('.sentence[data-sentence-id="but-as-happens-fbad3020"]').first();

    if (await sentence.count() === 0) {
      console.log('ERROR: Could not find test sentence');
      process.exit(1);
    }

    await sentence.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);

    // Click sentence to open sticky notes
    console.log('2. Clicking sentence to open sticky notes...');
    await sentence.click();
    await page.waitForTimeout(1000);

    // Count rainbow bars BEFORE
    const barsBefore = await page.locator('.rainbow-bar').count();
    console.log(`3. Rainbow bars BEFORE: ${barsBefore}`);

    // Find a sticky note that has a color (not rainbow)
    const coloredNotes = await page.locator('.sticky-note').all();
    console.log(`4. Found ${coloredNotes.length} sticky notes`);

    if (coloredNotes.length === 0) {
      console.log('ERROR: No sticky notes found');
      process.exit(1);
    }

    // Look for a note we can delete to test update
    console.log('5. Looking for a note to delete...');
    const firstNote = coloredNotes[0];

    // Hover to show trash
    await firstNote.hover();
    await page.waitForTimeout(500);

    // Click trash to delete
    const trash = await firstNote.locator('.note-trash').first();
    if (await trash.count() > 0) {
      console.log('6. Deleting first annotation...');
      await trash.click();
      await page.waitForTimeout(2000); // Wait for API call and refresh

      // Count rainbow bars AFTER
      const barsAfter = await page.locator('.rainbow-bar').count();
      console.log(`7. Rainbow bars AFTER deletion: ${barsAfter}`);

      if (barsAfter !== barsBefore) {
        console.log(`   ✓ PASS: Rainbow bars changed! (${barsBefore} -> ${barsAfter})`);
      } else {
        console.log(`   ✗ FAIL: Rainbow bars did not change (still ${barsBefore})`);
      }

      // Take screenshot
      await page.screenshot({
        path: 'tests/screenshots/rainbow-bars-after-delete.png',
        fullPage: true
      });
      console.log('8. Screenshot: tests/screenshots/rainbow-bars-after-delete.png');
    } else {
      console.log('   SKIP: No trash button found, trying to add a note instead...');

      // Try adding a new note
      console.log('6. Adding a new annotation...');

      // Click the + button
      const addButton = await page.locator('.add-note-btn').first();
      if (await addButton.count() > 0) {
        await addButton.click();
        await page.waitForTimeout(500);

        // Select a color
        const yellowOption = await page.locator('.color-option.color-yellow').first();
        if (await yellowOption.count() > 0) {
          await yellowOption.click();
          await page.waitForTimeout(2000); // Wait for API call and refresh

          // Count rainbow bars AFTER
          const barsAfter = await page.locator('.rainbow-bar').count();
          console.log(`7. Rainbow bars AFTER adding: ${barsAfter}`);

          if (barsAfter !== barsBefore) {
            console.log(`   ✓ PASS: Rainbow bars changed! (${barsBefore} -> ${barsAfter})`);
          } else {
            console.log(`   ✗ FAIL: Rainbow bars did not change (still ${barsBefore})`);
          }

          // Take screenshot
          await page.screenshot({
            path: 'tests/screenshots/rainbow-bars-after-add.png',
            fullPage: true
          });
          console.log('8. Screenshot: tests/screenshots/rainbow-bars-after-add.png');
        }
      }
    }

    console.log('\n=== Test Complete ===');
    console.log('Keeping browser open for 30 seconds...');
    await page.waitForTimeout(30000);

  } catch (error) {
    console.error('Error:', error);
    await page.screenshot({ path: 'tests/screenshots/rainbow-bars-error.png', fullPage: true });
  } finally {
    await browser.close();
  }
})();
