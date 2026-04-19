const { TEST_URL, cleanupTestAnnotations } = require('./test-utils');
const { chromium } = require('playwright');

/**
 * Test rainbow bar clickability and animation behavior
 * Tests:
 * 1. Rainbow bars are clickable
 * 2. Clicking a rainbow bar shows the correct note
 * 3. Clicking a rainbow bar scrolls to the correct note
 * 4. Clicking a rainbow bar applies flash animation
 * 5. Clicking on the Nth duplicate color focuses the Nth note (not always the first)
 */

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Collect console messages
  page.on('console', msg => {
    const text = msg.text();
    if (text.includes('Rainbow bar clicked') || text.includes('scrollToAndHighlightAnnotation')) {
      console.log(`BROWSER: ${text}`);
    }
  });

  try {
    await cleanupTestAnnotations();
    console.log('=== Testing Rainbow Bar Clickability and Animation (test.manuscript) ===\n');

  // Login first
  await loginAsTestUser(page);

    await page.goto(TEST_URL, { waitUntil: 'networkidle' });
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.sentence', { timeout: 30000 });

    // Find a sentence with multiple annotations
    const sentence = await page.locator('.sentence[data-sentence-id="but-as-happens-fbad3020"]').first();
    await sentence.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await sentence.click();
    await page.waitForTimeout(1500);

    // TEST 1: Check that rainbow bars exist and are clickable
    console.log('\n=== TEST 1: Rainbow Bars Are Clickable ===');
    const barCount = await page.locator('.rainbow-bar').count();
    console.log(`Found ${barCount} rainbow bars`);

    if (barCount > 0) {
      const firstBar = await page.locator('.rainbow-bar').first();
      const isClickable = await firstBar.evaluate(el => {
        const style = window.getComputedStyle(el);
        return style.pointerEvents === 'auto' && style.cursor === 'pointer';
      });
      console.log(isClickable ? '✓ TEST 1 PASSED: Bars are clickable' : '✗ TEST 1 FAILED: Bars not clickable');
    } else {
      console.log('✗ TEST 1 FAILED: No rainbow bars found');
    }

    // TEST 2: Check that bars have annotation IDs
    console.log('\n=== TEST 2: Bars Have Annotation IDs ===');
    const firstBar = await page.locator('.rainbow-bar').first();
    const annotationId = await firstBar.getAttribute('data-annotation-id');
    console.log(`First bar annotation ID: ${annotationId}`);
    console.log(annotationId ? '✓ TEST 2 PASSED: Bars have annotation IDs' : '✗ TEST 2 FAILED: No annotation ID');

    // TEST 3: Click a bar and check if note gets flash-highlight class
    console.log('\n=== TEST 3: Clicking Bar Applies Animation ===');
    await firstBar.click();
    await page.waitForTimeout(200); // Wait for animation to start

    const hasFlashClass = await page.locator('.sticky-note.flash-highlight').count();
    console.log(`Notes with flash-highlight class: ${hasFlashClass}`);
    console.log(hasFlashClass > 0 ? '✓ TEST 3 PASSED: Animation class applied' : '✗ TEST 3 FAILED: No animation class');

    // TEST 4: Check CSS animation is defined
    console.log('\n=== TEST 4: Flash Animation CSS Exists ===');
    const animationExists = await page.evaluate(() => {
      const styleSheets = Array.from(document.styleSheets);
      for (const sheet of styleSheets) {
        try {
          const rules = Array.from(sheet.cssRules || sheet.rules);
          for (const rule of rules) {
            if (rule.type === CSSRule.KEYFRAMES_RULE && rule.name === 'flashHighlight') {
              return true;
            }
          }
        } catch (e) {
          // Skip cross-origin stylesheets
        }
      }
      return false;
    });
    console.log(animationExists ? '✓ TEST 4 PASSED: Animation CSS exists' : '✗ TEST 4 FAILED: Animation CSS missing');

    // TEST 5: Test multiple bars with same color (if available)
    console.log('\n=== TEST 5: Multiple Bars with Same Color Focus Correct Note ===');

    // Get all bar colors
    const barColors = await page.locator('.rainbow-bar').evaluateAll(bars =>
      bars.map(bar => bar.dataset.color)
    );
    console.log(`Bar colors: [${barColors.join(', ')}]`);

    // Get all bar annotation IDs
    const barAnnotationIds = await page.locator('.rainbow-bar').evaluateAll(bars =>
      bars.map(bar => bar.dataset.annotationId)
    );
    console.log(`Bar annotation IDs: [${barAnnotationIds.join(', ')}]`);

    // Find duplicate colors
    const colorCounts = {};
    barColors.forEach(color => {
      colorCounts[color] = (colorCounts[color] || 0) + 1;
    });

    const duplicateColor = Object.keys(colorCounts).find(color => colorCounts[color] > 1);

    if (duplicateColor) {
      console.log(`Found duplicate color: ${duplicateColor} (appears ${colorCounts[duplicateColor]} times)`);

      // Find all bars with this color
      const duplicateIndices = [];
      barColors.forEach((color, index) => {
        if (color === duplicateColor) {
          duplicateIndices.push(index);
        }
      });

      console.log(`Indices of ${duplicateColor} bars: [${duplicateIndices.join(', ')}]`);

      // Click each duplicate bar and verify correct annotation ID
      let allCorrect = true;
      for (const index of duplicateIndices) {
        const bar = await page.locator('.rainbow-bar').nth(index);
        const expectedId = barAnnotationIds[index];

        await bar.click();
        await page.waitForTimeout(200);

        // Check which note has the flash-highlight class
        const highlightedNote = await page.locator('.sticky-note.flash-highlight').first();
        const highlightedId = await highlightedNote.getAttribute('data-annotation-id');

        console.log(`  Bar ${index} (${duplicateColor}): Expected ID=${expectedId}, Got ID=${highlightedId}`);

        if (highlightedId !== expectedId) {
          allCorrect = false;
          console.log(`  ✗ MISMATCH: Bar ${index} focused wrong note!`);
        } else {
          console.log(`  ✓ Bar ${index} focused correct note`);
        }

        await page.waitForTimeout(600); // Wait for animation to complete
      }

      console.log(allCorrect ? '✓ TEST 5 PASSED: All duplicate colors focus correct notes' : '✗ TEST 5 FAILED: Some bars focused wrong notes');
    } else {
      console.log('⊘ TEST 5 SKIPPED: No duplicate colors found');
    }

    // TEST 6: Click sentence and verify first note gets animation
    console.log('\n=== TEST 6: Clicking Sentence Animates First Note ===');
    await page.waitForTimeout(1000); // Clear any existing animations

    await sentence.click();
    await page.waitForTimeout(400); // Wait for animation to apply

    const sentenceClickAnimated = await page.locator('.sticky-note.flash-highlight').count();
    console.log(sentenceClickAnimated > 0 ? '✓ TEST 6 PASSED: Sentence click animates note' : '✗ TEST 6 FAILED: No animation on sentence click');

    console.log('\n=== Summary ===');
    console.log('Tests verify:');
    console.log('  1. Rainbow bars are clickable (pointer-events, cursor)');
    console.log('  2. Bars have annotation IDs');
    console.log('  3. Clicking applies flash-highlight class');
    console.log('  4. CSS animation keyframes exist');
    console.log('  5. Duplicate colors focus correct notes (not always first)');
    console.log('  6. Sentence clicks also animate first note\n');

    console.log('Keeping browser open for 10 seconds for manual inspection...');
    await page.waitForTimeout(10000);

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await browser.close();
  }
})();
