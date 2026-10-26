// Personal API tokens, end to end (no browser needed): minting through the
// system-token admin API, the token-only /api/v1/points-daily (same payload
// as the session endpoint), listing without secrets, revocation.
const { BASE_URL, SYSTEM_TOKEN, TEST_USERNAME, TEST_PASSWORD, psql } = require('./test-utils');

const API = `${BASE_URL}/api`;
const ADMIN = { 'Content-Type': 'application/json', Authorization: `Bearer ${SYSTEM_TOKEN}` };

async function mint(body, headers = ADMIN) {
  const resp = await fetch(`${API}/admin/api-tokens`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: resp.status, data: resp.status === 201 ? await resp.json() : null };
}

async function pointsWithToken(token) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const resp = await fetch(`${API}/v1/points-daily`, { headers });
  return { status: resp.status, data: resp.status === 200 ? await resp.json() : null };
}

(async () => {
  console.log('=== API Token Test ===\n');
  let failed = 0;
  const check = (name, ok, detail = '') => {
    console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` (${detail})` : ''}`);
    if (!ok) failed++;
  };
  const cleanup = () => psql(`DELETE FROM api_token WHERE username = '${TEST_USERNAME}';`);
  cleanup();

  // Minting is the system token's job.
  check('minting without the system token is forbidden',
    (await mint({ username: TEST_USERNAME, name: 'x', scopes: ['points:read'] }, { 'Content-Type': 'application/json' })).status === 403);
  check('unknown scope rejected', (await mint({ username: TEST_USERNAME, name: 'x', scopes: ['notes:write'] })).status === 400);
  check('scopes required', (await mint({ username: TEST_USERNAME, name: 'x', scopes: [] })).status === 400);
  check('name required', (await mint({ username: TEST_USERNAME, name: '  ', scopes: ['points:read'] })).status === 400);
  check('past expiry rejected', (await mint({ username: TEST_USERNAME, name: 'x', scopes: ['points:read'], expires_at: '2020-01-01T00:00:00Z' })).status === 400);
  check('unknown user is a 404', (await mint({ username: 'no-such-user-xyz', name: 'x', scopes: ['points:read'] })).status === 404);

  const minted = await mint({ username: TEST_USERNAME, name: 'test-api-tokens', scopes: ['points:read'] });
  check('mint → 201', minted.status === 201, `got ${minted.status}`);
  const token = minted.data && minted.data.token;
  check('the token is mst_ + 43 chars, shown with its prefix',
    /^mst_[A-Za-z0-9_-]{43}$/.test(token || '') && minted.data.prefix === token.slice(0, 12));

  // The token-only route.
  check('v1 without a token → 401', (await pointsWithToken(null)).status === 401);
  check('v1 with the system token → 401 (not an API token)', (await pointsWithToken(SYSTEM_TOKEN)).status === 401);
  check('v1 with a made-up token → 401', (await pointsWithToken('mst_' + 'x'.repeat(43))).status === 401);
  const viaToken = await pointsWithToken(token);
  check('v1 with the token → 200', viaToken.status === 200, `got ${viaToken.status}`);
  check('payload has today + days', viaToken.data && /^\d{4}-\d{2}-\d{2}$/.test(viaToken.data.today) && Array.isArray(viaToken.data.days));

  // Same answer as the session endpoint for the same user.
  const login = await fetch(`${API}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: TEST_USERNAME, password: TEST_PASSWORD }),
  });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const viaSession = await (await fetch(`${API}/points-daily`, { headers: { Cookie: cookie } })).json();
  check('same days as /api/points-daily for the same user', JSON.stringify(viaSession.days) === JSON.stringify(viaToken.data.days));
  const tokenOnSessionRoute = await fetch(`${API}/points-daily`, { headers: { Authorization: `Bearer ${token}` } });
  check('a token does not open the session routes', tokenOnSessionRoute.status === 401, `got ${tokenOnSessionRoute.status}`);

  // Listing never shows secrets; last_used_at is recorded.
  const list = await (await fetch(`${API}/admin/api-tokens?username=${TEST_USERNAME}`, { headers: ADMIN })).json();
  const listed = (list.tokens || []).find((t) => t.id === minted.data.id);
  check('listed by prefix, without the secret or its hash',
    listed && listed.prefix === minted.data.prefix && !('token' in listed) && !JSON.stringify(list).includes(token) && !('token_hash' in listed));
  check('last_used_at recorded', listed && listed.last_used_at !== null);

  // Revocation.
  const revoke = await fetch(`${API}/admin/api-tokens/${minted.data.id}`, { method: 'DELETE', headers: ADMIN });
  check('revoke → 204', revoke.status === 204, `got ${revoke.status}`);
  check('a revoked token → 401', (await pointsWithToken(token)).status === 401);
  const again = await fetch(`${API}/admin/api-tokens/${minted.data.id}`, { method: 'DELETE', headers: ADMIN });
  check('revoking twice → 404', again.status === 404, `got ${again.status}`);

  cleanup();
  console.log(failed === 0 ? '\nAll API token checks passed.' : `\n${failed} check(s) FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error('Test crashed:', err);
  process.exit(1);
});
