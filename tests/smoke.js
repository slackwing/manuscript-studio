const { chromium } = require('playwright');
const { TEST_URL, loginAsTestUser } = require('./test-utils');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });

  // Login first
  await loginAsTestUser(page);

  await page.goto(TEST_URL);
  
  // Wait for commits to load and page to render
  await page.waitForTimeout(8000);

  // The header no longer carries a visible "migration info" line — that data
  // moved to the ⓘ-icon tooltip. Check the tooltip got populated by hovering.
  await page.locator('#info-icon').hover();
  await page.waitForTimeout(150);
  const tooltipText = await page.evaluate(() => {
    const popup = document.querySelector('.info-popup');
    return popup ? popup.textContent : '';
  });
  console.log('Info tooltip:', tooltipText.replace(/\s+/g, ' ').trim());

  // Check the manuscript was auto-loaded.
  const manuscriptLoaded = await page.evaluate(() => {
    const pages = document.querySelectorAll('.pagedjs_page');
    const sentences = document.querySelectorAll('.sentence');
    return { pageCount: pages.length, sentenceCount: sentences.length };
  });

  console.log('\nManuscript auto-load status:');
  console.log(`  Pages rendered: ${manuscriptLoaded.pageCount}`);
  console.log(`  Sentences rendered: ${manuscriptLoaded.sentenceCount}`);

  // Take screenshot (create dir if needed)
  const fs = require('fs');
  if (!fs.existsSync('tests/screenshots')) {
    fs.mkdirSync('tests/screenshots', { recursive: true });
  }
  await page.screenshot({ path: 'tests/screenshots/smoke.png' });

  if (manuscriptLoaded.pageCount > 0) {
    console.log('\n✅ Auto-load working! Manuscript rendered on page load.');
  } else {
    console.log('\n❌ Auto-load failed. No pages rendered.');
  }

  await browser.close();
})();
