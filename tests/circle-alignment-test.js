const { chromium } = require('playwright');
const { TEST_URL, cleanupTestAnnotations, loginAsTestUser } = require('./test-utils');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1920, height: 1080 });

  try {
    // Clean up test manuscript data
    await cleanupTestAnnotations();

    console.log('Loading WriteSys (test.manuscript)...');
  // Login first
  await loginAsTestUser(page);

    await page.goto(TEST_URL, { waitUntil: 'networkidle', timeout: 10000 });

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

    // Hover to show color circle
    await page.hover('.sticky-note:not(.uncreated-note)');
    await new Promise(r => setTimeout(r, 300));

    // Hover over color circle to show palette
    await page.hover('.sticky-note-color-circle');
    await new Promise(r => setTimeout(r, 500));

    // Check alignment in normal state
    const alignment = await page.evaluate(() => {
      const note = document.querySelector('.sticky-note:not(.uncreated-note)');
      const noteRect = note.getBoundingClientRect();
      const noteRightEdge = noteRect.right;

      // Get the main color circle (on the note)
      const mainCircle = note.querySelector('.sticky-note-color-circle');
      const mainCircleRect = mainCircle.getBoundingClientRect();
      const mainCircleTop = mainCircleRect.top;
      const mainCircleBottom = mainCircleRect.bottom;
      const mainCircleCenter = mainCircleRect.left + mainCircleRect.width / 2;
      const mainCircleVerticalCenter = mainCircleRect.top + mainCircleRect.height / 2;

      // Get all palette circles
      const paletteCircles = Array.from(note.querySelectorAll('.sticky-note-palette .color-circle'));
      const palettePositions = paletteCircles.map((circle, i) => {
        const rect = circle.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        return {
          index: i,
          centerX: centerX,
          centerY: centerY,
          offsetX: centerX - noteRightEdge,
          top: rect.top,
          bottom: rect.bottom
        };
      });

      // Calculate vertical spacing between circles
      const allCircles = [
        { name: 'Main', centerY: mainCircleVerticalCenter, top: mainCircleTop, bottom: mainCircleBottom },
        ...palettePositions.map((p, i) => ({ name: `Palette ${i + 1}`, centerY: p.centerY, top: p.top, bottom: p.bottom }))
      ];

      // Sort by vertical position
      allCircles.sort((a, b) => a.centerY - b.centerY);

      // Calculate spacing between consecutive circles
      const spacings = [];
      for (let i = 0; i < allCircles.length - 1; i++) {
        spacings.push({
          from: allCircles[i].name,
          to: allCircles[i + 1].name,
          centerToCenter: allCircles[i + 1].centerY - allCircles[i].centerY,
          edgeToEdge: allCircles[i + 1].top - allCircles[i].bottom
        });
      }

      // Add debug lines
      const debugLine = document.createElement('div');
      debugLine.style.position = 'absolute';
      debugLine.style.top = '-10px';
      debugLine.style.right = '0';
      debugLine.style.width = '2px';
      debugLine.style.height = '300px';
      debugLine.style.background = 'red';
      debugLine.style.zIndex = '1000';
      debugLine.style.pointerEvents = 'none';
      note.appendChild(debugLine);

      return {
        noteRightEdge,
        mainCircleCenter,
        mainCircleOffset: mainCircleCenter - noteRightEdge,
        palettePositions,
        spacings
      };
    });

    console.log('Taking circle alignment screenshot...');
    await page.screenshot({
      path: 'tests/screenshots/circle-alignment.png',
      fullPage: false
    });

    console.log('\n=== ALIGNMENT CHECK ===');
    console.log(`Note right edge: ${alignment.noteRightEdge.toFixed(2)}px`);
    console.log(`Main circle center: ${alignment.mainCircleCenter.toFixed(2)}px`);
    console.log(`Main circle offset from edge: ${alignment.mainCircleOffset.toFixed(2)}px (should be 0)`);

    console.log('\nPalette circles horizontal alignment:');
    alignment.palettePositions.forEach(pos => {
      console.log(`  Circle ${pos.index + 1}: center at ${pos.centerX.toFixed(2)}px, offset: ${pos.offsetX.toFixed(2)}px (should be 0)`);
    });

    console.log('\n=== VERTICAL SPACING CHECK ===');
    console.log('Expected: 32px center-to-center, 6px edge-to-edge gap');
    alignment.spacings.forEach(spacing => {
      console.log(`\n${spacing.from} → ${spacing.to}:`);
      console.log(`  Center-to-center: ${spacing.centerToCenter.toFixed(2)}px (should be 32px)`);
      console.log(`  Edge-to-edge gap: ${spacing.edgeToEdge.toFixed(2)}px (should be 6px)`);
    });

    // Check if any circles are misaligned or improperly spaced
    const horizontalTolerance = 1;
    const spacingTolerance = 1;
    const expectedCenterSpacing = 32;
    const expectedEdgeGap = 6;
    let failed = false;

    // Check horizontal alignment
    if (Math.abs(alignment.mainCircleOffset) > horizontalTolerance) {
      console.log(`\n✗ FAIL: Main circle misaligned horizontally by ${alignment.mainCircleOffset.toFixed(2)}px`);
      failed = true;
    }

    alignment.palettePositions.forEach(pos => {
      if (Math.abs(pos.offsetX) > horizontalTolerance) {
        console.log(`✗ FAIL: Palette circle ${pos.index + 1} misaligned horizontally by ${pos.offsetX.toFixed(2)}px`);
        failed = true;
      }
    });

    // Check vertical spacing
    alignment.spacings.forEach(spacing => {
      const centerError = Math.abs(spacing.centerToCenter - expectedCenterSpacing);
      const edgeError = Math.abs(spacing.edgeToEdge - expectedEdgeGap);

      if (centerError > spacingTolerance) {
        console.log(`✗ FAIL: ${spacing.from} → ${spacing.to} spacing off by ${centerError.toFixed(2)}px (center-to-center)`);
        failed = true;
      }

      if (spacing.edgeToEdge < 0) {
        console.log(`✗ FAIL: ${spacing.from} → ${spacing.to} OVERLAPPING by ${Math.abs(spacing.edgeToEdge).toFixed(2)}px!`);
        failed = true;
      } else if (edgeError > spacingTolerance) {
        console.log(`✗ FAIL: ${spacing.from} → ${spacing.to} gap off by ${edgeError.toFixed(2)}px (edge-to-edge)`);
        failed = true;
      }
    });

    if (failed) {
      console.log('\n✗ ALIGNMENT TEST FAILED (NORMAL STATE)');
      process.exit(1);
    } else {
      console.log('\n✓ All circles properly aligned and spaced (normal state)');
    }

    // Now test hover state - hover over first palette circle
    console.log('\n=== TESTING HOVER STATE ===');
    await page.hover('.sticky-note-palette .color-circle:nth-child(1)');
    await new Promise(r => setTimeout(r, 300));

    const hoverAlignment = await page.evaluate(() => {
      const note = document.querySelector('.sticky-note:not(.uncreated-note)');
      const noteRect = note.getBoundingClientRect();
      const noteRightEdge = noteRect.right;

      // Get all palette circles in hover state
      const paletteCircles = Array.from(note.querySelectorAll('.sticky-note-palette .color-circle'));
      const hoverPositions = paletteCircles.map((circle, i) => {
        const rect = circle.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const isHovered = circle.matches(':hover');
        return {
          index: i,
          centerX: centerX,
          offsetX: centerX - noteRightEdge,
          isHovered: isHovered,
          width: rect.width,
          height: rect.height
        };
      });

      return {
        noteRightEdge,
        hoverPositions
      };
    });

    console.log('Palette circles during hover:');
    hoverAlignment.hoverPositions.forEach(pos => {
      const hoverMarker = pos.isHovered ? ' [HOVERED]' : '';
      console.log(`  Circle ${pos.index + 1}: center at ${pos.centerX.toFixed(2)}px, offset: ${pos.offsetX.toFixed(2)}px (should be 0), size: ${pos.width}x${pos.height}${hoverMarker}`);
    });

    let hoverFailed = false;
    hoverAlignment.hoverPositions.forEach(pos => {
      if (Math.abs(pos.offsetX) > horizontalTolerance) {
        console.log(`✗ FAIL: Palette circle ${pos.index + 1} misaligned during hover by ${pos.offsetX.toFixed(2)}px`);
        hoverFailed = true;
      }
    });

    // Take screenshot during hover
    console.log('\nTaking hover state screenshot...');
    await page.screenshot({
      path: 'tests/screenshots/circle-alignment-hover.png',
      fullPage: false
    });

    if (hoverFailed) {
      console.log('\n✗ ALIGNMENT TEST FAILED (HOVER STATE)');
      process.exit(1);
    } else {
      console.log('\n✓ All circles properly aligned during hover');
    }

  } catch (error) {
    console.error('\n✗ Error:', error.message);
    try {
      await page.screenshot({
        path: 'tests/screenshots/circle-alignment-error.png',
        fullPage: true
      });
    } catch (e) {}
  }

  await browser.close();
})();
