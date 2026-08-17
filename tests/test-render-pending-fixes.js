/**
 * FORMER pending-fix ledger for the render pipeline (CODE_REVIEW_AUG_2026.md
 * AREA 3) — both fixes have landed, so every assertion here is now FATAL
 * (failures exit 1, like any other test).
 *
 * Invariants held:
 *   R25 — renderManuscript is serialized (renderer.js renderManuscript wraps
 *     _renderManuscriptNow): overlapping calls coalesce — the second awaits
 *     the first, then ONE queued re-render runs with the LATEST opts. After
 *     two overlapping calls: exactly one .pagedjs_pages tree, sentence count
 *     unchanged, and the second call's opts (selectSentenceId) honored.
 *   OUTLINE-EMPTY — outline.render() resets itemNodes/itemStarts/caretEl when
 *     the outline empties (and updateCaret is null-safe), so an in-place
 *     re-render after the last outline-worthy suggestion is removed resolves
 *     cleanly with an empty nav.
 */
const { execSync } = require('child_process');
const { chromium } = require('playwright');
const {
  BASE_URL, TEST_URL, TEST_USERNAME, TEST_PASSWORD,
  waitForPagination,
} = require('./test-utils');

const psql = (sql) => execSync(
  `PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`,
  { encoding: 'utf-8' }).trim();

(async () => {
  console.log('=== Render pipeline fixed-invariants (R25 + outline empty-state) ===\n');
  psql(`DELETE FROM suggested_change WHERE user_id='${TEST_USERNAME}'`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  let failed = false;
  const check = (name, ok, extra) => {
    console.log(`${ok ? '✅' : '❌'} ${name}${extra !== undefined && !ok ? ' — ' + extra : ''}`);
    if (!ok) failed = true;
  };

  try {
    await page.goto(`${BASE_URL}/login.html`);
    await page.evaluate(async ([u, p]) => {
      const r = await fetch('api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify({ username: u, password: p }),
      });
      const d = await r.json();
      localStorage.setItem('csrf_token', d.csrf_token);
    }, [TEST_USERNAME, TEST_PASSWORD]);

    await page.goto(TEST_URL);
    await waitForPagination(page);

    // ---- R25: render reentrancy -------------------------------------------
    const before = await page.evaluate(() => ({
      trees: document.querySelectorAll('.pagedjs_pages').length,
      spans: document.querySelectorAll('.pagedjs_pages .sentence').length,
    }));
    // A sentence to select via the SECOND call's opts — proves the queued
    // re-render runs with the latest caller's opts.
    const selId = await page.evaluate(() => {
      const el = document.querySelector('.pagedjs_pages .sentence[data-sentence-id]');
      return el && el.dataset.sentenceId;
    });
    let r25err = null;
    try {
      await page.evaluate((id) => {
        const R = window.WriteSysRenderer;
        window.__p1 = R.renderManuscript();
        window.__p2 = R.renderManuscript({ selectSentenceId: id });
      }, selId);
      await page.evaluate(() => Promise.all([window.__p1, window.__p2]));
    } catch (e) { r25err = e.message.split('\n')[0]; }
    const after = await page.evaluate((id) => ({
      trees: document.querySelectorAll('.pagedjs_pages').length,
      spans: document.querySelectorAll('.pagedjs_pages .sentence').length,
      selApplied: [...document.querySelectorAll(`.pagedjs_pages .sentence[data-sentence-id="${CSS.escape(id)}"]`)]
        .some((el) => el.classList.contains('selected')),
      selState: window.WriteSysRenderer.currentSelectedSentenceId,
    }), selId);
    check('R25: overlapping renderManuscript calls settle without throwing',
      r25err === null, r25err || '');
    check('R25: exactly one .pagedjs_pages tree survives overlapping renders',
      after.trees === 1, `trees=${after.trees}`);
    check('R25: sentences render exactly once after overlapping renders',
      after.spans === before.spans, `before=${before.spans} after=${after.spans}`);
    check("R25: the second call's opts are honored (selectSentenceId applied)",
      after.selApplied && after.selState === selId,
      `selApplied=${after.selApplied} selState=${after.selState}`);

    // ---- OUTLINE-EMPTY: outline non-empty → empty transition ---------------
    // Fresh page for a clean baseline.
    await page.goto(TEST_URL);
    await waitForPagination(page);
    const sid = await page.evaluate(() => {
      const spans = [...document.querySelectorAll('.pagedjs_pages .sentence[data-sentence-id]')];
      const seen = {};
      spans.forEach((s) => { seen[s.dataset.sentenceId] = (seen[s.dataset.sentenceId] || 0) + 1; });
      const el = spans.find((s) => s.textContent.trim().length > 40
        && !s.textContent.trim().startsWith('#') && seen[s.dataset.sentenceId] === 1);
      return el && el.dataset.sentenceId;
    });
    await page.evaluate(async (id) => {
      await fetch(`api/sentences/${encodeURIComponent(id)}/suggestion`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': localStorage.getItem('csrf_token') || '' },
        credentials: 'same-origin',
        body: JSON.stringify({ text: '&chapter{Pending Fix Chapter}' }),
      });
      await window.WriteSysSuggestions.loadForMigration(window.WriteSysRenderer.currentMigrationID);
      await window.WriteSysRenderer.renderManuscript();
    }, sid);
    const hadOutline = await page.evaluate(() => !!document.querySelector('.outline-chapter'));
    check('OUTLINE-EMPTY: chapter suggestion shows in the nav (premise)', hadOutline);
    // Delete the suggestion → the outline must empty on the next render.
    let emptyErr = null;
    try {
      await page.evaluate(async (id) => {
        await fetch(`api/sentences/${encodeURIComponent(id)}/suggestion`, {
          method: 'DELETE',
          headers: { 'X-CSRF-Token': localStorage.getItem('csrf_token') || '' },
          credentials: 'same-origin',
        });
        await window.WriteSysSuggestions.loadForMigration(window.WriteSysRenderer.currentMigrationID);
        await window.WriteSysRenderer.renderManuscript();
      }, sid);
    } catch (e) { emptyErr = e.message.split('\n')[0]; }
    const outlineNow = await page.evaluate(() => ({
      items: document.querySelectorAll('.outline-item').length,
      chapter: !!document.querySelector('.outline-chapter'),
    }));
    check('OUTLINE-EMPTY: renderManuscript resolves after the outline empties',
      emptyErr === null, emptyErr || '');
    check('OUTLINE-EMPTY: outline DOM is empty after the last chapter suggestion is removed',
      outlineNow.items === 0 && !outlineNow.chapter, `items=${outlineNow.items}`);

  } catch (e) {
    console.log(`❌ Test errored: ${e.message}`);
    failed = true;
  } finally {
    psql(`DELETE FROM suggested_change WHERE user_id='${TEST_USERNAME}'`);
    await browser.close();
  }

  console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('Test crashed:', e); process.exit(1); });
