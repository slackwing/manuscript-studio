const { chromium } = require('playwright');
const { TEST_URL, cleanupTestAnnotations } = require('./test-utils');

(async () => {
  console.log('=== Note and Tags Test ===\n');

  // Cleanup before test
  await cleanupTestAnnotations();

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    // Navigate to test manuscript
  // Login first
  await loginAsTestUser(page);

    await page.goto(TEST_URL);
    await page.waitForSelector('.pagedjs_page', { timeout: 30000 });
    await page.waitForSelector('.sentence', { timeout: 5000 });

    // Wait for Paged.js to fully finish and event handlers to be attached
    await page.waitForTimeout(2000);

    console.log('✓ Page loaded');

    // Test 1: Verify UI elements are hidden initially
    const paletteVisible = await page.locator('#color-palette.visible').count();
    const noteVisible = await page.locator('#note-container.visible').count();
    const tagsVisible = await page.locator('#tags-container.visible').count();

    if (paletteVisible === 0 && noteVisible === 0 && tagsVisible === 0) {
      console.log('✓ UI elements hidden initially');
    } else {
      console.log(`✗ UI elements should be hidden (palette: ${paletteVisible}, note: ${noteVisible}, tags: ${tagsVisible})`);
    }

    // Test 2: Click sentence and verify all UI elements show
    const firstSentence = await page.locator('.sentence').first();
    const sentenceId = await firstSentence.getAttribute('data-sentence-id');
    await firstSentence.click();
    await page.waitForTimeout(200);

    const paletteVisibleAfterClick = await page.locator('#color-palette.visible').count();
    const noteVisibleAfterClick = await page.locator('#note-container.visible').count();
    const tagsVisibleAfterClick = await page.locator('#tags-container.visible').count();

    if (paletteVisibleAfterClick === 1 && noteVisibleAfterClick === 1 && tagsVisibleAfterClick === 1) {
      console.log('✓ All UI elements visible after sentence click');
    } else {
      console.log(`✗ UI elements should be visible (palette: ${paletteVisibleAfterClick}, note: ${noteVisibleAfterClick}, tags: ${tagsVisibleAfterClick})`);
    }

    // Test 3: Verify color circles are smaller (24px)
    const circleSize = await page.locator('.color-circle').first().evaluate(el => {
      const style = window.getComputedStyle(el);
      return { width: style.width, height: style.height };
    });

    if (circleSize.width === '24px' && circleSize.height === '24px') {
      console.log('✓ Color circles are 24px × 24px');
    } else {
      console.log(`✗ Color circles should be 24px, got ${circleSize.width} × ${circleSize.height}`);
    }

    // Test 4: Verify color circles are centered
    const paletteJustify = await page.locator('#color-palette').evaluate(el => {
      return window.getComputedStyle(el).justifyContent;
    });

    if (paletteJustify === 'center') {
      console.log('✓ Color palette is centered');
    } else {
      console.log(`✗ Color palette should be centered, got ${paletteJustify}`);
    }

    // Test 5: Type in note and verify default-to-blue
    const noteInput = await page.locator('#note-input');
    await noteInput.type('T');
    await page.waitForTimeout(300);

    // Check if blue highlight was applied
    const hasBlueHighlight = await page.locator(`.sentence[data-sentence-id="${sentenceId}"].highlight-blue`).count();

    if (hasBlueHighlight > 0) {
      console.log('✓ Typing first character defaults to blue highlight');
    } else {
      console.log('✗ Should default to blue highlight on first character');
    }

    // Check if blue circle is active
    const blueCircleActive = await page.locator('.color-circle[data-color="blue"].active').count();

    if (blueCircleActive > 0) {
      console.log('✓ Blue circle marked as active');
    } else {
      console.log('✗ Blue circle should be active');
    }

    // Test 6: Erase note and verify blue is removed
    await noteInput.fill('');
    await page.waitForTimeout(1500); // Wait for debounced save

    const hasBlueAfterErase = await page.locator(`.sentence[data-sentence-id="${sentenceId}"].highlight-blue`).count();

    if (hasBlueAfterErase === 0) {
      console.log('✓ Erasing note removes auto-default blue');
    } else {
      console.log('✗ Should remove blue highlight when note erased');
    }

    // Test 7: Type note again, then change color manually
    await noteInput.type('Test note');
    await page.waitForTimeout(300);

    // Should auto-default to blue again
    const hasBlueAgain = await page.locator(`.sentence[data-sentence-id="${sentenceId}"].highlight-blue`).count();

    if (hasBlueAgain > 0) {
      console.log('✓ Auto-default to blue works again');
    } else {
      console.log('✗ Should auto-default to blue again');
    }

    // Click yellow circle
    await page.locator('.color-circle[data-color="yellow"]').click();
    await page.waitForTimeout(300);

    const hasYellowHighlight = await page.locator(`.sentence[data-sentence-id="${sentenceId}"].highlight-yellow`).count();
    const hasBlueStillThere = await page.locator(`.sentence[data-sentence-id="${sentenceId}"].highlight-blue`).count();

    if (hasYellowHighlight > 0 && hasBlueStillThere === 0) {
      console.log('✓ Manually changing color works (blue → yellow)');
    } else {
      console.log(`✗ Should change to yellow (yellow: ${hasYellowHighlight}, blue: ${hasBlueStillThere})`);
    }

    // Test 8: Continue typing and verify yellow stays
    await noteInput.type(' more text');
    await page.waitForTimeout(300);

    const stillYellow = await page.locator(`.sentence[data-sentence-id="${sentenceId}"].highlight-yellow`).count();

    if (stillYellow > 0) {
      console.log('✓ Manual color selection persists after more typing');
    } else {
      console.log('✗ Yellow highlight should persist');
    }

    // Test 9: Verify tags section shows "new tag" chip
    const newTagChip = await page.locator('.tag-chip.new-tag').count();

    if (newTagChip > 0) {
      console.log('✓ "New tag" chip is visible');
    } else {
      console.log('✗ Should show "new tag" chip');
    }

    // Test 10: Verify note persists after reload
    await page.waitForTimeout(1500); // Wait for auto-save
    await page.reload();
    await page.waitForSelector('.pagedjs_page', { timeout: 30000 });
    await page.waitForSelector('.sentence', { timeout: 5000 });
    await page.waitForTimeout(2000); // Wait for Paged.js to fully finish and event handlers to be attached

    // Click the same sentence
    await page.locator(`.sentence[data-sentence-id="${sentenceId}"]`).first().click();
    await page.waitForTimeout(200);

    const noteValue = await page.locator('#note-input').inputValue();

    if (noteValue === 'Test note more text') {
      console.log('✓ Note persists after reload');
    } else {
      console.log(`✗ Note should be "Test note more text", got "${noteValue}"`);
    }

    console.log('\n[CLEANUP] Deleting test annotations...');
    await cleanupTestAnnotations();

    console.log('\n✅ Note and Tags Test Complete!');

  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
