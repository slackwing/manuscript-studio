/**
 * Suggestion-modal robustness: raw variation-editor input + failed-save
 * preservation.
 *
 * Input: the pane edits RAW .manuscript text (shared edit-pane) — Enter and
 * Tab insert literal characters; the → overlay marks tabs. (Historical note:
 * length (2 chars → 1), but the old code subtracted the count of ALL
 * newlines before the caret, so after pressing Shift+Enter the caret
 * landed BEFORE the glyph and subsequent typing came out reversed
 * ("abc\n" + "def" → "abcdef¶" instead of "abc¶def").
 *
 * Bug 2 (failed save): save() used to close() the modal BEFORE the PUT
 * resolved, so a 500/409/network failure destroyed the user's typed text.
 * Now the modal must stay open (text intact) on failure; the
 * newText === current early-return still closes immediately without a PUT.
 */

const { execSync } = require('child_process');
const { chromium } = require('playwright');
const {
  TEST_URL,
  cleanupTestAnnotations,
  loginAsTestUser,
  waitForPagination, TEST_USERNAME,
} = require('./test-utils');

function psql(sql) {
  return execSync(
    `PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`,
    { encoding: 'utf-8' }
  ).trim();
}

(async () => {
  console.log('=== Suggestion modal: caret math + failed-save preservation ===\n');

  // Wipe leftover suggestions FIRST — cleanupTestAnnotations deletes
  // sentence rows and a lingering FK would block it.
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

  const alerts = [];
  page.on('dialog', async d => { alerts.push(d.message()); await d.accept(); });

  const putRequests = [];
  page.on('request', r => {
    if (r.method() === 'PUT' && r.url().includes('/suggestion')) putRequests.push(r.url());
  });

  try {
    await loginAsTestUser(page);
    await page.goto(TEST_URL);
    await page.waitForSelector('.pagedjs_page', { timeout: 30000 });
    await page.waitForSelector('.sentence', { timeout: 10000 });
    await waitForPagination(page);

    const first = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('.sentence[data-sentence-id]'));
      const el = els.find(e => {
        const t = e.textContent.trim();
        return t.length > 30 && !t.startsWith('#');
      });
      if (!el) return null;
      const map = window.WriteSysRenderer && window.WriteSysRenderer.sentenceMap;
      return {
        id: el.dataset.sentenceId,
        text: (map && map[el.dataset.sentenceId]) || el.textContent,
      };
    });
    assert(!!first && !!first.id, `Found a prose sentence (${first && first.id.slice(0, 12)}...)`);

    // ---- Raw variation-editor mode: newlines and tabs stay LITERAL ----
    // (The glyph conversion died with the old modal — the pane now edits raw
    // .manuscript text exactly like a snippet variation: Enter = \n, Tab = \t.)

    await page.evaluate((sid) => window.WriteSysSuggestions.openModal(sid), first.id);
    await page.waitForSelector('#suggestion-modal', { timeout: 3000 });
    const ta = page.locator('.suggestion-modal-textarea');

    await ta.fill('abc');
    await ta.press('Enter');
    await page.keyboard.type('def');
    const typed = await ta.inputValue();
    assert(typed === 'abc\ndef',
      `Enter inserts a REAL newline, caret follows (got ${JSON.stringify(typed)})`);
    await ta.press('Tab');
    const tabbed = await ta.inputValue();
    assert(tabbed === 'abc\ndef\t',
      `Tab inserts a literal \\t like the variation editor (got ${JSON.stringify(tabbed)})`);
    // The shared overlay renders the tab as a → marker.
    const overlayTabs = await page.evaluate(() =>
      document.querySelectorAll('#suggestion-modal .sn-text-overlay .sn-tab').length);
    assert(overlayTabs === 1, `Tab overlay glyph rendered (got ${overlayTabs})`);

    await ta.press('Escape');
    await page.waitForSelector('#suggestion-modal', { state: 'detached', timeout: 3000 });

    // ---- Bug 2: failed save keeps the modal (and text) open ----

    await page.route('**/api/sentences/*/suggestion', route => {
      if (route.request().method() === 'PUT') {
        return route.fulfill({ status: 500, body: 'boom' });
      }
      return route.continue();
    });

    await page.evaluate((sid) => window.WriteSysSuggestions.openModal(sid), first.id);
    await page.waitForSelector('#suggestion-modal', { timeout: 3000 });
    const survivorText = 'edited text that must survive a failed save';
    await page.locator('.suggestion-modal-textarea').fill(survivorText);
    await page.locator('.suggestion-modal-textarea').press('Escape');
    await page.waitForTimeout(500);

    const modalStillOpen = await page.locator('#suggestion-modal').count();
    assert(modalStillOpen === 1, 'Modal stays open after a 500 on PUT');
    const keptText = modalStillOpen === 1
      ? await page.locator('.suggestion-modal-textarea').inputValue()
      : '';
    assert(keptText === survivorText,
      `User's text is preserved in the modal (got "${keptText}")`);
    // Autosave pane: failures surface in the STATUS slot (retry ladder), not
    // a blocking alert — the modal quietly retries until it lands.
    const statusText = await page.locator('#suggestion-modal .sn-save').textContent();
    assert(/failed to save/i.test(statusText),
      `Retry-ladder status shown instead of an alert (got "${statusText}")`);
    assert(alerts.length === 0, `No blocking alert on a retryable failure (got ${JSON.stringify(alerts)})`);

    await page.unroute('**/api/sentences/*/suggestion');
    if (modalStillOpen === 1) {
      // Server reachable again: restore the ORIGINAL text so the flush-on-close
      // collapses the suggestion to none (autosave close always saves).
      await page.locator('.suggestion-modal-textarea').fill(first.text);
      await page.locator('.suggestion-modal-textarea').press('Escape');
      await page.waitForSelector('#suggestion-modal', { state: 'detached', timeout: 5000 });
    }

    const rows = psql(`SELECT COUNT(*) FROM suggested_change WHERE user_id='${TEST_USERNAME}'`);
    assert(rows === '0', `No suggestion row remains after revert-and-close (count: ${rows})`);

    // ---- newText === current still closes immediately, without a PUT ----

    const putsBefore = putRequests.length;
    await page.evaluate((sid) => window.WriteSysSuggestions.openModal(sid), first.id);
    await page.waitForSelector('#suggestion-modal', { timeout: 3000 });
    await page.locator('.suggestion-modal-textarea').press('Escape'); // unchanged text
    await page.waitForSelector('#suggestion-modal', { state: 'detached', timeout: 3000 });
    assert(true, 'Unchanged text closes the modal immediately');
    await page.waitForTimeout(500);
    assert(putRequests.length === putsBefore,
      `Unchanged text issues no PUT (got ${putRequests.length - putsBefore} extra)`);

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
