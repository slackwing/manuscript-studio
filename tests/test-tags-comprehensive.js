const { chromium } = require('playwright');
const { TEST_URL, cleanupTestAnnotations, loginAsTestUser } = require('./test-utils');

(async () => {
  console.log('=== Comprehensive Tags Test ===\n');

  await cleanupTestAnnotations();

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1600, height: 1000 });
  // Auto-accept alerts from the frontend's addNewTag JSON-parse bug on 201 empty body.
  page.on('dialog', async d => { try { await d.accept(); } catch (e) {} });

  let failed = 0;

  // Helper: add a tag via the per-note UI. Waits for the POST to be observed
  // via network response so we know the tag was persisted before moving on.
  // Retries on 500 (which can happen if the tag POST races with annotation
  // creation or migration metadata not yet loaded).
  async function addTagViaUI(tagName) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const newTag = page.locator('.sticky-note:not(.uncreated-note) .tag-chip.new-tag').first();
      await newTag.scrollIntoViewIfNeeded();
      await newTag.click({ force: true });
      await page.waitForSelector('.sticky-note:not(.uncreated-note) .tag-input', { timeout: 5000 });
      const input = page.locator('.sticky-note:not(.uncreated-note) .tag-input').first();
      await input.type(tagName, { delay: 5 });
      const responsePromise = page.waitForResponse(
        r => /\/api\/annotations\/\d+\/tags$/.test(r.url()) && r.request().method() === 'POST',
        { timeout: 8000 }
      );
      await input.press('Enter');
      try {
        const resp = await responsePromise;
        if (resp.ok()) {
          await page.waitForTimeout(400);
          return;
        }
        console.log(`  tag POST attempt ${attempt + 1} failed: ${resp.status()}`);
      } catch (e) {
        console.log(`  tag POST wait timed out (attempt ${attempt + 1})`);
      }
      await page.waitForTimeout(800);
    }
    throw new Error(`Failed to add tag "${tagName}" after 3 attempts`);
  }

  // Helper: navigate away and back to re-fetch annotations from API.
  async function refreshSentence(sentenceId) {
    await page.locator('.sentence').nth(20).click();
    await page.waitForTimeout(400);
    await page.locator(`.sentence[data-sentence-id="${sentenceId}"]`).first().click();
    await page.waitForSelector('.sticky-note:not(.uncreated-note)', { timeout: 5000 });
    await page.waitForTimeout(800);
  }

  // Helper: create a yellow annotation on the selected sentence by clicking
  // the palette's yellow circle. Checks for success between attempts to avoid
  // double-creating annotations on retry.
  async function createYellowAnnotation() {
    for (let attempt = 0; attempt < 3; attempt++) {
      // If a real sticky note already exists, we're done.
      if ((await page.locator('.sticky-note:not(.uncreated-note)').count()) > 0) return;
      try {
        await page.locator('.sticky-note.uncreated-note .sticky-note-color-circle').first().hover({ force: true });
        await page.waitForTimeout(400);
        await page.waitForSelector('.sticky-note.uncreated-note .sticky-note-palette.visible', { timeout: 2000 });
        await page.locator('.sticky-note.uncreated-note .color-circle[data-color="yellow"]').first().click({ force: true });
        await page.waitForSelector('.sticky-note:not(.uncreated-note)', { timeout: 5000 });
        await page.waitForTimeout(800);
        return;
      } catch (e) {
        if (attempt === 2) throw e;
        await page.waitForTimeout(500);
      }
    }
  }

  try {
    await loginAsTestUser(page);
    await page.goto(TEST_URL);
    await page.waitForSelector('.pagedjs_page', { timeout: 30000 });
    await page.waitForSelector('.sentence', { timeout: 5000 });
    await page.waitForTimeout(2000);

    console.log('✓ Page loaded\n');

    // ========================================
    // Test 1: Tag added to a yellow annotation is visible
    // ========================================
    console.log('TEST 1: Tag added to a real annotation is rendered after refresh');
    const firstSentence = await page.locator('.sentence').first();
    const sentenceId = await firstSentence.getAttribute('data-sentence-id');
    await firstSentence.click();
    await page.waitForSelector('.sticky-note.uncreated-note', { timeout: 5000 });
    await page.waitForTimeout(500);

    await createYellowAnnotation();
    // Extra wait to ensure annotation is fully saved server-side before tagging
    await page.waitForTimeout(800);
    await addTagViaUI('comp-tag-one');
    await refreshSentence(sentenceId);

    // Sentence backgrounds aren't tinted by annotation presence anymore;
    // a yellow annotation surfaces as a yellow rainbow side-bar.
    const yellowBar = await page.locator(`.rainbow-bar[data-sentence-id="${sentenceId}"][data-color="yellow"]`).count();
    const hasTag1 = await page.locator('.sticky-note:not(.uncreated-note) .tag-chip[data-tag-name="comp-tag-one"]').count();
    if (yellowBar > 0 && hasTag1 > 0) {
      console.log('✓ Yellow annotation has tag "comp-tag-one"\n');
    } else {
      console.log(`✗ Expected yellow bar + tag (yellow bar=${yellowBar}, tag=${hasTag1})\n`);
      failed++;
    }

    // ========================================
    // Test 2: Manual color change from yellow → green keeps the tag
    // ========================================
    console.log('TEST 2: Manual color change persists tag');
    for (let i = 0; i < 3; i++) {
      try {
        await page.locator('.sticky-note:not(.uncreated-note) .sticky-note-color-circle').first().hover({ force: true });
        await page.waitForTimeout(400);
        await page.waitForSelector('.sticky-note:not(.uncreated-note) .sticky-note-palette.visible', { timeout: 2000 });
        await page.locator('.sticky-note:not(.uncreated-note) .color-circle[data-color="green"]').first().click({ force: true });
        await page.waitForSelector(`.rainbow-bar[data-sentence-id="${sentenceId}"][data-color="green"]`, { timeout: 3000 });
        await page.waitForTimeout(800);
        break;
      } catch (e) {
        if (i === 2) throw e;
        await page.waitForTimeout(400);
      }
    }

    const greenBar = await page.locator(`.rainbow-bar[data-sentence-id="${sentenceId}"][data-color="green"]`).count();
    const stillHasTag1 = await page.locator('.sticky-note:not(.uncreated-note) .tag-chip[data-tag-name="comp-tag-one"]').count();
    if (greenBar > 0 && stillHasTag1 > 0) {
      console.log('✓ Color change yellow → green; tag persists\n');
    } else {
      console.log(`✗ Expected green bar + tag (green bar=${greenBar}, tag=${stillHasTag1})\n`);
      failed++;
    }

    // ========================================
    // Test 3: Remove the single tag — annotation still exists (it has a color)
    // ========================================
    console.log('TEST 3: Remove last tag — annotation still present');
    await page.locator('.sticky-note:not(.uncreated-note) .tag-chip[data-tag-name="comp-tag-one"] .tag-chip-remove').first().click();
    await page.waitForTimeout(800);

    const greenBarStill = await page.locator(`.rainbow-bar[data-sentence-id="${sentenceId}"][data-color="green"]`).count();
    const tagGone = await page.locator('.sticky-note:not(.uncreated-note) .tag-chip[data-tag-name="comp-tag-one"]').count();
    if (greenBarStill > 0 && tagGone === 0) {
      console.log('✓ Tag removed; annotation persists (green bar)\n');
    } else {
      console.log(`✗ Expected annotation to persist after tag removal (green bar=${greenBarStill}, tag=${tagGone})\n`);
      failed++;
    }

    // ========================================
    // Test 4: Tags persist when navigating between sentences
    // ========================================
    console.log('TEST 4: Tags persist across sentence navigation');

    const thirdSentence = await page.locator('.sentence').nth(2);
    const sentenceId3 = await thirdSentence.getAttribute('data-sentence-id');
    await thirdSentence.click();
    await page.waitForSelector('.sticky-note.uncreated-note', { timeout: 5000 });
    await page.waitForTimeout(500);

    await createYellowAnnotation();
    await addTagViaUI('persist-tag');
    await refreshSentence(sentenceId3);

    const onSentence3 = await page.locator('.sticky-note:not(.uncreated-note) .tag-chip[data-tag-name="persist-tag"]').count();
    if (onSentence3 !== 1) {
      console.log(`✗ Tag should be present on sentence 3 (got ${onSentence3})`);
      failed++;
    }

    // Navigate to another sentence, then back
    await page.locator('.sentence').nth(10).click();
    await page.waitForTimeout(500);
    await page.locator(`.sentence[data-sentence-id="${sentenceId3}"]`).first().click();
    await page.waitForSelector('.sticky-note:not(.uncreated-note) .tag-chip[data-tag-name="persist-tag"]', { timeout: 5000 });
    await page.waitForTimeout(500);

    const onReturn = await page.locator('.sticky-note:not(.uncreated-note) .tag-chip[data-tag-name="persist-tag"]').count();
    if (onReturn === 1) {
      console.log('✓ Tag persists when navigating between sentences\n');
    } else {
      console.log(`✗ Tag should persist after navigation (got ${onReturn})\n`);
      failed++;
    }

    // ========================================
    // Test 5: Multiple tags on one annotation
    // ========================================
    console.log('TEST 5: Multiple tags support');

    const fifthSentence = await page.locator('.sentence').nth(4);
    const sentenceId5 = await fifthSentence.getAttribute('data-sentence-id');
    await fifthSentence.click();
    await page.waitForSelector('.sticky-note.uncreated-note', { timeout: 5000 });
    await page.waitForTimeout(500);

    await createYellowAnnotation();

    // Add three tags via UI. Used to bypass to API for the 2nd+3rd tag
    // because the tag-add response was empty and the JSON parse popped
    // an alert; the API now returns {tags: [...]} so chaining is reliable.
    await addTagViaUI('tag-one');
    await page.waitForTimeout(500);
    await addTagViaUI('tag-two');
    await page.waitForTimeout(500);
    await addTagViaUI('tag-three');
    await page.waitForTimeout(500);
    await refreshSentence(sentenceId5);

    const multiTagCount = await page.locator('.sticky-note:not(.uncreated-note) .tag-chip:not(.new-tag)').count();
    if (multiTagCount === 3) {
      console.log('✓ Multiple tags work\n');
    } else {
      console.log(`✗ Should have 3 tags, got ${multiTagCount}\n`);
      failed++;
    }

    console.log('[CLEANUP] Deleting test annotations...');
    await cleanupTestAnnotations();

    if (failed > 0) {
      console.log(`\n❌ ${failed} assertion(s) failed`);
      process.exit(1);
    } else {
      console.log('\n✅ Comprehensive Tags Test Complete!');
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
