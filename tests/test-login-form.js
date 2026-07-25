// The login FORM's dedicated e2e test: every other test logs in via the API
// (test-utils.loginAsTestUser), so the form flow — fields, submit, session
// cookie, post-login redirect to home — is covered exactly once, here.
const { chromium } = require('playwright');
const { loginViaForm } = require('./test-utils');

(async () => {
  console.log('=== login form e2e ===\n');
  let failed = 0;
  const check = (name, ok, detail = '') => {
    console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` (${detail})` : ''}`);
    if (!ok) failed++;
  };

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await loginViaForm(page);
    check('form login redirects to home.html', /home\.html/.test(page.url()), page.url());
    await page.waitForSelector('.home-section', { timeout: 20000 });
    check('landing page renders after form login', true);
    const session = await page.evaluate(async () => (await fetch('api/session', { credentials: 'include' })).status);
    check('session cookie installed', session === 200, `status ${session}`);
  } finally {
    await browser.close();
  }
  console.log(failed === 0 ? '\n✅ Test passed' : `\n❌ ${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(err => { console.error('Test crashed:', err); process.exit(1); });
