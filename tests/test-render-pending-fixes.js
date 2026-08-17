/**
 * PENDING-FIX ledger for the render pipeline (CODE_REVIEW_AUG_2026.md AREA 3).
 *
 * Every assertion here pins an invariant that SHOULD hold but is known-broken
 * today. Assertions run for real; failures are counted and printed as
 * "PENDING-FIX: ..." lines, and the script exits 0 — it only exits non-zero
 * if the harness itself crashes. When a fix lands, its assertions flip to ✅
 * ("fix landed") — move them into the main e2e files then.
 *
 * Currently pinned:
 *   R25 — renderManuscript has no reentrancy guard (renderer.js:209–340).
 *     Two overlapping calls each capture the same "old pages" snapshot; the
 *     loser's tree is stranded. Verified 2026-08-17: two .pagedjs_pages
 *     trees survive, every sentence rendered twice. Invariant after fix:
 *     overlapping calls settle to exactly ONE tree, sentence count unchanged.
 *   OUTLINE-EMPTY — outline.render() (outline.js:137–141) clears the DOM
 *     when the outline empties but leaves stale this.itemNodes/caretEl, so
 *     the NEXT renderManuscript rejects inside updatePageInfo → updateCaret
 *     (null '.outline-nav' at outline.js:307). Trigger: the only
 *     outline-worthy suggestion (&chapter etc.) is deleted, then an in-place
 *     re-render runs. Invariant after fix: renderManuscript resolves and the
 *     outline is empty.
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
  console.log('=== Render pipeline PENDING-FIX ledger ===\n');
  psql(`DELETE FROM suggested_change WHERE user_id='${TEST_USERNAME}'`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  let pending = 0;
  const pin = (name, ok, extra) => {
    if (ok) console.log(`✅ ${name} (holds — once its siblings pass too, move the cluster to the main suite)`);
    else { pending += 1; console.log(`PENDING-FIX: ${name}${extra !== undefined ? ' — ' + extra : ''}`); }
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
    let r25err = null;
    try {
      await page.evaluate(() => {
        const R = window.WriteSysRenderer;
        window.__p1 = R.renderManuscript();
        window.__p2 = R.renderManuscript();
      });
      await page.evaluate(() => Promise.all([window.__p1, window.__p2]));
    } catch (e) { r25err = e.message.split('\n')[0]; }
    const after = await page.evaluate(() => ({
      trees: document.querySelectorAll('.pagedjs_pages').length,
      spans: document.querySelectorAll('.pagedjs_pages .sentence').length,
    }));
    pin('R25: overlapping renderManuscript calls settle without throwing',
      r25err === null, r25err || '');
    pin('R25: exactly one .pagedjs_pages tree survives overlapping renders',
      after.trees === 1, `trees=${after.trees}`);
    pin('R25: sentences render exactly once after overlapping renders',
      after.spans === before.spans, `before=${before.spans} after=${after.spans}`);

    // ---- OUTLINE-EMPTY: outline non-empty → empty transition ---------------
    // Fresh page (R25 may have stranded a tree).
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
    if (!hadOutline) {
      console.log('SKIP: outline-empty pin — the chapter suggestion never showed in the nav');
    } else {
      pin('OUTLINE-EMPTY: renderManuscript resolves after the outline empties',
        emptyErr === null, emptyErr || '');
      pin('OUTLINE-EMPTY: outline DOM is empty after the last chapter suggestion is removed',
        outlineNow.items === 0 && !outlineNow.chapter, `items=${outlineNow.items}`);
    }

  } catch (e) {
    console.log(`❌ Harness errored: ${e.message}`);
    await browser.close();
    psql(`DELETE FROM suggested_change WHERE user_id='${TEST_USERNAME}'`);
    process.exit(1);
  }

  psql(`DELETE FROM suggested_change WHERE user_id='${TEST_USERNAME}'`);
  await browser.close();
  console.log(`\n${pending} PENDING-FIX assertion${pending === 1 ? '' : 's'} (expected until the fix phase; exit 0)`);
  console.log('RESULT: PASS (ledger)');
  process.exit(0);
})().catch((e) => { console.error('Test crashed:', e); process.exit(1); });
