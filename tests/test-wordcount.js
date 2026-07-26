// Wordcount history e2e (API-level, no browser): the optional
// wordcount_history feature — enabled in dev config — computes one row per
// manuscript per day (committed / effective / linked-snippet words, all
// users) and the homepage + info-header wordcounts source from it.
//
// Flow: baseline compute → add a scratchpad with a snippet LINKED to the
// test manuscript → recompute → snippet words appear in words_snippets and
// in the table-sourced word_count of /api/home and /api/migrations/latest.
const {
  TEST_MANUSCRIPT_ID, API_BASE_URL, TEST_USERNAME, TEST_PASSWORD, SYSTEM_TOKEN,
  cleanupTestAnnotations,
} = require('./test-utils');

// "Seven words of progress toward the book." → 7 prose words.
const SNIPPET_TEXT = 'Seven words of progress toward the book.';
const SNIPPET_WORDS = 7;

(async () => {
  console.log('=== wordcount history e2e ===\n');
  let failed = 0;
  const check = (name, ok, detail = '') => {
    console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` (${detail})` : ''}`);
    if (!ok) failed++;
  };

  await cleanupTestAnnotations();

  // --- login (cookie + CSRF from the login response) ---
  const loginResp = await fetch(`${API_BASE_URL}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: TEST_USERNAME, password: TEST_PASSWORD }),
  });
  if (!loginResp.ok) throw new Error(`login failed: ${loginResp.status}`);
  const login = await loginResp.json();
  const cookie = (loginResp.headers.get('set-cookie') || '').split(';')[0];
  const authed = (path, opts = {}) => fetch(`${API_BASE_URL}${path}`, {
    ...opts,
    headers: {
      Cookie: cookie,
      'X-CSRF-Token': login.csrf_token,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const admin = (path, opts = {}) => fetch(`${API_BASE_URL}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${SYSTEM_TOKEN}`, 'Content-Type': 'application/json' },
  });

  let padId = null;
  try {
    const compute = async () => {
      const r = await admin('/admin/wordcount-compute', { method: 'POST' });
      if (!r.ok) throw new Error(`compute failed: ${r.status} ${await r.text()}`);
      const rows = (await r.json()).rows || [];
      return rows.find(row => row.manuscript_id === TEST_MANUSCRIPT_ID);
    };

    // --- baseline: clean fixture, no suggestions, no snippets ---
    const base = await compute();
    check('compute returns a row for the test manuscript', !!base);
    check('baseline committed words > 0', base.words_committed > 0, `${base.words_committed}`);
    check('baseline effective == committed (no suggestions)', base.words_effective === base.words_committed);
    check('baseline snippet words == 0', base.words_snippets === 0);

    // --- a scratchpad with a snippet LINKED to the test manuscript ---
    const padResp = await authed('/scratchpads', { method: 'POST', body: JSON.stringify({ title: 'wordcount e2e' }) });
    padId = (await padResp.json()).scratchpad_id;
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'scratch notes do not count' }] },
        {
          type: 'snippet',
          attrs: {
            blockId: 'wc-e2e-block', text: SNIPPET_TEXT,
            manuscriptId: 0, refSlug: '', label: '', snapshotText: '',
            canonizedMigrationId: 0, canonizedAt: '', createdAt: new Date().toISOString(),
            linkedManuscriptId: TEST_MANUSCRIPT_ID, linkedManuscriptName: 'Test Manuscripts',
          },
        },
        // An UNLINKED draft must not count toward any manuscript.
        {
          type: 'snippet',
          attrs: {
            blockId: 'wc-e2e-unlinked', text: 'These words float free of any book.',
            manuscriptId: 0, refSlug: '', label: '', snapshotText: '',
            canonizedMigrationId: 0, canonizedAt: '', createdAt: new Date().toISOString(),
            linkedManuscriptId: 0, linkedManuscriptName: '',
          },
        },
      ],
    };
    const putResp = await authed(`/scratchpads/${padId}`, {
      method: 'PUT',
      body: JSON.stringify({ title: 'wordcount e2e', doc }),
    });
    check('scratchpad with linked snippet saved', putResp.ok);

    const after = await compute();
    check('linked snippet words counted', after.words_snippets === SNIPPET_WORDS,
      `got ${after.words_snippets}, want ${SNIPPET_WORDS}`);
    check('committed unchanged by snippets', after.words_committed === base.words_committed);

    // --- read paths source from the table (feature enabled in dev) ---
    const total = after.words_effective + after.words_snippets;
    const home = await (await authed('/home')).json();
    const hm = (home.manuscripts || []).find(m => m.manuscript_id === TEST_MANUSCRIPT_ID);
    check('/api/home word_count is table-sourced total', hm && hm.word_count === total,
      `home=${hm && hm.word_count}, total=${total}`);

    const latest = await (await authed(`/migrations/latest?manuscript_id=${TEST_MANUSCRIPT_ID}`)).json();
    check('/api/migrations/latest word_count is table-sourced total', latest.word_count === total,
      `latest=${latest.word_count}`);

    const hist = await (await authed(`/manuscripts/${TEST_MANUSCRIPT_ID}/wordcount-history`)).json();
    check('history endpoint enabled', hist.enabled === true);
    const today = (hist.rows || [])[hist.rows.length - 1];
    check('history endpoint returns today\'s row', today && today.words_snippets === SNIPPET_WORDS);
  } finally {
    try {
      if (padId) await authed(`/scratchpads/${padId}`, { method: 'DELETE' });
      // Leave the table consistent for other consumers: recompute now that
      // the pad is gone.
      await admin('/admin/wordcount-compute', { method: 'POST' });
    } catch (e) { /* best effort */ }
    await cleanupTestAnnotations();
  }

  console.log(failed === 0 ? '\n✅ Test passed' : `\n❌ ${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(err => { console.error('Test crashed:', err); process.exit(1); });
