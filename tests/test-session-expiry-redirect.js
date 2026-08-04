/**
 * When a user's session expires (or is otherwise invalidated) while the app
 * is already open, the next authenticated request 401s. The UI should redirect
 * back to login.html rather than silently fail.
 *
 * Simulated by clearing the session_token cookie on an open page, then
 * triggering an authenticated action.
 */

const { chromium } = require('playwright');
const { TEST_URL, cleanupTestAnnotations, loginAsTestUser,
  waitForPagination,
} = require('./test-utils');

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
    await waitForPagination(page);

    // Invalidate the session cookie in place.
    const cookies = await context.cookies();
    const withoutSession = cookies.filter(c => c.name !== 'session_token');
    await context.clearCookies();
    if (withoutSession.length) await context.addCookies(withoutSession);

    // Trigger any authenticatedFetch — its 401 handler is what surfaces the
    // expiry. Since the app-wide session guard landed (fe601df), the book
    // page shows the IN-PLACE re-login modal (unsaved work survives) instead
    // of hard-redirecting; login.html is only the fallback for pages that
    // don't load the guard.
    await page.evaluate(() => window.authenticatedFetch('api/session'));

    await page.waitForSelector('.msg-overlay', { timeout: 20000 });
    assert(true, 'in-place re-login modal appears on 401');
    assert(!/login\.html/.test(page.url()),
      `stays on the book page, no hard redirect (got ${page.url()})`);
    const hasUserField = await page.locator('.msg-overlay #msg-user').count();
    assert(hasUserField === 1, 'modal offers the username field');

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
