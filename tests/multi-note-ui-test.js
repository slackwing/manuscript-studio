const { chromium } = require('playwright');
const { TEST_URL, loginAsTestUser } = require('./test-utils');

(async () => {
  console.log('\n=== Multi-Note UI Test ===\n');

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1920, height: 1080 });

  let testsPassed = 0;
  let testsFailed = 0;

  try {
    // Navigate to app
    console.log('Loading WriteSys...');
  // Login first
  await loginAsTestUser(page);

    await page.goto(TEST_URL, { waitUntil: 'networkidle', timeout: 10000 });

    // Wait for manuscript to load
    console.log('Waiting for manuscript to render...');
    await page.waitForSelector('.sentence', { timeout: 15000 });
    await new Promise(r => setTimeout(r, 2000)); // Extra wait for full render

    // Test 1: Click first sentence
    console.log('\nTest 1: Click first sentence');
    const firstSentence = await page.$('.sentence');
    if (!firstSentence) {
      throw new Error('No sentences found');
    }
    await firstSentence.click();
    await new Promise(r => setTimeout(r, 500));

    // Verify sticky notes container appears
    const containerVisible = await page.evaluate(() => {
      const container = document.getElementById('sticky-notes-container');
      return container && container.classList.contains('visible');
    });

    if (containerVisible) {
      console.log('  ✓ Sticky notes container is visible');
      testsPassed++;
    } else {
      console.log('  ✗ Sticky notes container is NOT visible');
      testsFailed++;
    }

    // Test 2: Verify "add new note" element exists
    console.log('\nTest 2: Verify "add new note" element exists');
    const addNewNoteExists = await page.evaluate(() => {
      return document.querySelector('.sticky-note.uncreated-note') !== null;
    });

    if (addNewNoteExists) {
      console.log('  ✓ "Add new note" element exists');
      testsPassed++;
    } else {
      console.log('  ✗ "Add new note" element NOT found');
      testsFailed++;
    }

    // Test 3: Verify sentence preview appears
    console.log('\nTest 3: Verify sentence preview appears');
    const previewVisible = await page.evaluate(() => {
      const preview = document.getElementById('sentence-preview');
      return preview && preview.classList.contains('visible');
    });

    if (previewVisible) {
      console.log('  ✓ Sentence preview is visible');
      testsPassed++;
    } else {
      console.log('  ✗ Sentence preview is NOT visible');
      testsFailed++;
    }

    // Test 4: Hover over "add new note" to verify color circle appears
    console.log('\nTest 4: Hover over "add new note" to verify color circle appears');
    await page.hover('.sticky-note.uncreated-note');
    await new Promise(r => setTimeout(r, 300));

    const colorCircleVisible = await page.evaluate(() => {
      const circle = document.querySelector('.sticky-note.uncreated-note .sticky-note-color-circle');
      if (!circle) return false;
      const styles = window.getComputedStyle(circle);
      return styles.opacity !== '0';
    });

    if (colorCircleVisible) {
      console.log('  ✓ Color circle appears on hover');
      testsPassed++;
    } else {
      console.log('  ✗ Color circle does NOT appear on hover');
      testsFailed++;
    }

    // Take screenshot of initial state
    console.log('\nTaking screenshot: multi-note-initial.png');
    await page.screenshot({
      path: 'tests/screenshots/multi-note-initial.png',
      fullPage: false
    });

    // Test 5: Click color circle to open palette
    console.log('\nTest 5: Click color circle to open palette');
    await page.hover('.sticky-note.uncreated-note .sticky-note-color-circle');
    await new Promise(r => setTimeout(r, 300));

    const paletteVisible = await page.evaluate(() => {
      const palette = document.querySelector('.sticky-note.uncreated-note .sticky-note-palette');
      return palette && palette.classList.contains('visible');
    });

    if (paletteVisible) {
      console.log('  ✓ Palette appears on color circle hover');
      testsPassed++;
    } else {
      console.log('  ✗ Palette does NOT appear');
      testsFailed++;
    }

    // Take screenshot of palette
    console.log('Taking screenshot: multi-note-palette.png');
    await page.screenshot({
      path: 'tests/screenshots/multi-note-palette.png',
      fullPage: false
    });

    // Test 6: Click a color from palette to create first note
    console.log('\nTest 6: Click yellow color to create first note');
    const yellowCircle = await page.$('.sticky-note.uncreated-note .sticky-note-palette .color-circle[data-color="yellow"]');
    if (!yellowCircle) {
      throw new Error('Yellow color circle not found in palette');
    }
    await yellowCircle.click();
    await new Promise(r => setTimeout(r, 1000)); // Wait for API call and re-render

    // Verify a sticky note was created
    const stickyNoteExists = await page.evaluate(() => {
      return document.querySelector('.sticky-note') !== null;
    });

    if (stickyNoteExists) {
      console.log('  ✓ Sticky note was created');
      testsPassed++;
    } else {
      console.log('  ✗ Sticky note was NOT created');
      testsFailed++;
    }

    // Take screenshot after first note
    console.log('Taking screenshot: multi-note-one-note.png');
    await page.screenshot({
      path: 'tests/screenshots/multi-note-one-note.png',
      fullPage: false
    });

    // Test 7: Create a second note
    console.log('\nTest 7: Create a second note (blue)');
    const addNewNote2 = await page.$('.sticky-note.uncreated-note');
    if (!addNewNote2) {
      throw new Error('"Add new note" element not found after creating first note');
    }

    // Hover and click color circle
    await page.hover('.sticky-note.uncreated-note');
    await new Promise(r => setTimeout(r, 300));
    await page.hover('.sticky-note.uncreated-note .sticky-note-color-circle');
    await new Promise(r => setTimeout(r, 300));

    const blueCircle = await page.$('.sticky-note.uncreated-note .sticky-note-palette .color-circle[data-color="blue"]');
    if (!blueCircle) {
      throw new Error('Blue color circle not found in palette');
    }
    await blueCircle.click();
    await new Promise(r => setTimeout(r, 1000));

    // Verify two sticky notes exist (excluding the uncreated-note widget)
    const stickyNoteCount = await page.evaluate(() => {
      return document.querySelectorAll('.sticky-note:not(.uncreated-note)').length;
    });

    if (stickyNoteCount === 2) {
      console.log(`  ✓ Two sticky notes exist (found ${stickyNoteCount})`);
      testsPassed++;
    } else {
      console.log(`  ✗ Expected 2 sticky notes, found ${stickyNoteCount}`);
      testsFailed++;
    }

    // Take screenshot with two notes
    console.log('Taking screenshot: multi-note-two-notes.png');
    await page.screenshot({
      path: 'tests/screenshots/multi-note-two-notes.png',
      fullPage: false
    });

    // Test 8: Verify rainbow gradient on grey note (if we had one)
    // Since we're creating colored notes, let's test that colored notes show their color
    console.log('\nTest 8: Verify first note has yellow color class');
    const firstNoteColor = await page.evaluate(() => {
      const firstNote = document.querySelector('.sticky-note');
      return firstNote && firstNote.classList.contains('color-yellow');
    });

    if (firstNoteColor) {
      console.log('  ✓ First note has yellow color class');
      testsPassed++;
    } else {
      console.log('  ✗ First note does NOT have yellow color class');
      testsFailed++;
    }

    // Test 9: Hover over first sticky note to verify color circle appears
    console.log('\nTest 9: Hover over first sticky note to verify color circle appears');
    await page.hover('.sticky-note:first-of-type');
    await new Promise(r => setTimeout(r, 300));

    const noteColorCircleVisible = await page.evaluate(() => {
      const circle = document.querySelector('.sticky-note:first-of-type .sticky-note-color-circle');
      if (!circle) return false;
      const styles = window.getComputedStyle(circle);
      return styles.opacity !== '0';
    });

    if (noteColorCircleVisible) {
      console.log('  ✓ Color circle appears on note hover');
      testsPassed++;
    } else {
      console.log('  ✗ Color circle does NOT appear on note hover');
      testsFailed++;
    }

    // Take screenshot of hover state
    console.log('Taking screenshot: multi-note-hover.png');
    await page.screenshot({
      path: 'tests/screenshots/multi-note-hover.png',
      fullPage: false
    });

    // Test 10: Test trash confirmation
    console.log('\nTest 10: Test trash confirmation (first click)');
    await page.hover('.sticky-note:not(.uncreated-note)');
    await new Promise(r => setTimeout(r, 300));

    // Click trash icon (lives directly inside the sticky-note, not the palette)
    const trashIcon = await page.$('.sticky-note:not(.uncreated-note) .note-trash');
    if (!trashIcon) {
      throw new Error('Trash icon not found in palette');
    }
    await trashIcon.click();
    await new Promise(r => setTimeout(r, 300));

    // Verify trash is in confirming state
    const trashConfirming = await page.evaluate(() => {
      const trash = document.querySelector('.sticky-note:not(.uncreated-note) .note-trash');
      return trash && trash.classList.contains('confirming');
    });

    if (trashConfirming) {
      console.log('  ✓ Trash icon shows confirmation state');
      testsPassed++;
    } else {
      console.log('  ✗ Trash icon does NOT show confirmation state');
      testsFailed++;
    }

    // Take screenshot of trash confirmation
    console.log('Taking screenshot: multi-note-trash-confirm.png');
    await page.screenshot({
      path: 'tests/screenshots/multi-note-trash-confirm.png',
      fullPage: false
    });

    // Test 11: Actually delete the note (second click)
    console.log('\nTest 11: Actually delete the note (second click)');
    await trashIcon.click();
    await new Promise(r => setTimeout(r, 1000));

    // Verify only one sticky note remains (excluding uncreated-note widget)
    const remainingNotes = await page.evaluate(() => {
      return document.querySelectorAll('.sticky-note:not(.uncreated-note)').length;
    });

    if (remainingNotes === 1) {
      console.log(`  ✓ Note was deleted (${remainingNotes} remaining)`);
      testsPassed++;
    } else {
      console.log(`  ✗ Expected 1 note remaining, found ${remainingNotes}`);
      testsFailed++;
    }

    // Take final screenshot
    console.log('Taking screenshot: multi-note-final.png');
    await page.screenshot({
      path: 'tests/screenshots/multi-note-final.png',
      fullPage: false
    });

  } catch (error) {
    console.error('\n❌ Test error:', error.message);
    testsFailed++;

    // Take error screenshot
    try {
      await page.screenshot({
        path: 'tests/screenshots/multi-note-error.png',
        fullPage: true
      });
      console.log('Error screenshot saved to: tests/screenshots/multi-note-error.png');
    } catch (e) {
      console.error('Failed to take error screenshot:', e.message);
    }
  }

  await browser.close();

  // Summary
  console.log('\n' + '='.repeat(50));
  console.log('TEST SUMMARY');
  console.log('='.repeat(50));
  console.log(`Total tests: ${testsPassed + testsFailed}`);
  console.log(`Passed: ${testsPassed}`);
  console.log(`Failed: ${testsFailed}`);
  console.log('='.repeat(50) + '\n');

  process.exit(testsFailed > 0 ? 1 : 0);
})();
