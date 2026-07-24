/**
 * Heading sentences with a suggestion must not render the raw "# " marker.
 *
 * renderSentencesToHTML strips the leading #-marker for display (the
 * sentence lives inside an <h*>), but applyToSpans used to diff against the
 * FULL storage text — so the moment a heading had a suggestion, the literal
 * "# " showed up inside the heading element. The fix strips the identical
 * marker from both sides of the diff (display only; the saved suggestion
 * text keeps its marker).
 */

const { execSync } = require('child_process');
const { chromium } = require('playwright');
const {
  TEST_URL,
  cleanupTestAnnotations,
  loginAsTestUser,
} = require('./test-utils');

function psql(sql) {
  return execSync(
    `PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`,
    { encoding: 'utf-8' }
  ).trim();
}

(async () => {
  console.log('=== Heading suggestion renders without "# " prefix ===\n');

  psql(`DELETE FROM suggested_change WHERE user_id = 'test'`);
  await cleanupTestAnnotations();

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1400, height: 900 });

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

    const heading = await page.evaluate(() => {
      const el = document.querySelector('h1 .sentence[data-sentence-id], h2 .sentence[data-sentence-id], h3 .sentence[data-sentence-id]');
      if (!el) return null;
      const map = window.WriteSysRenderer && window.WriteSysRenderer.sentenceMap;
      return {
        id: el.dataset.sentenceId,
        text: (map && map[el.dataset.sentenceId]) || null,
      };
    });
    assert(!!heading && !!heading.id, 'Found a heading sentence');
    assert(heading.text && /^#+\s/.test(heading.text),
      `Storage text carries the heading marker (got "${heading.text}")`);

    // Suggest an edit that KEEPS the marker (the common case: editing the
    // heading's words, not its level).
    const newText = `${heading.text} EDITEDWORD`;
    await page.evaluate((sid) => window.WriteSysSuggestions.openModal(sid), heading.id);
    await page.waitForSelector('#suggestion-modal', { timeout: 3000 });

    const prefill = await page.locator('.suggestion-modal-textarea').inputValue();
    assert(prefill === heading.text,
      `Modal pre-fills the full storage text incl. marker (got "${prefill}")`);

    await page.locator('.suggestion-modal-textarea').fill(newText);
    await page.locator('.suggestion-modal-textarea').press('Enter');
    await page.waitForSelector('#suggestion-modal', { state: 'detached', timeout: 5000 });

    // Wait for the Paged.js re-render to settle with the diff applied.
    await page.waitForFunction(
      (sid) => {
        const el = document.querySelector(`.sentence[data-sentence-id="${sid}"]`);
        return el && el.classList.contains('has-suggestion');
      },
      heading.id,
      { timeout: 20000 }
    );

    const state = await page.evaluate((sid) => {
      const el = document.querySelector(`.sentence[data-sentence-id="${sid}"]`);
      if (!el) return null;
      const h = el.closest('h1, h2, h3');
      return {
        inHeading: !!h,
        headingText: h ? h.textContent : el.textContent,
        strongCount: el.querySelectorAll('strong').length,
        delCount: el.querySelectorAll('del').length,
      };
    }, heading.id);

    assert(state && state.inHeading, 'Suggested sentence still renders inside an <h*>');
    assert(state && !/^\s*#/.test(state.headingText),
      `No literal "#" marker rendered in the heading (got "${state.headingText}")`);
    assert(state && state.headingText.includes('EDITEDWORD'),
      'Inserted word appears in the heading diff');
    assert(state && state.strongCount > 0,
      `Diff shows the insertion as <strong> (got ${state.strongCount})`);
    assert(state && state.delCount === 0,
      `Marker stripping produces no spurious <del> (got ${state.delCount})`);

    // The SAVED suggestion must keep its marker — stripping is display-only.
    const stored = psql(`SELECT text FROM suggested_change WHERE sentence_id='${heading.id}' AND user_id='test'`);
    assert(stored === newText,
      `Stored suggestion keeps the "#" marker intact (got "${stored}")`);

  } catch (e) {
    console.log(`✗ Test errored: ${e.message}`);
    failed = true;
  } finally {
    await browser.close();
    psql(`DELETE FROM suggested_change WHERE user_id = 'test'`);
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
