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
    console.log('=== Testing Rainbow Bars Update After Deletion ===\n');

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
    console.log(`Rainbow bars BEFORE deletion: ${barsBefore}\n`);

    const firstNote = await page.locator('.sticky-note').first();
    await firstNote.hover();
    await page.waitForTimeout(500);

    const trash = await firstNote.locator('.note-trash').first();
    console.log('Double-clicking trash to delete annotation...');
    console.log('First click (confirm)...');
    await trash.click();
    await page.waitForTimeout(500);

    console.log('Second click (delete)...');
    await trash.click();
    await page.waitForTimeout(3000); // Wait for deletion and refresh

    const barsAfter = await page.locator('.rainbow-bar').count();
    console.log(`\nRainbow bars AFTER deletion: ${barsAfter}\n`);

    if (barsAfter !== barsBefore) {
      console.log(`✓ SUCCESS: Rainbow bars updated! (${barsBefore} -> ${barsAfter})`);
    } else {
      console.log(`✗ FAILED: Rainbow bars did not change`);
    }

    console.log('\nKeeping browser open for 10 seconds for inspection...');
    await page.waitForTimeout(10000);

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await browser.close();
  }
})();
