/**
 * Suggested-edits feature: end-to-end.
 *
 * Re-clicking the selected sentence opens a modal with monospace textarea.
 * Save (Enter) → server PUT, in-DOM span shows word-level diff
 * (<del>removed</del> / <strong>added</strong>) and a dashed underline,
 * keeping its original data-sentence-id. Refresh → suggestion persists.
 * Saving identical-to-original text → suggestion deleted server-side and
 * the dashed underline / diff markup disappear.
 */

const { execSync } = require('child_process');
const { chromium } = require('playwright');
const {
  TEST_URL,
  cleanupTestAnnotations,
  loginAsTestUser,
  TEST_MANUSCRIPT_ID,
} = require('./test-utils');

function psql(sql) {
  return execSync(
    `PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`,
    { encoding: 'utf-8' }
  ).trim();
}

(async () => {
  console.log('=== Suggested-edits end-to-end ===\n');

  // Wipe any leftover suggestions FIRST — cleanupTestAnnotations deletes
  // sentence rows and a lingering FK reference would block it.
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

    // Capture a prose sentence (skip headings — their textContent includes
    // the leading "# " markdown which the segmenter strips, so DOM text and
    // sentenceMap text differ).
    const first = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('.sentence[data-sentence-id]'));
      const longEnough = els.find(el => {
        const t = el.textContent.trim();
        return t.length > 30 && !t.startsWith('#');
      });
      if (!longEnough) return null;
      const map = window.WriteSysRenderer && window.WriteSysRenderer.sentenceMap;
      return {
        id: longEnough.dataset.sentenceId,
        text: (map && map[longEnough.dataset.sentenceId]) || longEnough.textContent,
      };
    });
    assert(!!first && !!first.id, `Found a prose sentence (${first && first.id.slice(0, 12)}...)`);

    // Click → selects.
    await page.locator(`.sentence[data-sentence-id="${first.id}"]`).first().click();
    await page.waitForTimeout(300);

    // Re-click → opens modal.
    await page.locator(`.sentence[data-sentence-id="${first.id}"]`).first().click();
    await page.waitForSelector('#suggestion-modal', { timeout: 3000 });
    assert(true, 'Re-click opens suggestion modal');

    const textareaValue = await page.locator('.suggestion-modal-textarea').inputValue();
    assert(textareaValue === first.text,
      `Textarea pre-fills with original sentence text (got "${textareaValue.slice(0,30)}..." want "${first.text.slice(0,30)}...")`);

    // Edit + Save via Enter.
    const newText = first.text.replace(/\.$/, '') + ' (with edit added).';
    await page.locator('.suggestion-modal-textarea').fill(newText);
    await page.locator('.suggestion-modal-textarea').press('Enter');
    await page.waitForSelector('#suggestion-modal', { state: 'detached', timeout: 3000 });
    assert(true, 'Enter saves and closes the modal');

    // Wait for the re-render to settle (Paged.js takes a moment).
    await page.waitForFunction(
      (sid) => {
        const el = document.querySelector(`.sentence[data-sentence-id="${sid}"]`);
        return el && el.classList.contains('has-suggestion');
      },
      first.id,
      { timeout: 15000 }
    );

    const sentenceState = await page.evaluate((sid) => {
      const el = document.querySelector(`.sentence[data-sentence-id="${sid}"]`);
      if (!el) return null;
      return {
        hasSuggestion: el.classList.contains('has-suggestion'),
        delCount: el.querySelectorAll('del').length,
        strongCount: el.querySelectorAll('strong').length,
        kept: el.dataset.sentenceId === sid,
      };
    }, first.id);

    assert(sentenceState.hasSuggestion, 'Span gets has-suggestion class');
    assert(sentenceState.kept, 'Span keeps its original sentence_id (no drift)');
    assert(sentenceState.strongCount > 0,
      `Diff includes inserted text in <strong> (got ${sentenceState.strongCount})`);

    // Persistence: server should hold the row.
    const dbRow = psql(`SELECT text FROM suggested_change WHERE sentence_id='${first.id}' AND user_id='test'`);
    assert(dbRow === newText, `Server stored the suggestion (got "${dbRow.slice(0,30)}...")`);

    // Reload → suggestion should still apply.
    await page.reload();
    await page.waitForSelector('.pagedjs_page', { timeout: 30000 });
    await page.waitForSelector('.sentence', { timeout: 10000 });
    await page.waitForTimeout(2500);
    const stillSuggested = await page.evaluate((sid) => {
      const el = document.querySelector(`.sentence[data-sentence-id="${sid}"]`);
      return el && el.classList.contains('has-suggestion');
    }, first.id);
    assert(stillSuggested, 'Suggestion persists across reload');

    // Save the original text again → suggestion should be deleted server-side.
    await page.locator(`.sentence[data-sentence-id="${first.id}"]`).first().click();
    await page.waitForTimeout(300);
    await page.locator(`.sentence[data-sentence-id="${first.id}"]`).first().click();
    await page.waitForSelector('#suggestion-modal');
    await page.locator('.suggestion-modal-textarea').fill(first.text);
    await page.locator('.suggestion-modal-textarea').press('Enter');
    await page.waitForSelector('#suggestion-modal', { state: 'detached', timeout: 3000 });
    await page.waitForTimeout(2000);

    const dbRowAfterRevert = psql(`SELECT COUNT(*) FROM suggested_change WHERE sentence_id='${first.id}' AND user_id='test'`);
    assert(dbRowAfterRevert === '0', `Reverting to original deletes the suggestion (count: ${dbRowAfterRevert})`);

    // Apostrophe regression: smartquotes converts straight ' to curly ' in
    // the rendered DOM. If the diff compares DOM text vs. straight-quote
    // suggestion text, every apostrophe shows up as a spurious <del>'</del>
    // <strong>'</strong>. Pick a sentence with an apostrophe and prove a
    // single-word edit only diffs that one word.
    const apos = await page.evaluate(() => {
      const map = window.WriteSysRenderer && window.WriteSysRenderer.sentenceMap;
      if (!map) return null;
      for (const [id, text] of Object.entries(map)) {
        if (text.includes("'") && text.length < 200 && text.split(/\s+/).length > 4) {
          return { id, text };
        }
      }
      return null;
    });
    if (apos) {
      // Suggest changing one word — append " EXTRA" before the period.
      const aposNew = apos.text.replace(/\.?$/, '') + ' EXTRA.';
      await page.locator(`.sentence[data-sentence-id="${apos.id}"]`).first().click();
      await page.waitForTimeout(300);
      await page.locator(`.sentence[data-sentence-id="${apos.id}"]`).first().click();
      await page.waitForSelector('#suggestion-modal');
      await page.locator('.suggestion-modal-textarea').fill(aposNew);
      await page.locator('.suggestion-modal-textarea').press('Enter');
      await page.waitForSelector('#suggestion-modal', { state: 'detached', timeout: 3000 });
      await page.waitForFunction(
        (sid) => {
          const el = document.querySelector(`.sentence[data-sentence-id="${sid}"]`);
          return el && el.classList.contains('has-suggestion');
        },
        apos.id,
        { timeout: 15000 }
      );
      const counts = await page.evaluate((sid) => {
        const el = document.querySelector(`.sentence[data-sentence-id="${sid}"]`);
        return {
          delCount: el.querySelectorAll('del').length,
          strongCount: el.querySelectorAll('strong').length,
          delText: Array.from(el.querySelectorAll('del')).map(e => e.textContent).join('|'),
          strongText: Array.from(el.querySelectorAll('strong')).map(e => e.textContent).join('|'),
        };
      }, apos.id);
      assert(counts.delCount === 0,
        `Apostrophes don't produce spurious <del> (got ${counts.delCount}: "${counts.delText}")`);
      assert(counts.strongCount <= 2,
        `Single-word edit produces <=2 <strong> (got ${counts.strongCount}: "${counts.strongText}")`);
      // Clean up via direct API so we don't have to wrangle multi-click
      // selection state across re-renders for the apostrophe sentence.
      await page.evaluate((sid) => window.WriteSysSuggestions.openModal(sid), apos.id);
      await page.waitForSelector('#suggestion-modal');
      await page.locator('.suggestion-modal-textarea').fill(apos.text);
      await page.locator('.suggestion-modal-textarea').press('Enter');
      await page.waitForSelector('#suggestion-modal', { state: 'detached', timeout: 3000 });
      await page.waitForTimeout(2000);
    }

    // Esc cancels: use the in-page modal API directly so we don't have to
    // wrangle multi-click state across re-renders + autofocus interactions.
    // The keydown handler is the unit under test; how the modal is opened
    // is irrelevant.
    await page.evaluate((sid) => window.WriteSysSuggestions.openModal(sid), first.id);
    await page.waitForSelector('#suggestion-modal');
    await page.locator('.suggestion-modal-textarea').fill('this should be discarded');
    await page.locator('.suggestion-modal-textarea').press('Escape');
    await page.waitForSelector('#suggestion-modal', { state: 'detached', timeout: 3000 });
    await page.waitForTimeout(500);
    const dbAfterEsc = psql(`SELECT COUNT(*) FROM suggested_change WHERE sentence_id='${first.id}' AND user_id='test'`);
    assert(dbAfterEsc === '0', `Esc discards changes (count still 0)`);

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
