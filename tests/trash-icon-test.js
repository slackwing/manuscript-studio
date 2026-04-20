const { chromium } = require('playwright');
const { loginAsTestUser } = require('./test-utils');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1920, height: 1080 });

  try {
    console.log('Loading WriteSys...');
  // Login first
  await loginAsTestUser(page);

    await page.goto('http://localhost:5001', { waitUntil: 'networkidle', timeout: 10000 });

    // Wait for manuscript to load
    console.log('Waiting for manuscript...');
    await page.waitForSelector('.sentence', { timeout: 15000 });
    await new Promise(r => setTimeout(r, 2000));

    // Click first sentence
    console.log('Clicking first sentence...');
    const firstSentence = await page.$('.sentence');
    if (!firstSentence) {
      throw new Error('No sentences found');
    }
    await firstSentence.click();
    await new Promise(r => setTimeout(r, 1000));

    // Inject a note with some content so we can see the trash icon
    await page.evaluate(() => {
      // Manually create an annotation for testing
      const annotation = {
        annotation_id: 9999,
        sentence_id: 1,
        color: 'yellow',
        note: 'Test note to show trash icon',
        priority: 'none',
        flagged: false,
        tags: []
      };

      if (window.WriteSysAnnotations) {
        window.WriteSysAnnotations.annotations = [annotation];
        window.WriteSysAnnotations.renderStickyNotes();
      }
    });

    await new Promise(r => setTimeout(r, 500));

    // Hover over the sticky note to show the trash icon
    console.log('Hovering over sticky note...');
    await page.hover('.sticky-note');
    await new Promise(r => setTimeout(r, 500));

    // Take screenshot showing trash icon in lower-right
    console.log('Taking screenshot: trash-icon-position.png');
    await page.screenshot({
      path: 'tests/screenshots/trash-icon-position.png',
      fullPage: false
    });

    // Click trash once to show confirmation
    console.log('Clicking trash for confirmation...');
    await page.click('.sticky-note-trash');
    await new Promise(r => setTimeout(r, 300));

    // Take screenshot showing confirmation state
    console.log('Taking screenshot: trash-icon-confirm.png');
    await page.screenshot({
      path: 'tests/screenshots/trash-icon-confirm.png',
      fullPage: false
    });

    console.log('\n✓ Screenshots saved successfully');

  } catch (error) {
    console.error('\n✗ Error:', error.message);

    try {
      await page.screenshot({
        path: 'tests/screenshots/trash-test-error.png',
        fullPage: true
      });
      console.log('Error screenshot saved');
    } catch (e) {
      console.error('Failed to take error screenshot:', e.message);
    }
  }

  await browser.close();
})();
