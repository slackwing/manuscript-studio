const { chromium } = require('playwright');
const { TEST_URL, loginAsTestUser,
  waitForPagination,
} = require('./test-utils');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });

  // Login first
  await loginAsTestUser(page);

  await page.goto(TEST_URL);
  
  // Wait for commits to load and page to render
  await waitForPagination(page);

  // Migration info now lives in the manuscript-chrome strip's info line:
  // "Updated <ts> · <shorthash> · <n> words".
  await page.waitForFunction(() => /Updated .+ · [0-9a-f]{7}/.test(
    (document.getElementById('mc-info') || {}).textContent || ''), null, { timeout: 10000 });
  const infoLine = await page.evaluate(() => document.getElementById('mc-info').textContent);
  console.log('Chrome info line:', infoLine);

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
