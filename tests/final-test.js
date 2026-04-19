const { chromium } = require('playwright');

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

    // Create test annotations
    await page.evaluate(() => {
      const annotations = [
        {
          annotation_id: 9991,
          sentence_id: 1,
          color: 'yellow',
          note: 'First note with yellow color',
          priority: 'none',
          flagged: false,
          tags: []
        }
      ];

      if (window.WriteSysAnnotations) {
        window.WriteSysAnnotations.annotations = annotations;
        window.WriteSysAnnotations.renderStickyNotes();
      }
    });

    await new Promise(r => setTimeout(r, 500));

    // Hover over first note to show controls
    await page.hover('.sticky-note:not(.uncreated-note)');
    await new Promise(r => setTimeout(r, 500));

    console.log('Taking screenshot: final-with-hover.png');
    await page.screenshot({
      path: 'tests/screenshots/final-with-hover.png',
      fullPage: false
    });

    // Screenshot of subsequent uncreated note (non-hovered)
    console.log('Taking screenshot: final-subsequent-note.png');
    await page.mouse.move(100, 100);  // Move mouse away
    await new Promise(r => setTimeout(r, 300));

    await page.screenshot({
      path: 'tests/screenshots/final-subsequent-note.png',
      fullPage: false
    });

    // Hover over subsequent note to show it uses same grey
    await page.hover('.subsequent-uncreated');
    await new Promise(r => setTimeout(r, 500));

    console.log('Taking screenshot: final-subsequent-hover.png');
    await page.screenshot({
      path: 'tests/screenshots/final-subsequent-hover.png',
      fullPage: false
    });

    console.log('\n✓ All screenshots saved successfully');

  } catch (error) {
    console.error('\n✗ Error:', error.message);
    try {
      await page.screenshot({
        path: 'tests/screenshots/final-error.png',
        fullPage: true
      });
    } catch (e) {}
  }

  await browser.close();
})();
