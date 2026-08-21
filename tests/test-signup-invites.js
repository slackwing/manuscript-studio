// Invite-only sign-up (039) + user search.
// Covers: minting via system token, full sign-up through the login page UI
// (email + invite required), single-use + bad-code rejection, and the
// GET /api/users/search prefix autocomplete endpoint.
// Classification: FAST (own throwaway users; no manuscript state touched).

const { chromium } = require('playwright');
const {
  BASE_URL, API_BASE_URL, SYSTEM_TOKEN, WORKER, psql,
  TEST_USERNAME, TEST_PASSWORD,
} = require('./test-utils');
const utils = require('./test-utils');

const SIGNUP_USER = `signup-w${WORKER}`;

async function mintInvite(note) {
  const r = await fetch(`${API_BASE_URL}/admin/invites`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${SYSTEM_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ note }),
  });
  if (!r.ok) throw new Error(`mint failed: ${r.status} ${await r.text()}`);
  return r.json();
}

function cleanup() {
  psql(`DELETE FROM session WHERE username = '${SIGNUP_USER}';`);
  psql(`DELETE FROM invite_code WHERE note = '${SIGNUP_USER}';`);
  psql(`DELETE FROM "user" WHERE username = '${SIGNUP_USER}';`);
}

(async () => {
  cleanup();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  let failures = 0;
  const check = (ok, label) => {
    console.log(`${ok ? '✓' : '✗'} ${label}`);
    if (!ok) failures++;
  };

  try {
    // --- Mint: system token required, defaults to ~1 year ---
    const noToken = await fetch(`${API_BASE_URL}/admin/invites`, { method: 'POST' });
    check(noToken.status === 403, 'mint without token → 403');
    const minted = await mintInvite(SIGNUP_USER);
    check(/^[0-9a-f]{32}$/.test(minted.code), 'minted a 32-hex code');
    const days = (new Date(minted.expires_at) - new Date()) / 86400000;
    check(days > 360 && days < 370, `expiry ~365 days out (${days.toFixed(0)})`);

    // --- Sign-up through the login page UI ---
    await page.goto(`${BASE_URL}/login.html`);
    await page.click('#mode-toggle');
    check(await page.isVisible('#invite'), 'sign-up mode reveals email + invite fields');
    check((await page.textContent('#login-btn')).trim() === 'Sign Up', 'button reads Sign Up');
    await page.fill('#username', SIGNUP_USER);
    await page.fill('#email', `${SIGNUP_USER}@example.com`);
    await page.fill('#password', 'signup-pass-1');
    await page.fill('#invite', minted.code);
    await page.click('#login-btn');
    await page.waitForURL('**/home.html', { timeout: 10000 });
    check(true, 'sign-up lands on home with a live session');
    const email = psql(`SELECT email FROM "user" WHERE username = '${SIGNUP_USER}';`);
    check(email.includes(`${SIGNUP_USER}@example.com`), 'email stored on user row');
    const used = psql(`SELECT used_by FROM invite_code WHERE code = '${minted.code}';`);
    check(used.includes(SIGNUP_USER), 'invite marked used by the new user');

    // --- Single-use + bad codes ---
    const reuse = await fetch(`${API_BASE_URL}/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: `${SIGNUP_USER}b`, password: 'signup-pass-1', email: 'b@example.com', invite_code: minted.code }),
    });
    check(reuse.status === 403, 'used invite → 403');
    const bad = await fetch(`${API_BASE_URL}/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: `${SIGNUP_USER}b`, password: 'signup-pass-1', email: 'b@example.com', invite_code: 'nope' }),
    });
    check(bad.status === 403, 'bogus invite → 403');
    check(psql(`SELECT COUNT(*) FROM "user" WHERE username = '${SIGNUP_USER}b';`).includes('0'),
      'no half-created user from rejected sign-ups');
    const taken = await mintInvite(SIGNUP_USER);
    const dupe = await fetch(`${API_BASE_URL}/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: TEST_USERNAME, password: 'signup-pass-1', email: 'c@example.com', invite_code: taken.code }),
    });
    check(dupe.status === 409, 'taken username → 409');
    check(psql(`SELECT COUNT(*) FROM invite_code WHERE code = '${taken.code}' AND used_by IS NULL;`).includes('1'),
      'taken-username attempt does not burn the invite');

    // --- Missing email rejected ---
    const noEmail = await fetch(`${API_BASE_URL}/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: `${SIGNUP_USER}b`, password: 'signup-pass-1', email: '', invite_code: taken.code }),
    });
    check(noEmail.status === 400, 'missing email → 400');

    // --- User search (authed; the new user's own session cookie works) ---
    const anon = await fetch(`${API_BASE_URL}/users/search?q=sig`);
    check(anon.status === 401, 'user search requires auth');
    const found = await page.evaluate(async (q) => {
      const r = await fetch(`api/users/search?q=${q}`);
      return r.json();
    }, SIGNUP_USER.slice(0, 6));
    check((found.users || []).includes(SIGNUP_USER), 'prefix search finds the new user');
    const none = await page.evaluate(async () => (await fetch('api/users/search?q=zzzznobody')).json());
    check((none.users || []).length === 0, 'no-match search returns empty list');

    // --- Autocomplete in the settings modal (typing a prefix shows the name) ---
    // Reuse the standard test user, who holds admin on the worker fixture.
    await page.context().clearCookies();
    await page.goto(`${BASE_URL}/login.html`);
    await page.fill('#username', TEST_USERNAME);
    await page.fill('#password', TEST_PASSWORD);
    await page.click('#login-btn');
    await page.waitForURL('**/home.html', { timeout: 10000 });
    await page.click(`.ms-gear[data-settings="${utils.TEST_MANUSCRIPT_ID}"]`);
    await page.waitForSelector('#msm-add-user', { timeout: 10000 });
    await page.fill('#msm-add-user', SIGNUP_USER);
    await page.waitForSelector('.msm-user-ac-item', { timeout: 5000 });
    const item = await page.textContent('.msm-user-ac-item');
    check(item === SIGNUP_USER, 'settings autocomplete lists the user');
    await page.click('.msm-user-ac-item');
    check(await page.inputValue('#msm-add-user') === SIGNUP_USER, 'clicking fills the input');
  } catch (err) {
    console.error('Test crashed:', err.message);
    failures++;
  } finally {
    await browser.close();
    cleanup();
  }

  if (failures) {
    console.log(`\n❌ ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\n✅ Test passed');
})();
