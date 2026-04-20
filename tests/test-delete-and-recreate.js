/**
 * test-delete-and-recreate.js
 *
 * Regression test: deleting an annotation on a sentence must not block
 * creating a new annotation on the same sentence. This guards against
 * the unique constraint not respecting soft-deletes (deleted_at).
 *
 * Flow:
 *   1. Select the first sentence (dynamically discovered).
 *   2. Create a yellow annotation via the uncreated-note palette.
 *   3. Delete that annotation via the `.note-trash` icon (two clicks:
 *      first is the confirmation state, second actually deletes).
 *   4. Re-select the same sentence.
 *   5. Create a new green annotation via the uncreated-note palette.
 *   6. Verify the sentence now has the `highlight-green` class and no
 *      unexpected alert dialogs fired.
 */

const { chromium } = require('playwright');
const { TEST_URL, cleanupTestAnnotations, loginAsTestUser } = require('./test-utils');

async function addNoteByColor(page, color) {
  const uncreated = page.locator('.sticky-note.uncreated-note').first();
  await uncreated.hover();
  await page.waitForTimeout(200);
  await uncreated.locator('.sticky-note-color-circle').first().hover();
  await page.waitForTimeout(300);
  await uncreated.locator(`.color-circle[data-color="${color}"]`).first().click();
  await page.waitForTimeout(1500);
}

async function deleteFirstRealNote(page) {
  const note = page.locator('.sticky-note:not(.uncreated-note)').first();
  await note.hover();
  await page.waitForTimeout(200);
  const trash = note.locator('.note-trash');
  // Two clicks: first shows confirming state, second actually deletes.
  await trash.click();
  await page.waitForTimeout(400);
  await trash.click();
  await page.waitForTimeout(1500);
}

(async () => {
  await cleanupTestAnnotations();

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const errors = [];
  const alerts = [];

  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('dialog', async dialog => {
    alerts.push(dialog.message());
    console.log('ALERT:', dialog.message());
    await dialog.dismiss().catch(() => {});
  });

  try {
    await loginAsTestUser(page);
    await page.goto(TEST_URL);
    await page.waitForSelector('.sentence', { timeout: 30000 });
    await page.waitForTimeout(4000);

    console.log('=== Test: Delete annotation and create new one ===\n');

    // Step 1: Discover and click first sentence.
    const sentenceId = await page.evaluate(() => {
      return document.querySelector('.sentence').dataset.sentenceId;
    });
    console.log('1. Selected sentence:', sentenceId);

    const sentence = page.locator(`.sentence[data-sentence-id="${sentenceId}"]`).first();
    await sentence.scrollIntoViewIfNeeded();
    await sentence.click();
    await page.waitForTimeout(600);

    // Step 2: Create yellow annotation.
    await addNoteByColor(page, 'yellow');

    const hasYellow = await page.evaluate((sid) => {
      const sent = document.querySelector(`.sentence[data-sentence-id="${sid}"]`);
      return sent?.classList.contains('highlight-yellow');
    }, sentenceId);
    console.log('2. Created yellow annotation:', hasYellow);

    if (!hasYellow) {
      console.log('FAILED: Could not create initial yellow annotation');
      if (alerts.length) console.log('   Alerts:', alerts);
      await browser.close();
      await cleanupTestAnnotations();
      process.exit(1);
    }

    // Step 3: Delete via trash.
    console.log('3. Deleting annotation via trash icon (2 clicks)...');
    await deleteFirstRealNote(page);

    const yellowRemoved = await page.evaluate((sid) => {
      const sent = document.querySelector(`.sentence[data-sentence-id="${sid}"]`);
      return !sent?.classList.contains('highlight-yellow');
    }, sentenceId);
    console.log('   Yellow highlight removed:', yellowRemoved);

    if (!yellowRemoved) {
      console.log('FAILED: Could not delete annotation');
      await browser.close();
      await cleanupTestAnnotations();
      process.exit(1);
    }

    // Reset tracking.
    errors.length = 0;
    alerts.length = 0;

    // Step 4: Reselect sentence (deletion collapses the panel).
    await sentence.click();
    await page.waitForTimeout(600);

    // Step 5: Create a new green annotation on the same sentence.
    console.log('4. Creating NEW green annotation on the same sentence...');
    await addNoteByColor(page, 'green');

    const hasGreen = await page.evaluate((sid) => {
      const sent = document.querySelector(`.sentence[data-sentence-id="${sid}"]`);
      return sent?.classList.contains('highlight-green');
    }, sentenceId);
    console.log('5. New green annotation created:', hasGreen);

    if (errors.length > 0) {
      console.log('\nConsole errors:');
      errors.forEach(e => console.log('  ', e.substring(0, 200)));
    }
    if (alerts.length > 0) {
      console.log('\nAlert dialogs:');
      alerts.forEach(a => console.log('  ', a));
    }

    await browser.close();
    await cleanupTestAnnotations();

    if (!hasGreen || alerts.length > 0) {
      console.log('\nTEST FAILED: Cannot create new annotation after deleting old one');
      console.log('   This suggests the unique constraint does not account for soft deletes (deleted_at)');
      process.exit(1);
    } else {
      console.log('\nTEST PASSED: Can create new annotation after deleting old one');
    }
  } catch (error) {
    console.error('\nTest error:', error);
    await browser.close().catch(() => {});
    await cleanupTestAnnotations();
    process.exit(1);
  }
})();
