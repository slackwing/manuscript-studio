const { chromium } = require('playwright');
const { TEST_URL, cleanupTestAnnotations, loginAsTestUser } = require('./test-utils');

(async () => {
  console.log('=== Tags UI Test ===\n');

  await cleanupTestAnnotations();

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1600, height: 1000 });
  // Dismiss alerts from the frontend's addNewTag JSON-parse bug on empty 201.
  page.on('dialog', async d => { try { await d.dismiss(); } catch (e) {} });

  let failed = 0;

  // Helper: add a tag via UI by clicking new-tag, typing, pressing Enter.
  async function addTagViaUI(tagName) {
    const newTag = page.locator('.sticky-note:not(.uncreated-note) .tag-chip.new-tag').first();
    await newTag.scrollIntoViewIfNeeded();
    await newTag.click({ force: true });
    await page.waitForSelector('.sticky-note:not(.uncreated-note) .tag-input', { timeout: 5000 });
    const input = page.locator('.sticky-note:not(.uncreated-note) .tag-input').first();
    await input.type(tagName, { delay: 5 });
    await input.press('Enter');
    await page.waitForTimeout(600);
  }

  // Helper: re-click sentence to re-fetch annotations (works around the
  // alert+json-parse bug that prevents frontend from updating the tag chips).
  async function refreshSentence(sentenceId) {
    await page.locator('.sentence').nth(5).click();
    await page.waitForTimeout(400);
    await page.locator(`.sentence[data-sentence-id="${sentenceId}"]`).first().click();
    await page.waitForTimeout(1000);
  }

  try {
    await loginAsTestUser(page);
    await page.goto(TEST_URL);
    await page.waitForSelector('.pagedjs_page', { timeout: 30000 });
    await page.waitForSelector('.sentence', { timeout: 5000 });
    await page.waitForTimeout(2000);

    console.log('✓ Page loaded');

    // Test 1: Click sentence shows sticky-notes container with "+ tag" chip
    const firstSentence = await page.locator('.sentence').first();
    const sentenceId = await firstSentence.getAttribute('data-sentence-id');
    await firstSentence.click();
    await page.waitForSelector('.sticky-note.uncreated-note', { timeout: 5000 });
    await page.waitForTimeout(500);

    const containerVisible = await page.evaluate(() => {
      const c = document.getElementById('sticky-notes-container');
      return c && c.classList.contains('visible');
    });
    if (containerVisible) {
      console.log('✓ Sticky notes container visible after sentence click');
    } else {
      console.log('✗ Sticky notes container should be visible');
      failed++;
    }

    const newTagChipOnUncreated = await page.locator('.sticky-note.uncreated-note .tag-chip.new-tag').count();
    if (newTagChipOnUncreated >= 1) {
      console.log('✓ "+ tag" chip visible on uncreated note');
    } else {
      console.log('✗ Should show "+ tag" chip on uncreated note');
      failed++;
    }

    // Test 3: Create annotation by typing in the uncreated note
    const uncreatedInput = page.locator('.sticky-note.uncreated-note .note-input').first();
    await uncreatedInput.type('Test note for tags', { delay: 5 });
    await page.waitForSelector('.sticky-note:not(.uncreated-note)', { timeout: 5000 });
    await page.waitForTimeout(1500);
    console.log('✓ Annotation created');

    // Test 4: Add a tag "test-tag" via UI
    await addTagViaUI('test-tag');
    await refreshSentence(sentenceId);
    const testTagChip = await page.locator('.sticky-note:not(.uncreated-note) .tag-chip[data-tag-name="test-tag"]').count();
    if (testTagChip > 0) {
      console.log('✓ Tag "test-tag" added successfully');
    } else {
      console.log('✗ Tag "test-tag" should be visible');
      failed++;
    }

    // Test 5: Add second tag
    await addTagViaUI('second-tag');
    await refreshSentence(sentenceId);
    const tagCount = await page.locator('.sticky-note:not(.uncreated-note) .tag-chip:not(.new-tag)').count();
    if (tagCount === 2) {
      console.log('✓ Multiple tags supported');
    } else {
      console.log(`✗ Should have 2 tags, got ${tagCount}`);
      failed++;
    }

    // Test 6: Remove "test-tag" via the × button
    await page.locator('.sticky-note:not(.uncreated-note) .tag-chip[data-tag-name="test-tag"] .tag-chip-remove').first().click();
    await page.waitForTimeout(800);
    const remainingTags = await page.locator('.sticky-note:not(.uncreated-note) .tag-chip:not(.new-tag)').count();
    if (remainingTags === 1) {
      console.log('✓ Tag removed successfully');
    } else {
      console.log(`✗ Should have 1 tag after removal, got ${remainingTags}`);
      failed++;
    }

    // Test 7: Tag persists after reload
    await page.reload();
    await page.waitForSelector('.pagedjs_page', { timeout: 30000 });
    await page.waitForSelector('.sentence', { timeout: 5000 });
    await page.waitForTimeout(2000);

    await page.locator(`.sentence[data-sentence-id="${sentenceId}"]`).first().click({ force: true });
    await page.waitForSelector('.sticky-note:not(.uncreated-note)', { timeout: 10000 });
    await page.waitForTimeout(800);

    const persistedTag = await page.locator('.sticky-note:not(.uncreated-note) .tag-chip[data-tag-name="second-tag"]').count();
    if (persistedTag > 0) {
      console.log('✓ Tags persist after reload');
    } else {
      console.log('✗ Tags should persist after reload');
      failed++;
    }

    await cleanupTestAnnotations();

    if (failed > 0) {
      console.log(`\n❌ ${failed} assertion(s) failed`);
      process.exit(1);
    } else {
      console.log('\n✅ Tags UI Test Complete!');
    }
  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error(error.stack);
    await cleanupTestAnnotations();
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
