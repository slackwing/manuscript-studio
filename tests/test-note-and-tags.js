const { chromium } = require('playwright');
const { TEST_URL, cleanupTestAnnotations, loginAsTestUser } = require('./test-utils');

(async () => {
  console.log('=== Note and Tags Test ===\n');

  await cleanupTestAnnotations();

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1600, height: 1000 });
  // Dismiss any stray alerts from the frontend (addNewTag has a 201-empty-body
  // JSON parse bug that triggers an alert; the tag is persisted regardless).
  page.on('dialog', async d => { try { await d.dismiss(); } catch (e) {} });

  let failed = 0;

  try {
    await loginAsTestUser(page);
    await page.goto(TEST_URL);
    await page.waitForSelector('.pagedjs_page', { timeout: 30000 });
    await page.waitForSelector('.sentence', { timeout: 5000 });
    await page.waitForTimeout(2000);

    console.log('✓ Page loaded');

    // Test 1: Sticky notes container hidden initially (no sentence selected)
    const hiddenInitially = await page.evaluate(() => {
      const c = document.getElementById('sticky-notes-container');
      return !c || !c.classList.contains('visible');
    });
    if (hiddenInitially) {
      console.log('✓ Sticky notes container hidden initially');
    } else {
      console.log('✗ Sticky notes container should be hidden initially');
      failed++;
    }

    // Test 2: Click sentence shows uncreated sticky note with palette on hover
    const firstSentence = await page.locator('.sentence').first();
    const sentenceId = await firstSentence.getAttribute('data-sentence-id');
    await firstSentence.click();
    await page.waitForSelector('.sticky-note.uncreated-note', { timeout: 5000 });
    await page.waitForTimeout(500);

    const uncreatedCount = await page.locator('.sticky-note.uncreated-note').count();
    const containerVisible = await page.evaluate(() => {
      const c = document.getElementById('sticky-notes-container');
      return c && c.classList.contains('visible');
    });
    if (uncreatedCount >= 1 && containerVisible) {
      console.log('✓ Uncreated sticky note shown after sentence click');
    } else {
      console.log(`✗ Uncreated sticky note not shown (count=${uncreatedCount}, containerVisible=${containerVisible})`);
      failed++;
    }

    // Test 3: Hover reveals per-note palette
    await page.locator('.sticky-note.uncreated-note .sticky-note-color-circle').first().hover({ force: true });
    await page.waitForTimeout(400);
    const paletteVisible = await page.evaluate(() => {
      return !!document.querySelector('.sticky-note.uncreated-note .sticky-note-palette.visible');
    });
    if (paletteVisible) {
      console.log('✓ Per-note palette visible on color-circle hover');
    } else {
      console.log('✗ Per-note palette should be visible on hover');
      failed++;
    }

    // Test 4: Palette contains 6 color circles
    const circleCount = await page.locator('.sticky-note.uncreated-note .sticky-note-palette .color-circle').count();
    if (circleCount === 6) {
      console.log(`✓ Palette has 6 color circles`);
    } else {
      console.log(`✗ Expected 6 color circles, got ${circleCount}`);
      failed++;
    }

    // Test 5: Typing in the note-input auto-creates a yellow annotation (default color)
    const uncreatedNoteInput = page.locator('.sticky-note.uncreated-note .note-input').first();
    await uncreatedNoteInput.type('Test note', { delay: 5 });
    await page.waitForTimeout(1500);

    const hasYellow = await page.locator(`.sentence[data-sentence-id="${sentenceId}"].highlight-yellow`).count();
    if (hasYellow > 0) {
      console.log('✓ Typing auto-creates a yellow-highlighted annotation');
    } else {
      console.log('✗ Should auto-default to yellow highlight when typing');
      failed++;
    }

    // Test 6: A real sticky-note with color-yellow class now exists
    const realYellowNoteCount = await page.locator('.sticky-note:not(.uncreated-note).color-yellow').count();
    if (realYellowNoteCount >= 1) {
      console.log('✓ Real color-yellow sticky note exists');
    } else {
      console.log('✗ Real color-yellow sticky note not found');
      failed++;
    }

    // Test 7: Change color to blue via the palette on the real note.
    // Retry: palette has a 200ms mouseleave delay that flakes single-shot hover.
    for (let i = 0; i < 3; i++) {
      try {
        await page.locator('.sticky-note:not(.uncreated-note) .sticky-note-color-circle').first().hover({ force: true });
        await page.waitForTimeout(400);
        await page.waitForSelector('.sticky-note:not(.uncreated-note) .sticky-note-palette.visible', { timeout: 2000 });
        await page.locator('.sticky-note:not(.uncreated-note) .color-circle[data-color="blue"]').first().click({ force: true });
        await page.waitForTimeout(1200);
        break;
      } catch (e) {
        if (i === 2) throw e;
        await page.waitForTimeout(400);
      }
    }

    const hasBlueNow = await page.locator(`.sentence[data-sentence-id="${sentenceId}"].highlight-blue`).count();
    const hasYellowStill = await page.locator(`.sentence[data-sentence-id="${sentenceId}"].highlight-yellow`).count();
    if (hasBlueNow > 0 && hasYellowStill === 0) {
      console.log('✓ Manually changing color yellow → blue works');
    } else {
      console.log(`✗ Color change failed (blue=${hasBlueNow}, yellow still=${hasYellowStill})`);
      failed++;
    }

    // Test 8: new-tag chip present
    const newTagChip = await page.locator('.sticky-note:not(.uncreated-note) .tag-chip.new-tag').count();
    if (newTagChip >= 1) {
      console.log('✓ "+ tag" chip visible on real note');
    } else {
      console.log('✗ "+ tag" chip missing');
      failed++;
    }

    // Test 9: Note text and color persist after reload
    const noteInput = page.locator('.sticky-note:not(.uncreated-note) .note-input').first();
    await noteInput.click();
    await noteInput.fill('');
    await noteInput.type('Test note more text', { delay: 5 });
    await page.waitForTimeout(1500); // auto-save

    await page.reload();
    await page.waitForSelector('.pagedjs_page', { timeout: 30000 });
    await page.waitForSelector('.sentence', { timeout: 5000 });
    await page.waitForTimeout(2000);

    await page.locator(`.sentence[data-sentence-id="${sentenceId}"]`).first().click({ force: true });
    await page.waitForSelector('.sticky-note:not(.uncreated-note) .note-input', { timeout: 10000 });
    await page.waitForTimeout(800);

    const persistedText = await page.locator('.sticky-note:not(.uncreated-note) .note-input').first().inputValue();
    if (persistedText === 'Test note more text') {
      console.log('✓ Note text persists after reload');
    } else {
      console.log(`✗ Note text should be "Test note more text", got "${persistedText}"`);
      failed++;
    }

    const persistedBlue = await page.locator(`.sentence[data-sentence-id="${sentenceId}"].highlight-blue`).count();
    if (persistedBlue > 0) {
      console.log('✓ Blue highlight persists after reload');
    } else {
      console.log('✗ Blue highlight should persist after reload');
      failed++;
    }

    console.log('\n[CLEANUP] Deleting test annotations...');
    await cleanupTestAnnotations();

    if (failed > 0) {
      console.log(`\n❌ ${failed} assertion(s) failed`);
      process.exit(1);
    } else {
      console.log('\n✅ Note and Tags Test Complete!');
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
