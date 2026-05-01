/**
 * When a user's session expires (or is otherwise invalidated) while the app
 * is already open, the next authenticated request 401s. The UI should redirect
 * back to login.html rather than silently fail.
 *
 * Simulated by clearing the session_token cookie on an open page, then
 * triggering an authenticated action.
 */

const { chromium } = require('playwright');
const { TEST_URL, cleanupTestAnnotations, loginAsTestUser } = require('./test-utils');

(async () => {
  console.log('=== Session Expiry → Login Redirect ===\n');

  await cleanupTestAnnotations();

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
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

    // Invalidate the session cookie in place.
    const cookies = await context.cookies();
    const withoutSession = cookies.filter(c => c.name !== 'session_token');
    await context.clearCookies();
    if (withoutSession.length) await context.addCookies(withoutSession);

    // Trigger any authenticatedFetch — its 401 handler is what does the
    // redirect. (Sentence clicks no longer fetch; they read from the
    // in-memory annotation cache. So we hit a known authenticated
    // endpoint directly.)
    await page.evaluate(() => window.authenticatedFetch('api/session'));

    await page.waitForURL(/login\.html/, { timeout: 5000 });
    assert(/login\.html/.test(page.url()), `Redirected to login page (got ${page.url()})`);

  } catch (e) {
    console.log(`✗ Test errored: ${e.message}`);
    failed = true;
  } finally {
    await browser.close();
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
