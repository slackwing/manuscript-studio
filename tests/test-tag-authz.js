// Tag endpoint authorization test (no browser needed).
//
// Regression: the three /api/notes/{id}/tags endpoints used to have no
// session/ownership/CSRF checks at all — any authenticated user could read,
// add, or delete tags on any other user's annotations by enumerating integer
// IDs, and could attach tags to arbitrary migrations via the request body.
const {BASE_URL, SYSTEM_TOKEN, TEST_MANUSCRIPT_NAME, cleanupTestAnnotations, psql} = require('./test-utils');

const API = `${BASE_URL}/api`;

async function login(username, password) {
  const resp = await fetch(`${API}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!resp.ok) throw new Error(`login ${username} failed: ${resp.status}`);
  const setCookie = resp.headers.get('set-cookie') || '';
  const cookie = setCookie.split(';')[0];
  const data = await resp.json();
  return { cookie, csrf: data.csrf_token };
}

(async () => {
  console.log('=== Tag Authorization Test ===\n');
  let failed = 0;
  const check = (name, ok, detail = '') => {
    console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` (${detail})` : ''}`);
    if (!ok) failed++;
  };

  await cleanupTestAnnotations();

  // Earlier runs (or the 038 data migration) may have left test-other with
  // the full power set on this manuscript — reset to nothing so the
  // reader-only grant below is what's actually in force.
  try {
    psql(`DELETE FROM role WHERE username = 'test-other' AND manuscript_id IN (SELECT manuscript_id FROM manuscript WHERE name = '${TEST_MANUSCRIPT_NAME}');`);
    psql(`DELETE FROM manuscript_access WHERE username = 'test-other';`);
  } catch (e) { /* fresh DB */ }

  // Second user, granted access to the same manuscript.
  for (const [path, body] of [
    ['users', { username: 'test-other', password: 'test' }],
    // v3: the default admin grant is the full power set — scope test-other
    // to READER so cross-user tag access stays forbidden.
    ['grants', { username: 'test-other', manuscript_name: TEST_MANUSCRIPT_NAME, roles: ['reader'] }],
  ]) {
    const resp = await fetch(`${API}/admin/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SYSTEM_TOKEN}` },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`admin/${path} failed: ${resp.status}`);
  }

  const owner = await login('test', 'test');
  const other = await login('test-other', 'test');

  // Find a sentence to annotate.
  const latestResp = await fetch(`${API}/migrations/latest?manuscript_id=1`, {
    headers: { Cookie: owner.cookie },
  });
  const latest = await latestResp.json();
  const migration = latest.migration || latest;
  const sentenceId = (migration.sentence_id_array || [])[0];
  if (!sentenceId) throw new Error('no sentences in latest migration');

  // Owner creates an annotation.
  const createResp = await fetch(`${API}/notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: owner.cookie, 'X-CSRF-Token': owner.csrf },
    body: JSON.stringify({ sentence_id: sentenceId, color: 'yellow', note: 'authz test' }),
  });
  if (createResp.status !== 201) throw new Error(`create annotation failed: ${createResp.status}`);
  const { note_id: annotationId } = await createResp.json();

  // 1. Unauthenticated requests are rejected outright.
  let resp = await fetch(`${API}/notes/${annotationId}/tags`);
  check('unauthenticated GET tags rejected', resp.status === 401, `got ${resp.status}`);

  // 2. Another user cannot read tags on someone else's annotation.
  resp = await fetch(`${API}/notes/${annotationId}/tags`, {
    headers: { Cookie: other.cookie },
  });
  check('non-owner GET tags rejected', resp.status === 403, `got ${resp.status}`);

  // 3. Another user cannot add tags (even with their own valid CSRF token).
  resp = await fetch(`${API}/notes/${annotationId}/tags`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: other.cookie, 'X-CSRF-Token': other.csrf },
    body: JSON.stringify({ tag_name: 'intruder', migration_id: 1 }),
  });
  check('non-owner POST tag rejected', resp.status === 403, `got ${resp.status}`);

  // 4. Owner without a CSRF token is rejected.
  resp = await fetch(`${API}/notes/${annotationId}/tags`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: owner.cookie },
    body: JSON.stringify({ tag_name: 'no-csrf', migration_id: 1 }),
  });
  check('owner POST without CSRF rejected', resp.status === 403, `got ${resp.status}`);

  // 5. Owner adds a tag with a BOGUS migration_id: the server must ignore it
  //    and scope the tag to the sentence's real migration.
  resp = await fetch(`${API}/notes/${annotationId}/tags`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: owner.cookie, 'X-CSRF-Token': owner.csrf },
    body: JSON.stringify({ tag_name: 'legit-tag', migration_id: 999999 }),
  });
  check('owner POST tag accepted', resp.status === 201, `got ${resp.status}`);
  const tagData = resp.status === 201 ? await resp.json() : { tags: [] };
  const tag = (tagData.tags || []).find(t => t.tag_name === 'legit-tag');
  check('tag migration_id derived server-side, not client value',
    tag && tag.migration_id !== 999999, tag ? `migration_id=${tag.migration_id}` : 'tag missing');

  // 6. Non-owner cannot delete the tag; owner can.
  if (tag) {
    resp = await fetch(`${API}/notes/${annotationId}/tags/${tag.tag_id}`, {
      method: 'DELETE',
      headers: { Cookie: other.cookie, 'X-CSRF-Token': other.csrf },
    });
    check('non-owner DELETE tag rejected', resp.status === 403, `got ${resp.status}`);

    resp = await fetch(`${API}/notes/${annotationId}/tags/${tag.tag_id}`, {
      method: 'DELETE',
      headers: { Cookie: owner.cookie, 'X-CSRF-Token': owner.csrf },
    });
    check('owner DELETE tag succeeds', resp.status === 204, `got ${resp.status}`);
  }

  // Clean up the annotation so later tests start fresh.
  await fetch(`${API}/notes/${annotationId}`, {
    method: 'DELETE',
    headers: { Cookie: owner.cookie, 'X-CSRF-Token': owner.csrf },
  });

  console.log(failed === 0 ? '\nAll tag authorization checks passed.' : `\n${failed} check(s) FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(err => {
  console.error('Test crashed:', err);
  process.exit(1);
});
