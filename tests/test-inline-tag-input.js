const { chromium } = require('playwright');
const { TEST_URL, TEST_MANUSCRIPT_ID, cleanupTestAnnotations } = require('./test-utils');

(async () => {
  console.log('=== Inline Tag Input Test ===\n');

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

    // ===== Test 1: Tag creation with Enter key =====
    console.log('Test 1: Tag creation with Enter key...');
    const firstSentence = await page.locator('.sentence').first();
    await firstSentence.click();
    await page.waitForTimeout(300);

    // Click new-tag to create editable chip
    const newTagChip = await page.locator('.new-tag');
    await newTagChip.click();
    await page.waitForTimeout(300);

    // Verify editable chip appeared
    const editableChip = await page.locator('.editable-tag');
    const isVisible = await editableChip.count();
    if (isVisible === 0) {
      console.log('✗ Editable tag chip should appear after clicking +tag');
      process.exit(1);
    }
    console.log('✓ Editable tag chip appears');

    // Type tag name and press Enter
    const tagInput = await page.locator('.tag-input');
    await tagInput.type('enter-tag');
    await tagInput.press('Enter');
    await page.waitForTimeout(1500);

    // Verify editable chip is gone and tag was created
    const editableAfter = await page.locator('.editable-tag').count();
    if (editableAfter > 0) {
      console.log('✗ Editable chip should disappear after Enter');
      process.exit(1);
    }

    const tagChip = await page.locator('.tag-chip[data-tag-name="enter-tag"]');
    const tagExists = await tagChip.count();
    if (tagExists === 0) {
      console.log('✗ Tag should be created after Enter');
      process.exit(1);
    }
    console.log('✓ Tag created successfully with Enter key');

    // ===== Test 2: Tag creation with Space key =====
    console.log('\nTest 2: Tag creation with Space key...');
    const secondSentence = await page.locator('.sentence').nth(1);
    await secondSentence.click();
    await page.waitForTimeout(300);

    await newTagChip.click();
    await page.waitForTimeout(300);

    const tagInput2 = await page.locator('.tag-input');
    await tagInput2.type('space-tag');
    await tagInput2.press(' '); // Space key
    await page.waitForTimeout(1500);

    const tagChip2 = await page.locator('.tag-chip[data-tag-name="space-tag"]');
    const tagExists2 = await tagChip2.count();
    if (tagExists2 === 0) {
      console.log('✗ Tag should be created after Space');
      process.exit(1);
    }
    console.log('✓ Tag created successfully with Space key');

    // ===== Test 3: Tag creation with Tab key =====
    console.log('\nTest 3: Tag creation with Tab key...');
    const thirdSentence = await page.locator('.sentence').nth(2);
    await thirdSentence.click();
    await page.waitForTimeout(300);

    await newTagChip.click();
    await page.waitForTimeout(300);

    const tagInput3 = await page.locator('.tag-input');
    await tagInput3.type('tab-tag');
    await tagInput3.press('Tab');
    await page.waitForTimeout(1500);

    const tagChip3 = await page.locator('.tag-chip[data-tag-name="tab-tag"]');
    const tagExists3 = await tagChip3.count();
    if (tagExists3 === 0) {
      console.log('✗ Tag should be created after Tab');
      process.exit(1);
    }
    console.log('✓ Tag created successfully with Tab key');

    // ===== Test 4: Tag creation with blur (focusout) =====
    console.log('\nTest 4: Tag creation with blur (focusout)...');
    const fourthSentence = await page.locator('.sentence').nth(3);
    await fourthSentence.click();
    await page.waitForTimeout(300);

    await newTagChip.click();
    await page.waitForTimeout(300);

    const tagInput4 = await page.locator('.tag-input');
    await tagInput4.type('blur-tag');
    // Click somewhere else to trigger blur
    await page.locator('#note-input').click();
    await page.waitForTimeout(1500);

    const tagChip4 = await page.locator('.tag-chip[data-tag-name="blur-tag"]');
    const tagExists4 = await tagChip4.count();
    if (tagExists4 === 0) {
      console.log('✗ Tag should be created after blur');
      process.exit(1);
    }
    console.log('✓ Tag created successfully with blur (focusout)');

    // ===== Test 5: Cancel with Escape key =====
    console.log('\nTest 5: Cancel with Escape key...');
    const fifthSentence = await page.locator('.sentence').nth(4);
    await fifthSentence.click();
    await page.waitForTimeout(300);

    await newTagChip.click();
    await page.waitForTimeout(300);

    const tagInput5 = await page.locator('.tag-input');
    await tagInput5.type('escape-tag');
    await tagInput5.press('Escape');
    await page.waitForTimeout(500);

    // Verify tag was NOT created
    const tagChip5 = await page.locator('.tag-chip[data-tag-name="escape-tag"]');
    const tagExists5 = await tagChip5.count();
    if (tagExists5 > 0) {
      console.log('✗ Tag should NOT be created after Escape');
      process.exit(1);
    }

    const editableAfterEsc = await page.locator('.editable-tag').count();
    if (editableAfterEsc > 0) {
      console.log('✗ Editable chip should disappear after Escape');
      process.exit(1);
    }
    console.log('✓ Tag creation cancelled with Escape key');

    // ===== Test 6: Empty tag name should not create tag =====
    console.log('\nTest 6: Empty tag name should not create tag...');

    // Go back to first sentence which has one tag
    await firstSentence.click();
    await page.waitForTimeout(300);

    // Count tags before
    const tagsBefore = await page.locator('.tag-chip:not(.new-tag)').count();

    await newTagChip.click();
    await page.waitForTimeout(300);

    const tagInput6 = await page.locator('.tag-input');
    await tagInput6.press('Enter'); // Press Enter with empty input
    await page.waitForTimeout(500);

    // Count tags after - should be same
    const tagsAfter = await page.locator('.tag-chip:not(.new-tag)').count();
    if (tagsAfter !== tagsBefore) {
      console.log(`✗ Empty tag should not create new tag (had ${tagsBefore}, now ${tagsAfter})`);
      process.exit(1);
    }
    console.log('✓ Empty tag name does not create tag');

    console.log('\n✅ All Inline Tag Input Tests Passed!');

    await cleanupTestAnnotations();

  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
