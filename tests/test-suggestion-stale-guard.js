/**
 * Stale-migration guard for PUT /api/sentences/{id}/suggestion.
 *
 * Scenario: a browser tab loaded manuscript at migration N, then migration
 * N+1 arrived in the background. If the user edits, their sentence_id
 * points at an orphaned mig-N sentence. Without a guard, the server would
 * silently write a suggestion that no current view of the manuscript can
 * see, and that never carries forward. Recovering those requires manual
 * DB surgery — so the server must 409.
 *
 * Test flow:
 *   1. Log in, load the test manuscript, grab a real sentence_id.
 *   2. Directly insert a "newer" done migration for the same manuscript,
 *      which makes the test manuscript's migration stale.
 *   3. PUT a suggestion using the stale sentence_id via the API.
 *   4. Assert 409 with body {error: "stale", latest_id, sentence_id, hint}.
 *   5. Clean up the fake migration.
 */

const { execSync } = require('child_process');
const { chromium } = require('playwright');
const {
  TEST_URL,
  API_BASE_URL,
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
  console.log('=== Stale-migration guard on PUT /suggestion ===\n');

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

  let fakeMigrationInserted = false;

  try {
    await loginAsTestUser(page);
    await page.goto(TEST_URL);
    await page.waitForSelector('.sentence', { timeout: 15000 });
    await page.waitForTimeout(1000);

    const csrfToken = await page.evaluate(() => sessionStorage.getItem('csrf_token'));
    assert(!!csrfToken, 'Got CSRF token after login');

    const target = await page.evaluate(() => {
      const el = document.querySelector('.sentence[data-sentence-id]');
      if (!el) return null;
      const map = window.WriteSysRenderer && window.WriteSysRenderer.sentenceMap;
      return {
        id: el.dataset.sentenceId,
        text: (map && map[el.dataset.sentenceId]) || el.textContent,
        currentMigrationID: window.WriteSysRenderer && window.WriteSysRenderer.currentMigrationID,
      };
    });
    assert(!!target && !!target.id, `Grabbed a sentence_id (${target.id.slice(0, 12)}...)`);

    // Insert a "newer" done migration for the same manuscript so target's
    // migration is no longer latest. Unique key is (manuscript, commit,
    // segmenter) — use a bespoke segmenter to avoid clashing with anything
    // the processor might create.
    psql(`INSERT INTO migration (manuscript_id, commit_hash, segmenter, branch_name, sentence_count, sentence_id_array, status, started_at, finished_at, processed_at)
          VALUES (${TEST_MANUSCRIPT_ID}, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', 'stale-guard-fake-1', 'main', 0, '[]'::jsonb, 'done', NOW(), NOW(), NOW())`);
    fakeMigrationInserted = true;
    assert(true, 'Inserted a fake newer migration to make target stale');

    // Attempt PUT with the now-stale sentence_id.
    const cookies = await page.context().cookies();
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    const put = await page.evaluate(async ({ apiBase, sid, csrf, cookie }) => {
      const res = await fetch(`${apiBase}/sentences/${sid}/suggestion`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrf,
        },
        credentials: 'include',
        body: JSON.stringify({ text: 'attempted stale write' }),
      });
      const body = await res.text();
      let parsed = null;
      try { parsed = JSON.parse(body); } catch (e) {}
      return { status: res.status, body, parsed };
    }, { apiBase: API_BASE_URL, sid: target.id, csrf: csrfToken, cookie: cookieHeader });

    assert(put.status === 409, `PUT returns 409 when sentence is on a non-latest migration (got ${put.status})`);
    assert(put.parsed && put.parsed.error === 'stale',
      `Body carries error="stale" (got ${put.parsed && put.parsed.error})`);
    assert(put.parsed && typeof put.parsed.latest_id === 'number' && put.parsed.latest_id > target.currentMigrationID,
      `Body carries latest_id > current (got ${put.parsed && put.parsed.latest_id}, current ${target.currentMigrationID})`);
    assert(put.parsed && put.parsed.hint && put.parsed.hint.includes('refresh'),
      `Body carries a refresh hint`);

    const stored = psql(`SELECT COUNT(*) FROM suggested_change WHERE sentence_id='${target.id}' AND user_id='test'`);
    assert(stored === '0', `No suggested_change row created (count: ${stored})`);

  } catch (e) {
    console.log(`✗ Test errored: ${e.message}`);
    failed = true;
  } finally {
    if (fakeMigrationInserted) {
      psql(`DELETE FROM migration WHERE segmenter = 'stale-guard-fake-1'`);
    }
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
