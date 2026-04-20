const { TEST_URL, cleanupTestAnnotations, loginAsTestUser } = require('./test-utils');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Collect console messages
  page.on('console', msg => {
    const text = msg.text();
    if (text.includes('[refreshRainbowBars]') || text.includes('[deleteAnnotation]') || text.includes('rainbow')) {
      console.log(`BROWSER: ${text}`);
    }
  });

  try {
    await cleanupTestAnnotations();
    console.log('=== Testing Rainbow Bars Final Implementation ===\n');

  // Login first
  await loginAsTestUser(page);

    await page.goto(TEST_URL, { waitUntil: 'networkidle' });
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.sentence', { timeout: 30000 });

    const sentence = await page.locator('.sentence[data-sentence-id="but-as-happens-fbad3020"]').first();
    await sentence.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await sentence.click();
    await page.waitForTimeout(1500);

    const barsBefore = await page.locator('.rainbow-bar').count();
    console.log(`\nRainbow bars BEFORE deletion: ${barsBefore}`);

    // TEST 1: Delete annotation via double-click
    console.log('\n=== TEST 1: Delete Annotation ===');
    const firstNote = await page.locator('.sticky-note').first();
    await firstNote.hover();
    await page.waitForTimeout(500);

    const trash = await firstNote.locator('.note-trash').first();
    console.log('First click (confirm)...');
    await trash.click();
    await page.waitForTimeout(500);

    console.log('Second click (delete)...');
    await trash.click();
    await page.waitForTimeout(3000); // Wait for deletion and refresh

    const barsAfterDelete = await page.locator('.rainbow-bar').count();
    console.log(`Rainbow bars AFTER deletion: ${barsAfterDelete}`);

    if (barsAfterDelete !== barsBefore) {
      console.log(`✓ TEST 1 PASSED: Rainbow bars updated! (${barsBefore} -> ${barsAfterDelete})`);
    } else {
      console.log(`✗ TEST 1 FAILED: Rainbow bars did not change`);
    }

    // TEST 2: Add new color annotation
    console.log('\n=== TEST 2: Add New Color Annotation ===');
    const barsBefore2 = await page.locator('.rainbow-bar').count();
    console.log(`Rainbow bars BEFORE new annotation: ${barsBefore2}`);

    // Click sentence again to show sidebar
    await sentence.click();
    await page.waitForTimeout(500);

    // Click the + button to add new note
    const addBtn = await page.locator('.add-note-btn').first();
    await addBtn.click();
    await page.waitForTimeout(1000);

    // Select a color (e.g., yellow)
    const yellowCircle = await page.locator('.sticky-note-color-circle.color-yellow').last();
    await yellowCircle.click();
    await page.waitForTimeout(3000);

    const barsAfterAdd = await page.locator('.rainbow-bar').count();
    console.log(`Rainbow bars AFTER new annotation: ${barsAfterAdd}`);

    if (barsAfterAdd !== barsBefore2) {
      console.log(`✓ TEST 2 PASSED: Rainbow bars updated! (${barsBefore2} -> ${barsAfterAdd})`);
    } else {
      console.log(`✗ TEST 2 FAILED: Rainbow bars did not change`);
    }

    // TEST 3: Change annotation color
    console.log('\n=== TEST 3: Change Annotation Color ===');
    const secondNote = await page.locator('.sticky-note').nth(1);
    await secondNote.hover();
    await page.waitForTimeout(500);

    // Click the color circle to change color
    const colorCircle = await secondNote.locator('.sticky-note-color-circle').first();
    await colorCircle.click();
    await page.waitForTimeout(500);

    // Select a different color (e.g., red)
    const redCircle = await page.locator('.color-picker-circle.color-red').first();
    await redCircle.click();
    await page.waitForTimeout(3000);

    const barsAfterChange = await page.locator('.rainbow-bar').count();
    console.log(`Rainbow bars AFTER color change: ${barsAfterChange}`);

    console.log('\n=== Summary ===');
    console.log('All tests check if rainbow bars count changes after operations.');
    console.log('The count should reflect the distribution of colors across sentences.\n');

    console.log('Keeping browser open for 30 seconds for manual inspection...');
    await page.waitForTimeout(30000);

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await browser.close();
  }
})();
