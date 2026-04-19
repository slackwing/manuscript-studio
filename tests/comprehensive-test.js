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

    await page.waitForSelector('.sentence', { timeout: 15000 });
    await new Promise(r => setTimeout(r, 2000));

    // Click first sentence
    const firstSentence = await page.$('.sentence');
    await firstSentence.click();
    await new Promise(r => setTimeout(r, 1000));

    // Create annotations with tags to show layout
    await page.evaluate(() => {
      const annotations = [
        {
          annotation_id: 9991,
          sentence_id: 1,
          color: 'yellow',
          note: 'First note with some tags',
          priority: 'P1',
          flagged: true,
          tags: [
            {tag_id: 1, tag_name: 'important'},
            {tag_id: 2, tag_name: 'review'}
          ]
        }
      ];

      if (window.WriteSysAnnotations) {
        window.WriteSysAnnotations.annotations = annotations;
        window.WriteSysAnnotations.renderStickyNotes();
      }
    });

    await new Promise(r => setTimeout(r, 500));

    // Hover over note to show color circle
    await page.hover('.sticky-note:not(.uncreated-note)');
    await new Promise(r => setTimeout(r, 500));

    console.log('Taking screenshot: comprehensive-view.png');
    await page.screenshot({
      path: 'tests/screenshots/comprehensive-view.png',
      fullPage: false
    });

    // Hover over color circle to show palette
    await page.hover('.sticky-note-color-circle');
    await new Promise(r => setTimeout(r, 500));

    console.log('Taking screenshot: with-palette.png');
    await page.screenshot({
      path: 'tests/screenshots/with-palette.png',
      fullPage: false
    });

    console.log('\n✓ All screenshots saved successfully');

  } catch (error) {
    console.error('\n✗ Error:', error.message);
    try {
      await page.screenshot({
        path: 'tests/screenshots/comprehensive-error.png',
        fullPage: true
      });
    } catch (e) {}
  }

  await browser.close();
})();
