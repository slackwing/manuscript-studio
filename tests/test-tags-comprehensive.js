const { chromium } = require('playwright');
const { TEST_URL, cleanupTestAnnotations } = require('./test-utils');

(async () => {
  console.log('=== Comprehensive Tags Test ===\n');

  await cleanupTestAnnotations();

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // Listen for browser console logs
  page.on('console', msg => {
    const text = msg.text();
    if (text.includes('[addNewTag]') || text.includes('[removeTag]') || text.includes('[updateColor]') || text.includes('[showAnnotations]')) {
      console.log('BROWSER:', text);
    }
  });

  // Global dialog handler with queue
  const dialogQueue = [];
  page.on('dialog', async dialog => {
    if (dialog.type() === 'prompt' && dialogQueue.length > 0) {
      const response = dialogQueue.shift();
      await dialog.accept(response);
    } else {
      await dialog.accept();
    }
  });

  try {
  // Login first
  await loginAsTestUser(page);

    await page.goto(TEST_URL);
    await page.waitForSelector('.pagedjs_page', { timeout: 30000 });
    await page.waitForSelector('.sentence', { timeout: 5000 });
    await page.waitForTimeout(2000);

    console.log('✓ Page loaded\n');

    // ========================================
    // Test 1: Add tag with NO existing annotation auto-creates blue annotation
    // ========================================
    console.log('TEST 1: Add tag with no annotation should auto-create blue annotation');
    const firstSentence = await page.locator('.sentence').first();
    const sentenceId = await firstSentence.getAttribute('data-sentence-id');
    await firstSentence.click();
    await page.waitForTimeout(300);

    // Add a tag directly WITHOUT creating annotation first
    // This should auto-create a blue annotation
    dialogQueue.push('auto-blue-tag');
    await page.locator('.tag-chip.new-tag').click();
    await page.waitForTimeout(2500); // Wait for annotation creation + tag add + DOM update

    const hasBlue = await page.locator(`.sentence[data-sentence-id="${sentenceId}"].highlight-blue`).count();
    if (hasBlue > 0) {
      console.log('✓ Adding tag auto-creates blue annotation\n');
    } else {
      console.log('✗ Should auto-create blue annotation when adding tag\n');
    }

    // ========================================
    // Test 2: Manual color change commits annotation
    // ========================================
    console.log('TEST 2: Manual color change should commit annotation');

    // Click yellow circle to manually change color
    await page.locator('.color-circle[data-color="yellow"]').click();
    await page.waitForTimeout(500);

    const hasYellow = await page.locator(`.sentence[data-sentence-id="${sentenceId}"].highlight-yellow`).count();
    if (hasYellow > 0) {
      console.log('✓ Manual color change works');
    } else {
      console.log('✗ Manual color change failed');
    }

    // Now remove the tag - annotation should NOT be deleted
    // because we manually changed the color (committed it)
    await page.locator('.tag-chip[data-tag-name="auto-blue-tag"] .tag-chip-remove').click();
    await page.waitForTimeout(500);

    // Yellow highlight should still be there because we committed via manual color change
    const stillYellow = await page.locator(`.sentence[data-sentence-id="${sentenceId}"].highlight-yellow`).count();
    if (stillYellow > 0) {
      console.log('✓ Manual color change commits annotation (not auto-deleted)\n');
    } else {
      console.log('✗ Annotation should persist after manual color change\n');
    }

    // Clean up - click same color to toggle off (will trigger delete confirmation)
    await page.locator('.color-circle[data-color="yellow"]').click();
    await page.waitForTimeout(500);

    // ========================================
    // Test 3: Session-based undo for tags (no-tag → tag → no-tag)
    // ========================================
    console.log('TEST 3: Session-based undo (no-tag → tag → no-tag)');

    // Click a new sentence
    const secondSentence = await page.locator('.sentence').nth(1);
    const sentenceId2 = await secondSentence.getAttribute('data-sentence-id');
    await secondSentence.click();
    await page.waitForTimeout(300);

    // Add a tag with NO note (should auto-create blue annotation)
    dialogQueue.push('undo-test-tag');
    await page.locator('.tag-chip.new-tag').click();
    await page.waitForTimeout(1500);

    const hasBlue2 = await page.locator(`.sentence[data-sentence-id="${sentenceId2}"].highlight-blue`).count();
    if (hasBlue2 > 0) {
      console.log('✓ Tag auto-created blue annotation');
    }

    // Now remove the tag (back to nothing) - should delete annotation
    await page.locator('.tag-chip[data-tag-name="undo-test-tag"] .tag-chip-remove').click();
    await page.waitForTimeout(500);

    // Blue should be gone (annotation deleted)
    const noBlue = await page.locator(`.sentence[data-sentence-id="${sentenceId2}"].highlight-blue`).count();
    if (noBlue === 0) {
      console.log('✓ Session-based undo works (annotation auto-deleted)\n');
    } else {
      console.log('✗ Annotation should be auto-deleted when reverting to nothing\n');
    }

    // ========================================
    // Test 4: Tags persist when navigating between sentences
    // ========================================
    console.log('TEST 4: Tags persist when navigating between sentences');

    const thirdSentence = await page.locator('.sentence').nth(2);
    const sentenceId3 = await thirdSentence.getAttribute('data-sentence-id');
    await thirdSentence.click();
    await page.waitForTimeout(300);

    // Add a tag
    dialogQueue.push('persist-tag');
    await page.locator('.tag-chip.new-tag').click();
    await page.waitForTimeout(1500);

    // Verify tag is there
    let tagCount = await page.locator('.tag-chip[data-tag-name="persist-tag"]').count();
    if (tagCount === 1) {
      console.log('✓ Tag added');
    }

    // Navigate to a different sentence
    const fourthSentence = await page.locator('.sentence').nth(3);
    await fourthSentence.click();
    await page.waitForTimeout(300);

    // Navigate back to the original sentence
    await page.locator(`.sentence[data-sentence-id="${sentenceId3}"]`).first().click();
    await page.waitForTimeout(1000);

    // Check if tag is still there
    tagCount = await page.locator('.tag-chip[data-tag-name="persist-tag"]').count();
    if (tagCount === 1) {
      console.log('✓ Tag persists when navigating between sentences\n');
    } else {
      console.log('✗ Tag should persist when navigating between sentences\n');
    }

    // Clean up
    await page.locator('.tag-chip[data-tag-name="persist-tag"] .tag-chip-remove').click();
    await page.waitForTimeout(500);

    // ========================================
    // Test 5: Multiple tags
    // ========================================
    console.log('TEST 5: Multiple tags support');

    const fifthSentence = await page.locator('.sentence').nth(4);
    await fifthSentence.click();
    await page.waitForTimeout(300);

    // Add first tag (should auto-create blue annotation)
    dialogQueue.push('tag-one');
    await page.locator('.tag-chip.new-tag').click();
    await page.waitForTimeout(1500);

    // Add second tag
    dialogQueue.push('tag-two');
    await page.locator('.tag-chip.new-tag').click();
    await page.waitForTimeout(1000);

    // Add third tag
    dialogQueue.push('tag-three');
    await page.locator('.tag-chip.new-tag').click();
    await page.waitForTimeout(1000);

    const multiTagCount = await page.locator('.tag-chip:not(.new-tag)').count();
    if (multiTagCount === 3) {
      console.log('✓ Multiple tags work\n');
    } else {
      console.log(`✗ Should have 3 tags, got ${multiTagCount}\n`);
    }

    console.log('[CLEANUP] Deleting test annotations...');
    await cleanupTestAnnotations();

    console.log('\n✅ Comprehensive Tags Test Complete!');

  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
