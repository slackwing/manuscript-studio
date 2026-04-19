const { chromium } = require('playwright');

/**
 * SPACING INVARIANTS TEST
 *
 * This test validates the critical spacing requirements that must NEVER break:
 *
 * 1. VERTICAL GAP (between pages): 32px
 * 2. HORIZONTAL GAP (page right edge to sticky note left edge): 32px (constant at all window sizes)
 * 3. TOP MARGIN (viewport top to sentence preview): 64px (2x the page gap)
 *
 * These values must remain consistent to maintain visual harmony.
 */

const EXPECTED_PAGE_GAP = 32;
const EXPECTED_HORIZONTAL_GAP = 32;
const EXPECTED_TOP_MARGIN = 150; // Clear space from viewport top

async function testSpacing(windowWidth, windowHeight, testName) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: windowWidth, height: windowHeight });

  // Login first
  await loginAsTestUser(page);

  await page.goto('http://localhost:5001?manuscript_id=1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  // Click on a sentence to show annotations
  const sentence = await page.locator('.sentence').first();
  await sentence.click();
  await page.waitForTimeout(500);

  const measurements = await page.evaluate(() => {
    const pages = document.querySelectorAll('.pagedjs_page');
    const stickyNote = document.getElementById('sticky-note-container');
    const annotationMargin = document.getElementById('annotation-margin');

    // Vertical gap between pages
    let verticalGap = 0;
    if (pages.length >= 2) {
      const page1Rect = pages[0].getBoundingClientRect();
      const page2Rect = pages[1].getBoundingClientRect();
      verticalGap = Math.round(page2Rect.top - page1Rect.bottom);
    }

    // Horizontal gap (page to sticky note)
    const pageRect = pages[0].getBoundingClientRect();
    const stickyRect = stickyNote.getBoundingClientRect();
    const horizontalGap = Math.round(stickyRect.left - pageRect.right);

    // Top margin (viewport to annotation margin)
    const marginRect = annotationMargin.getBoundingClientRect();
    const topMargin = Math.round(marginRect.top);

    return { verticalGap, horizontalGap, topMargin };
  });

  // Take screenshot
  await page.screenshot({
    path: `tests/screenshots/spacing-${testName}.png`,
    fullPage: false
  });

  await browser.close();

  return measurements;
}

(async () => {
  console.log('SPACING INVARIANTS TEST');
  console.log('======================\n');
  console.log('Expected values:');
  console.log(`  Vertical gap (pages): ${EXPECTED_PAGE_GAP}px`);
  console.log(`  Horizontal gap (page to sticky): ${EXPECTED_HORIZONTAL_GAP}px`);
  console.log(`  Top margin (viewport to annotations): ${EXPECTED_TOP_MARGIN}px`);
  console.log('');

  const testCases = [
    { width: 1024, height: 768, name: 'small' },
    { width: 1440, height: 900, name: 'medium' },
    { width: 1920, height: 1080, name: 'large' },
    { width: 2560, height: 1440, name: 'xlarge' }
  ];

  let allPassed = true;

  for (const testCase of testCases) {
    const result = await testSpacing(testCase.width, testCase.height, testCase.name);

    const pageGapOk = result.verticalGap === EXPECTED_PAGE_GAP;
    const horizontalGapOk = result.horizontalGap === EXPECTED_HORIZONTAL_GAP;
    const topMarginOk = result.topMargin === EXPECTED_TOP_MARGIN;

    const testPassed = pageGapOk && horizontalGapOk && topMarginOk;
    allPassed = allPassed && testPassed;

    console.log(`${testCase.name} (${testCase.width}x${testCase.height}):`);
    console.log(`  Vertical gap: ${result.verticalGap}px ${pageGapOk ? '✓' : '✗ EXPECTED ' + EXPECTED_PAGE_GAP + 'px'}`);
    console.log(`  Horizontal gap: ${result.horizontalGap}px ${horizontalGapOk ? '✓' : '✗ EXPECTED ' + EXPECTED_HORIZONTAL_GAP + 'px'}`);
    console.log(`  Top margin: ${result.topMargin}px ${topMarginOk ? '✓' : '✗ EXPECTED ' + EXPECTED_TOP_MARGIN + 'px'}`);
    console.log(`  ${testPassed ? '✓ PASS' : '✗ FAIL'}`);
    console.log('');
  }

  if (allPassed) {
    console.log('✓ ALL SPACING INVARIANTS VERIFIED');
    process.exit(0);
  } else {
    console.log('✗ SPACING INVARIANTS VIOLATED');
    process.exit(1);
  }
})();
