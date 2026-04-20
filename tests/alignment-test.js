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

    // Create test annotations
    await page.evaluate(() => {
      const annotations = [
        {
          annotation_id: 9991,
          sentence_id: 1,
          color: 'yellow',
          note: 'First note',
          priority: 'none',
          flagged: false,
          tags: []
        },
        {
          annotation_id: 9992,
          sentence_id: 1,
          color: 'blue',
          note: 'Second note',
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

    // Add visual debug guides
    await page.evaluate(() => {
      const notes = document.querySelectorAll('.sticky-note:not(.uncreated-note)');
      notes.forEach(note => {
        // Make color circle always visible for testing
        const circle = note.querySelector('.sticky-note-color-circle');
        if (circle) {
          circle.style.opacity = '1';
          circle.style.transform = 'scale(1)';
        }

        // Add debug lines at the exact corner
        const debugLines = document.createElement('div');
        debugLines.style.position = 'absolute';
        debugLines.style.top = '0';
        debugLines.style.right = '0';
        debugLines.style.width = '2px';
        debugLines.style.height = '40px';
        debugLines.style.background = 'red';
        debugLines.style.zIndex = '100';
        debugLines.style.pointerEvents = 'none';
        note.appendChild(debugLines);

        const debugLines2 = document.createElement('div');
        debugLines2.style.position = 'absolute';
        debugLines2.style.top = '0';
        debugLines2.style.right = '0';
        debugLines2.style.width = '40px';
        debugLines2.style.height = '2px';
        debugLines2.style.background = 'red';
        debugLines2.style.zIndex = '100';
        debugLines2.style.pointerEvents = 'none';
        note.appendChild(debugLines2);
      });

      // Also add debug lines for uncreated note
      const uncreatedNotes = document.querySelectorAll('.subsequent-uncreated');
      uncreatedNotes.forEach(note => {
        const circle = note.querySelector('.sticky-note-color-circle');
        if (circle) {
          circle.style.opacity = '1';
          circle.style.transform = 'scale(1)';
        }

        const debugLines = document.createElement('div');
        debugLines.style.position = 'absolute';
        debugLines.style.top = '0';
        debugLines.style.right = '0';
        debugLines.style.width = '2px';
        debugLines.style.height = '40px';
        debugLines.style.background = 'red';
        debugLines.style.zIndex = '100';
        debugLines.style.pointerEvents = 'none';
        note.appendChild(debugLines);

        const debugLines2 = document.createElement('div');
        debugLines2.style.position = 'absolute';
        debugLines2.style.top = '0';
        debugLines2.style.right = '0';
        debugLines2.style.width = '40px';
        debugLines2.style.height = '2px';
        debugLines2.style.background = 'red';
        debugLines2.style.zIndex = '100';
        debugLines2.style.pointerEvents = 'none';
        note.appendChild(debugLines2);
      });
    });

    await new Promise(r => setTimeout(r, 300));

    console.log('Taking alignment screenshot...');
    await page.screenshot({
      path: 'tests/screenshots/alignment-test.png',
      fullPage: false
    });

    console.log('\n✓ Alignment screenshot saved');
    console.log('Red crosshairs should intersect at the exact center of each color circle.');

  } catch (error) {
    console.error('\n✗ Error:', error.message);
    try {
      await page.screenshot({
        path: 'tests/screenshots/alignment-error.png',
        fullPage: true
      });
    } catch (e) {}
  }

  await browser.close();
})();
