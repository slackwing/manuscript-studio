/**
 * Regression: after typing into the grey (uncreated) note and backspacing
 * back to empty, the "never mind" path deletes the just-created annotation
 * and re-renders back to the grey note. Focus should remain on the note's
 * textarea so the user can keep typing.
 */

const { chromium } = require('playwright');
const { TEST_URL, cleanupTestAnnotations, loginAsTestUser } = require('./test-utils');

(async () => {
  console.log('=== Never-Mind Focus Retention Test ===\n');

  await cleanupTestAnnotations();

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1400, height: 900 });

  let failed = false;
  function assert(cond, msg) {
    if (cond) console.log(`✓ ${msg}`);
    else { console.log(`✗ ${msg}`); failed = true; }
  }

  try {
    await loginAsTestUser(page);
    await page.goto(TEST_URL);
    await page.waitForSelector('.pagedjs_page', { timeout: 30000 });
    await page.waitForSelector('.sentence', { timeout: 10000 });
    await page.waitForTimeout(1500);

    await page.locator('.sentence').first().click();
    await page.waitForSelector('.sticky-note.uncreated-note.first-uncreated', { timeout: 5000 });

    const textarea = page.locator('.sticky-note.uncreated-note.first-uncreated .note-input');
    await textarea.click();
    await textarea.type('x');

    await page.waitForSelector('.sticky-note:not(.uncreated-note)', { timeout: 5000 });

    await page.keyboard.press('Backspace');

    await page.waitForSelector('.sticky-note.uncreated-note.first-uncreated', { timeout: 5000 });
    await page.waitForTimeout(300);

    const focusedIsNoteInput = await page.evaluate(() => {
      const active = document.activeElement;
      if (!active) return false;
      const note = active.closest('.sticky-note.uncreated-note.first-uncreated');
      return !!note && active.classList.contains('note-input');
    });
    assert(focusedIsNoteInput, 'Focus stays on the grey note textarea after backspacing to empty');

    await page.keyboard.type('y');
    await page.waitForSelector('.sticky-note:not(.uncreated-note)', { timeout: 5000 });
    const realNoteCount = await page.locator('.sticky-note:not(.uncreated-note)').count();
    assert(realNoteCount === 1, `Can create a fresh note after refocus (got ${realNoteCount})`);

  } catch (e) {
    console.log(`✗ Test errored: ${e.message}`);
    failed = true;
  } finally {
    await browser.close();
    await cleanupTestAnnotations();
  }

  if (failed) {
    console.log('\n❌ Test failed');
    process.exit(1);
  }
  console.log('\n✅ Test passed');
})().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
