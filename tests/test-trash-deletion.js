const { chromium } = require('playwright');
const { TEST_URL, cleanupTestAnnotations, loginAsTestUser } = require('./test-utils');

(async () => {
  console.log('=== Trash Can Deletion Test ===\n');

  await cleanupTestAnnotations();

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1600, height: 1000 });
  page.on('dialog', async d => { try { await d.dismiss(); } catch (e) {} });

  let failed = 0;

  try {
    await loginAsTestUser(page);
    await page.goto(TEST_URL);
    await page.waitForSelector('.pagedjs_page', { timeout: 30000 });
    await page.waitForSelector('.sentence', { timeout: 5000 });
    await page.waitForTimeout(2000);

    // ===== Test 1: Trash appears inside a real sticky note =====
    console.log('Test 1: Trash appears inside a real sticky note...');
    const firstSentence = await page.locator('.sentence').first();
    const sentenceId = await firstSentence.getAttribute('data-sentence-id');
    await firstSentence.click();
    await page.waitForSelector('.sticky-note.uncreated-note', { timeout: 5000 });
    await page.waitForTimeout(500);

    // No trash on uncreated note
    const trashOnUncreated = await page.locator('.sticky-note.uncreated-note .note-trash').count();
    if (trashOnUncreated === 0) {
      console.log('✓ Uncreated note has no trash icon');
    } else {
      console.log(`✗ Uncreated note should have no trash, found ${trashOnUncreated}`);
      failed++;
    }

    // Create yellow annotation (retry hover/click: palette has 200ms mouseleave delay)
    async function createYellow() {
      for (let i = 0; i < 3; i++) {
        try {
          await page.locator('.sticky-note.uncreated-note .sticky-note-color-circle').first().hover({ force: true });
          await page.waitForTimeout(400);
          await page.waitForSelector('.sticky-note.uncreated-note .sticky-note-palette.visible', { timeout: 2000 });
          await page.locator('.sticky-note.uncreated-note .color-circle[data-color="yellow"]').first().click({ force: true });
          await page.waitForSelector('.sticky-note:not(.uncreated-note) .note-trash', { timeout: 5000 });
          await page.waitForTimeout(600);
          return;
        } catch (e) {
          if (i === 2) throw e;
          await page.waitForTimeout(500);
        }
      }
    }
    await createYellow();

    const trashOnReal = await page.locator('.sticky-note:not(.uncreated-note) .note-trash').count();
    if (trashOnReal >= 1) {
      console.log('✓ Trash icon appears on real sticky note');
    } else {
      console.log(`✗ Real sticky note should have trash icon, found ${trashOnReal}`);
      failed++;
    }

    // ===== Test 2: First click enters confirming state =====
    console.log('\nTest 2: First click shows confirmation state...');
    const trash = page.locator('.sticky-note:not(.uncreated-note) .note-trash').first();
    await trash.click();
    await page.waitForTimeout(300);

    const isConfirming = await trash.evaluate(el => el.classList.contains('confirming'));
    if (isConfirming) {
      console.log('✓ Trash has confirming class after first click');
    } else {
      console.log('✗ Trash should have confirming class after first click');
      failed++;
    }

    // ===== Test 3: Confirming state auto-resets after ~2s =====
    console.log('\nTest 3: Confirming state auto-resets (no deletion) after timeout...');
    await page.waitForTimeout(2200);
    const stillConfirming = await trash.evaluate(el => el.classList.contains('confirming'));
    const hasYellow = await page.locator(`.sentence[data-sentence-id="${sentenceId}"].highlight-yellow`).count();
    if (!stillConfirming && hasYellow > 0) {
      console.log('✓ Confirming cleared after timeout; annotation preserved');
    } else {
      console.log(`✗ Expected confirming cleared & annotation preserved (confirming=${stillConfirming}, yellow=${hasYellow})`);
      failed++;
    }

    // ===== Test 4: Two rapid clicks actually delete =====
    console.log('\nTest 4: Two clicks delete the annotation...');
    await trash.click();
    await page.waitForTimeout(200);
    await trash.click();
    await page.waitForTimeout(800);

    const hasYellowAfter = await page.locator(`.sentence[data-sentence-id="${sentenceId}"].highlight-yellow`).count();
    const realNoteCount = await page.locator('.sticky-note:not(.uncreated-note)').count();
    if (hasYellowAfter === 0 && realNoteCount === 0) {
      console.log('✓ Annotation deleted after second trash click');
    } else {
      console.log(`✗ Annotation should be gone (yellow=${hasYellowAfter}, realNotes=${realNoteCount})`);
      failed++;
    }

    // ===== Test 5: Clicking same color again doesn't toggle/delete =====
    console.log('\nTest 5: Clicking same color on a real note does not toggle/delete...');
    const secondSentence = await page.locator('.sentence').nth(1);
    const secondSentenceId = await secondSentence.getAttribute('data-sentence-id');
    await secondSentence.click();
    await page.waitForSelector('.sticky-note.uncreated-note', { timeout: 5000 });
    await page.waitForTimeout(500);

    // Create blue (retry as palette visibility can be flaky)
    let madeBlue = false;
    for (let i = 0; i < 3; i++) {
      try {
        await page.locator('.sticky-note.uncreated-note .sticky-note-color-circle').first().hover({ force: true });
        await page.waitForTimeout(400);
        await page.waitForSelector('.sticky-note.uncreated-note .sticky-note-palette.visible', { timeout: 2000 });
        await page.locator('.sticky-note.uncreated-note .color-circle[data-color="blue"]').first().click({ force: true });
        await page.waitForSelector('.sticky-note:not(.uncreated-note).color-blue', { timeout: 5000 });
        await page.waitForTimeout(600);
        madeBlue = true;
        break;
      } catch (e) {
        if (i === 2) throw e;
        await page.waitForTimeout(500);
      }
    }

    const hasBlue = await page.locator(`.sentence[data-sentence-id="${secondSentenceId}"].highlight-blue`).count();
    if (hasBlue === 0) {
      console.log('✗ Blue highlight should apply');
      failed++;
    }

    // The palette on a real note excludes the current color, so we can't
    // click blue again from inside — but the palette excluding the current
    // color is the very mechanism that prevents toggle. Verify that.
    await page.locator('.sticky-note:not(.uncreated-note) .sticky-note-color-circle').first().hover({ force: true });
    await page.waitForTimeout(400);
    const palette = await page.locator('.sticky-note:not(.uncreated-note) .sticky-note-palette .color-circle[data-color="blue"]').count();
    if (palette === 0) {
      console.log('✓ Current color (blue) excluded from palette — no toggle possible');
    } else {
      console.log(`✗ Current color should be excluded from palette, found ${palette}`);
      failed++;
    }

    const stillBlue = await page.locator(`.sentence[data-sentence-id="${secondSentenceId}"].highlight-blue`).count();
    if (stillBlue > 0) {
      console.log('✓ Blue highlight still present');
    } else {
      console.log('✗ Blue highlight should still be present');
      failed++;
    }

    await cleanupTestAnnotations();

    if (failed > 0) {
      console.log(`\n❌ ${failed} assertion(s) failed`);
      process.exit(1);
    } else {
      console.log('\n✅ All Trash Deletion Tests Passed!');
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
