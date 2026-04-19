const { chromium } = require('playwright');
const { TEST_URL, TEST_MANUSCRIPT_ID, cleanupTestAnnotations } = require('./test-utils');

(async () => {
  console.log('=== Priority/Flag Chips Test ===\n');

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

    // ===== Test 1: P/flag section hidden initially =====
    console.log('Test 1: P/flag section hidden initially...');
    const firstSentence = await page.locator('.sentence').first();
    await firstSentence.click();
    await page.waitForTimeout(300);

    const pfContainerInitial = await page.locator('#priority-flag-container');
    const isHiddenInitial = await pfContainerInitial.evaluate(el => el.style.display === 'none' || !el.offsetParent);

    if (isHiddenInitial) {
      console.log('✓ P/flag section is hidden when no annotation exists');
    } else {
      console.log('✗ P/flag section should be hidden when no annotation exists');
      process.exit(1);
    }

    // ===== Test 2: Visibility after color selection =====
    console.log('\nTest 2: Visibility after color selection...');

    // Select yellow color
    const yellowCircle = await page.locator('.color-circle[data-color="yellow"]');
    await yellowCircle.click();
    await page.waitForTimeout(500);

    const isVisibleAfterColor = await pfContainerInitial.evaluate(el => el.style.display === 'block' && el.offsetParent);

    if (isVisibleAfterColor) {
      console.log('✓ P/flag section is visible after color selection');
    } else {
      console.log('✗ P/flag section should be visible after color selection');
      process.exit(1);
    }

    // Clean up - delete annotation using trash icon
    const trashIcon = await page.locator('#trash-icon');

    // Click trash once (runs away)
    await trashIcon.click();
    await page.waitForTimeout(300);

    // Click trash again (actually deletes)
    await trashIcon.click();
    await page.waitForTimeout(500);

    // ===== Test 3: Visibility after note typing (with blue default) =====
    console.log('\nTest 3: Visibility after note typing (with blue default)...');

    // Click a different sentence
    const secondSentence = await page.locator('.sentence').nth(1);
    const sentenceId2 = await secondSentence.getAttribute('data-sentence-id');
    await secondSentence.click();
    await page.waitForTimeout(300);

    // Type a note (should auto-default to blue)
    const noteInput = await page.locator('#note-input');
    await noteInput.type('T');
    await page.waitForTimeout(1500); // Wait for auto-save

    // Check if blue is applied
    const hasBlue = await secondSentence.evaluate(el => el.classList.contains('highlight-blue'));
    if (!hasBlue) {
      console.log('✗ Should auto-default to blue when typing note');
      process.exit(1);
    }

    // Check if P/flag section is visible
    const isVisibleAfterNote = await pfContainerInitial.evaluate(el => el.style.display === 'block' && el.offsetParent);

    if (isVisibleAfterNote) {
      console.log('✓ P/flag section is visible after note typing with auto-blue default');
    } else {
      console.log('✗ P/flag section should be visible after note typing');
      process.exit(1);
    }

    // Clear the note to trigger undo (should work since no P/flag set)
    await noteInput.fill('');
    await page.waitForTimeout(1500);

    const hasBlueAfterClear = await secondSentence.evaluate(el => el.classList.contains('highlight-blue'));
    if (hasBlueAfterClear) {
      console.log('✗ Auto-blue should be undone when note is cleared (no P/flag)');
      process.exit(1);
    }
    console.log('✓ Auto-blue correctly undone when note cleared (no P/flag set)');

    // ===== Test 4: Test commitment logic when setting P/flag on auto-blue =====
    console.log('\nTest 4: Commitment logic when setting P/flag on auto-blue...');

    // Click third sentence
    const thirdSentence = await page.locator('.sentence').nth(2);
    const sentenceId3 = await thirdSentence.getAttribute('data-sentence-id');
    await thirdSentence.click();
    await page.waitForTimeout(300);

    // Type a note to create auto-blue annotation
    await noteInput.type('x');
    await page.waitForTimeout(1500);

    // Verify blue is applied and P/flag section is visible
    const hasBlueBeforeP0 = await thirdSentence.evaluate(el => el.classList.contains('highlight-blue'));
    if (!hasBlueBeforeP0) {
      console.log('✗ Should have auto-blue before clicking P0');
      process.exit(1);
    }

    // Now click P0 (should mark as committed)
    const p0Chip = await page.locator('.priority-chip[data-priority="P0"]');
    await p0Chip.click();
    await page.waitForTimeout(500);

    // Check if P0 is active
    const isP0Active = await p0Chip.evaluate(el => el.classList.contains('active'));
    if (!isP0Active) {
      console.log('✗ P0 chip should be active');
      process.exit(1);
    }
    console.log('✓ P0 chip active after clicking');

    // ===== Test 5: Test commitment logic - P/flag prevents undo =====
    console.log('\nTest 5: Commitment logic - P/flag prevents undo...');

    // Now try clearing note - should NOT undo because P0 is set (committed)
    await noteInput.fill('test note');
    await page.waitForTimeout(1500);
    await noteInput.fill('');
    await page.waitForTimeout(1500);

    const hasBlueAfterClearCommitted = await thirdSentence.evaluate(el => el.classList.contains('highlight-blue'));
    if (!hasBlueAfterClearCommitted) {
      console.log('✗ Auto-blue should NOT be undone when P/flag is set (committed)');
      process.exit(1);
    }
    console.log('✓ Commitment logic works - P/flag prevents undo');

    // ===== Test 6: Test priority chip radio behavior (P0-P3 mutually exclusive) =====
    console.log('\nTest 6: Priority chip radio behavior...');

    // P0 is already active, click P1
    const p1Chip = await page.locator('.priority-chip[data-priority="P1"]');
    await p1Chip.click();
    await page.waitForTimeout(500);

    const isP0StillActive = await p0Chip.evaluate(el => el.classList.contains('active'));
    const isP1Active = await p1Chip.evaluate(el => el.classList.contains('active'));

    if (isP0StillActive) {
      console.log('✗ P0 should be deactivated when P1 is clicked (radio behavior)');
      process.exit(1);
    }
    if (!isP1Active) {
      console.log('✗ P1 should be active');
      process.exit(1);
    }
    console.log('✓ Priority chips have radio behavior (mutually exclusive)');

    // Test toggle behavior - clicking same priority again should deselect
    await p1Chip.click();
    await page.waitForTimeout(500);

    const isP1StillActive = await p1Chip.evaluate(el => el.classList.contains('active'));
    if (isP1StillActive) {
      console.log('✗ Clicking P1 again should deselect it (toggle)');
      process.exit(1);
    }
    console.log('✓ Priority toggle behavior works');

    // ===== Test 7: Test flag chip toggle behavior (independent) =====
    console.log('\nTest 7: Flag chip toggle behavior...');

    const flagChip = await page.locator('.flag-chip');

    // Click flag
    await flagChip.click();
    await page.waitForTimeout(500);

    const isFlagActive = await flagChip.evaluate(el => el.classList.contains('active'));
    if (!isFlagActive) {
      console.log('✗ Flag should be active after clicking');
      process.exit(1);
    }

    // Set P2 and verify flag is still active (independent)
    const p2Chip = await page.locator('.priority-chip[data-priority="P2"]');
    await p2Chip.click();
    await page.waitForTimeout(500);

    const isFlagStillActive = await flagChip.evaluate(el => el.classList.contains('active'));
    const isP2Active = await p2Chip.evaluate(el => el.classList.contains('active'));

    if (!isFlagStillActive) {
      console.log('✗ Flag should remain active when priority is changed');
      process.exit(1);
    }
    if (!isP2Active) {
      console.log('✗ P2 should be active');
      process.exit(1);
    }
    console.log('✓ Flag is independent of priority');

    // Toggle flag off
    await flagChip.click();
    await page.waitForTimeout(500);

    const isFlagActiveAfterToggle = await flagChip.evaluate(el => el.classList.contains('active'));
    if (isFlagActiveAfterToggle) {
      console.log('✗ Flag should be inactive after toggle');
      process.exit(1);
    }
    console.log('✓ Flag toggle behavior works');

    // ===== Test 8: Test persistence after reload =====
    console.log('\nTest 8: Persistence after reload...');

    // Get annotation data before reload
    const apiUrl = 'http://localhost:5001';
    const annotationsResp = await fetch(`${apiUrl}/api/annotations/sentence/${sentenceId3}`);
    const annotationsData = await annotationsResp.json();
    const annotationId = annotationsData.annotations[0].annotation_id;

    console.log(`  Annotation ID: ${annotationId}, Priority: P2, Flagged: false`);

    // Reload page
    await page.reload();
    await page.waitForSelector('.pagedjs_page', { timeout: 30000 });
    await page.waitForSelector('.sentence', { timeout: 5000 });
    await page.waitForTimeout(2000);

    // Click the same sentence
    const reloadedSentence = await page.locator(`.sentence[data-sentence-id="${sentenceId3}"]`).first();
    await reloadedSentence.click();
    await page.waitForTimeout(500);

    // Check if P2 is still active
    const isP2ActiveAfterReload = await p2Chip.evaluate(el => el.classList.contains('active'));
    const isFlagInactiveAfterReload = await flagChip.evaluate(el => !el.classList.contains('active'));
    const hasBlueAfterReload = await reloadedSentence.evaluate(el => el.classList.contains('highlight-blue'));

    if (!isP2ActiveAfterReload) {
      console.log('✗ P2 should be active after reload');
      process.exit(1);
    }
    if (!isFlagInactiveAfterReload) {
      console.log('✗ Flag should be inactive after reload');
      process.exit(1);
    }
    if (!hasBlueAfterReload) {
      console.log('✗ Blue highlight should persist after reload');
      process.exit(1);
    }
    console.log('✓ P/flag state persists after reload');

    // ===== Test 9: Visibility after tag addition (with blue default) =====
    console.log('\nTest 9: Visibility after tag addition (with blue default)...');

    // Clean up and start fresh
    await cleanupTestAnnotations();
    await page.reload();
    await page.waitForSelector('.pagedjs_page', { timeout: 30000 });
    await page.waitForSelector('.sentence', { timeout: 5000 });
    await page.waitForTimeout(2000);

    // Click fourth sentence
    const fourthSentence = await page.locator('.sentence').nth(3);
    await fourthSentence.click();
    await page.waitForTimeout(300);

    // Add a tag (should create blue annotation)
    const newTagChip = await page.locator('.new-tag');

    // Click to create editable chip
    await newTagChip.click();
    await page.waitForTimeout(300);

    // Type tag name and press Enter
    const tagInput = await page.locator('.tag-input');
    await tagInput.type('test-tag');
    await tagInput.press('Enter');
    await page.waitForTimeout(1500); // Wait for annotation creation and tag addition

    // Check if blue is applied
    const hasBlueTag = await fourthSentence.evaluate(el => el.classList.contains('highlight-blue'));
    if (!hasBlueTag) {
      console.log('✗ Should auto-default to blue when adding tag');
      process.exit(1);
    }

    // Check if P/flag section is visible
    const isVisibleAfterTag = await pfContainerInitial.evaluate(el => el.style.display === 'block' && el.offsetParent);

    if (isVisibleAfterTag) {
      console.log('✓ P/flag section is visible after tag addition with auto-blue default');
    } else {
      console.log('✗ P/flag section should be visible after tag addition');
      process.exit(1);
    }

    console.log('\n✅ All Priority/Flag Tests Passed!');

    await cleanupTestAnnotations();

  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
