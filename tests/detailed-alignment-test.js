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

    // Create test annotation
    await page.evaluate(() => {
      const annotation = {
        annotation_id: 9991,
        sentence_id: 1,
        color: 'yellow',
        note: 'Test note',
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

    // Hover to show circles and palette
    await page.hover('.sticky-note:not(.uncreated-note)');
    await new Promise(r => setTimeout(r, 300));
    await page.hover('.sticky-note-color-circle');
    await new Promise(r => setTimeout(r, 500));

    // Add detailed debug visualization
    const alignment = await page.evaluate(() => {
      const note = document.querySelector('.sticky-note:not(.uncreated-note)');
      const noteRect = note.getBoundingClientRect();
      const colorCircle = note.querySelector('.sticky-note-color-circle');
      const colorCircleRect = colorCircle.getBoundingClientRect();
      const paletteCircles = Array.from(document.querySelectorAll('.sticky-note-palette .color-circle'));

      // Add vertical line at note's right edge
      const rightEdgeLine = document.createElement('div');
      rightEdgeLine.style.position = 'fixed';
      rightEdgeLine.style.top = (noteRect.top - 20) + 'px';
      rightEdgeLine.style.left = noteRect.right + 'px';
      rightEdgeLine.style.width = '2px';
      rightEdgeLine.style.height = (noteRect.height + 100) + 'px';
      rightEdgeLine.style.background = 'red';
      rightEdgeLine.style.zIndex = '10000';
      rightEdgeLine.style.pointerEvents = 'none';
      document.body.appendChild(rightEdgeLine);

      // Add crosshairs at center of color picker circle
      const colorCircleCenterX = colorCircleRect.left + colorCircleRect.width / 2;
      const colorCircleCenterY = colorCircleRect.top + colorCircleRect.height / 2;

      const horizLine = document.createElement('div');
      horizLine.style.position = 'fixed';
      horizLine.style.top = colorCircleCenterY + 'px';
      horizLine.style.left = (colorCircleCenterX - 20) + 'px';
      horizLine.style.width = '40px';
      horizLine.style.height = '2px';
      horizLine.style.background = 'blue';
      horizLine.style.zIndex = '10001';
      horizLine.style.pointerEvents = 'none';
      document.body.appendChild(horizLine);

      const vertLine = document.createElement('div');
      vertLine.style.position = 'fixed';
      vertLine.style.top = (colorCircleCenterY - 20) + 'px';
      vertLine.style.left = colorCircleCenterX + 'px';
      vertLine.style.width = '2px';
      vertLine.style.height = '40px';
      vertLine.style.background = 'blue';
      vertLine.style.zIndex = '10001';
      vertLine.style.pointerEvents = 'none';
      document.body.appendChild(vertLine);

      // Add crosshairs for each palette circle
      paletteCircles.forEach((circle, idx) => {
        const rect = circle.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;

        const h = document.createElement('div');
        h.style.position = 'fixed';
        h.style.top = centerY + 'px';
        h.style.left = (centerX - 20) + 'px';
        h.style.width = '40px';
        h.style.height = '2px';
        h.style.background = 'green';
        h.style.zIndex = '10001';
        h.style.pointerEvents = 'none';
        document.body.appendChild(h);

        const v = document.createElement('div');
        v.style.position = 'fixed';
        v.style.top = (centerY - 20) + 'px';
        v.style.left = centerX + 'px';
        v.style.width = '2px';
        v.style.height = '40px';
        v.style.background = 'green';
        v.style.zIndex = '10001';
        v.style.pointerEvents = 'none';
        document.body.appendChild(v);
      });

      return {
        noteRight: noteRect.right,
        colorCircleCenter: colorCircleCenterX,
        paletteCircleCenters: paletteCircles.map(c => {
          const r = c.getBoundingClientRect();
          return r.left + r.width / 2;
        }),
        offset: colorCircleCenterX - noteRect.right
      };
    });

    console.log('\nAlignment Analysis:');
    console.log('Note right edge:', alignment.noteRight);
    console.log('Color picker center X:', alignment.colorCircleCenter);
    console.log('Offset from edge:', alignment.offset, 'px');
    console.log('Palette circle centers:', alignment.paletteCircleCenters);

    console.log('\nTaking screenshot...');
    await page.screenshot({
      path: 'tests/screenshots/detailed-alignment.png',
      fullPage: false
    });

    console.log('\n✓ Screenshot saved');
    console.log('Red line = note right edge');
    console.log('Blue crosshair = color picker center');
    console.log('Green crosshairs = palette circle centers');
    console.log('All should be vertically aligned!');

  } catch (error) {
    console.error('\n✗ Error:', error.message);
    try {
      await page.screenshot({
        path: 'tests/screenshots/detailed-alignment-error.png',
        fullPage: true
      });
    } catch (e) {}
  }

  await browser.close();
})();
