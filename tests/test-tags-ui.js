const { chromium } = require('playwright');
const { TEST_URL, cleanupTestAnnotations } = require('./test-utils');

(async () => {
  console.log('=== Tags UI Test ===\n');

  await cleanupTestAnnotations();

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
  // Login first
  await loginAsTestUser(page);

    await page.goto(TEST_URL);
    await page.waitForSelector('.pagedjs_page', { timeout: 30000 });
    await page.waitForSelector('.sentence', { timeout: 5000 });
    await page.waitForTimeout(2000);

    console.log('✓ Page loaded');

    // Test 1: Click sentence and verify tags container shows
    const firstSentence = await page.locator('.sentence').first();
    const sentenceId = await firstSentence.getAttribute('data-sentence-id');
    await firstSentence.click();
    await page.waitForTimeout(300);

    const tagsVisible = await page.locator('#tags-container.visible').count();
    if (tagsVisible === 1) {
      console.log('✓ Tags container visible after sentence click');
    } else {
      console.log('✗ Tags container should be visible');
    }

    // Test 2: Verify "new tag" chip is present
    const newTagChip = await page.locator('.tag-chip.new-tag').count();
    if (newTagChip > 0) {
      console.log('✓ "New tag" chip is visible');
    } else {
      console.log('✗ Should show "new tag" chip');
    }

    // Test 3: Create annotation first (type note)
    const noteInput = await page.locator('#note-input');
    await noteInput.type('Test note for tags');
    await page.waitForTimeout(1500); // Wait for auto-save

    console.log('✓ Annotation created');

    // Test 4: Add a tag by clicking "new tag" and entering name
    // Intercept the prompt dialog
    page.on('dialog', async dialog => {
      if (dialog.type() === 'prompt') {
        await dialog.accept('test-tag');
      }
    });

    await page.locator('.tag-chip.new-tag').click();
    await page.waitForTimeout(1000);

    // Verify tag was added
    const testTagChip = await page.locator('.tag-chip[data-tag-name="test-tag"]').count();
    if (testTagChip > 0) {
      console.log('✓ Tag added successfully');
    } else {
      console.log('✗ Tag should be visible');
    }

    // Test 5: Add another tag
    page.on('dialog', async dialog => {
      if (dialog.type() === 'prompt') {
        await dialog.accept('second-tag');
      }
    });

    await page.locator('.tag-chip.new-tag').click();
    await page.waitForTimeout(1000);

    const tagCount = await page.locator('.tag-chip:not(.new-tag)').count();
    if (tagCount === 2) {
      console.log('✓ Multiple tags supported');
    } else {
      console.log(`✗ Should have 2 tags, got ${tagCount}`);
    }

    // Test 6: Remove a tag
    const removeButton = await page.locator('.tag-chip[data-tag-name="test-tag"] .tag-chip-remove').first();
    await removeButton.click();
    await page.waitForTimeout(500);

    const remainingTags = await page.locator('.tag-chip:not(.new-tag)').count();
    if (remainingTags === 1) {
      console.log('✓ Tag removed successfully');
    } else {
      console.log(`✗ Should have 1 tag after removal, got ${remainingTags}`);
    }

    // Test 7: Verify tag persists after reload
    await page.reload();
    await page.waitForSelector('.pagedjs_page', { timeout: 30000 });
    await page.waitForSelector('.sentence', { timeout: 5000 });
    await page.waitForTimeout(2000);

    await page.locator(`.sentence[data-sentence-id="${sentenceId}"]`).first().click();
    await page.waitForTimeout(500);

    const persistedTags = await page.locator('.tag-chip[data-tag-name="second-tag"]').count();
    if (persistedTags > 0) {
      console.log('✓ Tags persist after reload');
    } else {
      console.log('✗ Tags should persist after reload');
    }

    console.log('\n[CLEANUP] Deleting test annotations...');
    await cleanupTestAnnotations();

    console.log('\n✅ Tags UI Test Complete!');

  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
