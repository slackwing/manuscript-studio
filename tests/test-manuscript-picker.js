/**
 * Manuscript picker + per-manuscript access guards.
 *
 * Verifies:
 *   1. After login, the picker is populated with the test user's accessible
 *      manuscripts and the URL ends up at ?manuscript_id=N.
 *   2. The ⓘ tooltip carries manuscript info and shows on hover instantly.
 *   3. Hand-typing ?manuscript_id=99999 (one the user can't access) shows
 *      the empty state — no crash, picker still works.
 *   4. The server-side access guard rejects an API call with a bogus
 *      manuscript_id, even with a valid session cookie.
 *   5. After loading a manuscript, last_manuscript_name is persisted on
 *      the user row so a subsequent login lands on the same one.
 */

const { execSync } = require('child_process');
const { chromium } = require('playwright');
const {
  TEST_URL,
  TEST_MANUSCRIPT_ID,
  TEST_MANUSCRIPT_NAME,
  TEST_USERNAME,
  cleanupTestAnnotations,
  cleanupTestSessions,
  loginAsTestUser,
} = require('./test-utils');

function psql(sql) {
  return execSync(
    `PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`,
    { encoding: 'utf-8' }
  ).trim();
}

(async () => {
  console.log('=== Manuscript picker + access guards ===\n');

  await cleanupTestAnnotations();
  await cleanupTestSessions();

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
    // 1. Login → picker populated, URL has ?manuscript_id.
    await loginAsTestUser(page);
    await page.goto(TEST_URL);
    await page.waitForSelector('.pagedjs_page', { timeout: 30000 });
    await page.waitForTimeout(1000);

    const pickerOptions = await page.evaluate(() => {
      const sel = document.querySelector('#manuscript-picker-select');
      if (!sel) return null;
      return Array.from(sel.options).map(o => ({ value: o.value, text: o.textContent }));
    });
    assert(Array.isArray(pickerOptions) && pickerOptions.length >= 1,
      `Picker rendered with ${pickerOptions ? pickerOptions.length : 0} option(s)`);
    assert(pickerOptions.some(o => o.text === TEST_MANUSCRIPT_NAME),
      `Picker contains "${TEST_MANUSCRIPT_NAME}"`);

    const url = new URL(page.url());
    assert(url.searchParams.get('manuscript_id') === String(TEST_MANUSCRIPT_ID),
      `URL has ?manuscript_id=${TEST_MANUSCRIPT_ID}`);

    // 2. Tooltip on hover.
    await page.locator('#info-icon').hover();
    await page.waitForTimeout(150);
    const tooltipText = await page.evaluate(() => {
      const popup = document.querySelector('.info-popup');
      return popup ? popup.textContent : '';
    });
    assert(tooltipText.includes(TEST_MANUSCRIPT_NAME),
      `Tooltip mentions manuscript name (got: "${tooltipText.slice(0, 80)}...")`);
    assert(tooltipText.includes('Commit'),
      `Tooltip carries commit info`);

    // 3. Bogus manuscript_id → empty state, no crash, picker still there.
    await page.goto('http://localhost:5001/?manuscript_id=99999');
    await page.waitForTimeout(1500);
    const emptyState = await page.evaluate(() => ({
      pickerPresent: !!document.querySelector('#manuscript-picker-select'),
      pageCount: document.querySelectorAll('.pagedjs_page').length,
      infoIconVisible: getComputedStyle(document.getElementById('info-icon')).display !== 'none',
    }));
    assert(emptyState.pickerPresent, 'Picker still rendered with bogus id');
    assert(emptyState.pageCount === 0, `No pages rendered (got ${emptyState.pageCount})`);
    assert(!emptyState.infoIconVisible, 'Info icon hidden when no manuscript loaded');

    // 4. Server-side access guard.
    const cookies = await page.context().cookies();
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const guardRes = await fetch(`http://localhost:5001/api/migrations/latest?manuscript_id=99999`, {
      headers: { Cookie: cookieHeader },
    });
    assert(guardRes.status === 404, `Bogus manuscript_id returns 404 (got ${guardRes.status})`);

    // 5. last_manuscript_name was persisted from the first navigation.
    const lastInDb = psql(`SELECT last_manuscript_name FROM "user" WHERE username = '${TEST_USERNAME}'`);
    assert(lastInDb === TEST_MANUSCRIPT_NAME,
      `user.last_manuscript_name = "${lastInDb}" (want "${TEST_MANUSCRIPT_NAME}")`);

  } catch (e) {
    console.log(`✗ Test errored: ${e.message}\n${e.stack}`);
    failed = true;
  } finally {
    await browser.close();
    await cleanupTestSessions();
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
