/**
 * Suggestion scroll restore.
 *
 * After saving a suggestion the URL gets stamped with ?scroll_to=<id>; on
 * a subsequent reload, the page should scroll the affected sentence into
 * view (instead of dumping the user at the top).
 *
 * The test picks a sentence near the BOTTOM of the manuscript so that the
 * "did we actually scroll?" check is unambiguous — page 1 sentences would
 * be visible whether or not scroll restore worked.
 */

const { execSync } = require('child_process');
const { chromium } = require('playwright');
const {
  TEST_URL,
  cleanupTestAnnotations,
  TEST_USERNAME,
  loginAsTestUser,
} = require('./test-utils');

function psql(sql) {
  return execSync(
    `PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`,
    { encoding: 'utf-8' }
  ).trim();
}

(async () => {
  console.log('=== Suggestion scroll restore ===\n');

  psql(`DELETE FROM suggested_change WHERE user_id = '${TEST_USERNAME}'`);
  await cleanupTestAnnotations();

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1400, height: 900 });
  page.on('pageerror', err => console.log(`[page error] ${err.message}`));

  let failed = false;
  function assert(cond, msg) {
    if (cond) console.log(`✓ ${msg}`);
    else { console.log(`✗ ${msg}`); failed = true; }
  }

  try {
    await loginAsTestUser(page);
    await page.goto(TEST_URL);
    await page.waitForSelector('.pagedjs_page', { timeout: 30000 });
    await page.waitForSelector('.sentence', { timeout: 10000 });
    await page.waitForTimeout(1500);

    // Pick a sentence that lives well below the fold — guarantees scroll
    // restore is the only thing that could put it on screen after reload.
    const target = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('.sentence[data-sentence-id]'));
      const candidate = els.find((el, i) => i > 100 && el.textContent.trim().length > 30);
      if (!candidate) return null;
      const map = window.WriteSysRenderer && window.WriteSysRenderer.sentenceMap;
      return {
        id: candidate.dataset.sentenceId,
        text: (map && map[candidate.dataset.sentenceId]) || candidate.textContent,
      };
    });
    assert(!!target && !!target.id, `Found a far-down sentence (${target && target.id.slice(0, 12)}...)`);

    // Scroll the target sentence into view first, so "stays in place" is a
    // meaningful assertion. Without this the user is at y=0 and the sentence
    // lives far down — it can't "stay visible" because it wasn't visible.
    await page.evaluate((sid) => {
      const el = document.querySelector(`.sentence[data-sentence-id="${sid}"]`);
      el.scrollIntoView({ block: 'center' });
    }, target.id);
    await page.waitForTimeout(500);

    const newText = target.text.replace(/\.$/, '') + ' (SCROLL TARGET).';
    await page.evaluate((sid) => window.WriteSysSuggestions.openModal(sid), target.id);
    await page.waitForSelector('#suggestion-modal');
    await page.locator('.suggestion-modal-textarea').fill(newText);
    await page.locator('.suggestion-modal-textarea').press('Enter');
    await page.waitForSelector('#suggestion-modal', { state: 'detached', timeout: 3000 });
    await page.waitForTimeout(2000); // re-pagination

    const url = page.url();
    assert(url.includes(`scroll_to=${target.id}`),
      `URL stamped with ?scroll_to (got "${url.slice(-80)}")`);

    // The post-save in-place re-render should keep the sentence on-screen
    // (no scroll-to-top jolt). Since we can't measure "did it jolt?"
    // directly from the final state, just assert the sentence is visible.
    const inPlaceVisible = await page.evaluate((sid) => {
      const el = document.querySelector(`.sentence[data-sentence-id="${sid}"]`);
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.bottom > 0 && r.top < window.innerHeight;
    }, target.id);
    assert(inPlaceVisible, 'Sentence stays visible after in-place re-render');

    // The affected sentence should be marked .selected after in-place save.
    const selectedInPlace = await page.evaluate((sid) => {
      const el = document.querySelector(`.sentence[data-sentence-id="${sid}"]`);
      return el && el.classList.contains('selected');
    }, target.id);
    assert(selectedInPlace, 'Sentence is marked .selected after in-place save');

    // Reload — the sentence should end up in the viewport AND selected.
    await page.reload();
    await page.waitForSelector('.pagedjs_page', { timeout: 30000 });
    await page.waitForFunction(
      (sid) => {
        const el = document.querySelector(`.sentence[data-sentence-id="${sid}"]`);
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.bottom > 0 && r.top < window.innerHeight;
      },
      target.id,
      { timeout: 15000 }
    );
    assert(true, 'Affected sentence is visible after reload (scrolled into view)');

    const selectedAfterReload = await page.evaluate((sid) => {
      const el = document.querySelector(`.sentence[data-sentence-id="${sid}"]`);
      return el && el.classList.contains('selected');
    }, target.id);
    assert(selectedAfterReload, 'Sentence is marked .selected after reload');

  } catch (e) {
    console.log(`✗ Test errored: ${e.message}`);
    failed = true;
  } finally {
    await browser.close();
    psql(`DELETE FROM suggested_change WHERE user_id = '${TEST_USERNAME}'`);
    await cleanupTestAnnotations();
  }

  if (failed) {
    console.log('\n❌ Test failed');
    process.exit(1);
  }
  console.log('\n✅ Test passed');
})().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
