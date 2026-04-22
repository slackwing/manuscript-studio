/**
 * Two-click "complete" flow on an annotation:
 *   first click → green confirming state, annotation still present
 *   second click → annotation disappears from the DOM and rainbow bars update
 */

const { chromium } = require('playwright');
const { TEST_URL, cleanupTestAnnotations, loginAsTestUser } = require('./test-utils');

(async () => {
  console.log('=== Complete-Annotation Test ===\n');

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

    const colorCircle = page.locator('.sticky-note.uncreated-note.first-uncreated .sticky-note-color-circle');
    await colorCircle.hover();
    await page.waitForSelector('.sticky-note.uncreated-note.first-uncreated .sticky-note-palette.visible', { timeout: 5000 });
    await page.locator('.sticky-note.uncreated-note.first-uncreated .sticky-note-palette .color-circle[data-color="yellow"]').click();
    await page.waitForSelector('.sticky-note:not(.uncreated-note)', { timeout: 5000 });
    await page.waitForTimeout(500);

    const realNotesBefore = await page.locator('.sticky-note:not(.uncreated-note)').count();
    assert(realNotesBefore === 1, `One real annotation created (got ${realNotesBefore})`);

    const rainbowBarsBefore = await page.locator('.rainbow-bar').count();

    const check = page.locator('.sticky-note:not(.uncreated-note) .complete-check');
    await check.click();
    const confirming = await check.evaluate(el => el.classList.contains('confirming'));
    assert(confirming, 'First click puts complete button into confirming state');

    await page.waitForTimeout(150);
    await check.click();

    await page.waitForSelector('.sticky-note.uncreated-note.first-uncreated', { timeout: 5000 });
    await page.waitForTimeout(500);

    const realNotesAfter = await page.locator('.sticky-note:not(.uncreated-note)').count();
    assert(realNotesAfter === 0, `Annotation disappeared after completion (got ${realNotesAfter})`);

    const rainbowBarsAfter = await page.locator('.rainbow-bar').count();
    assert(rainbowBarsAfter !== rainbowBarsBefore || rainbowBarsBefore === 0,
      `Rainbow bars updated (before=${rainbowBarsBefore}, after=${rainbowBarsAfter})`);

    // Completion must persist after reload.
    await page.reload();
    await page.waitForSelector('.pagedjs_page', { timeout: 30000 });
    await page.waitForSelector('.sentence', { timeout: 10000 });
    await page.waitForTimeout(1500);
    await page.locator('.sentence').first().click();
    await page.waitForSelector('.sticky-note.uncreated-note.first-uncreated', { timeout: 5000 });
    const realNotesAfterReload = await page.locator('.sticky-note:not(.uncreated-note)').count();
    assert(realNotesAfterReload === 0, `Annotation stays completed after reload (got ${realNotesAfterReload})`);

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
