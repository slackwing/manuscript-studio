// Wordcount history e2e (API-level, no browser): the optional
// wordcount_history feature — enabled in dev config — computes one row per
// manuscript per day (committed / effective / linked-snippet words, all
// users) and the homepage + info-header wordcounts source from it.
//
// Variation semantics (VARIATIONS_PLAN §6): a linked, non-canonized snippet
// group contributes exactly ONE representative — its most recently updated
// variation — because sibling variations are alternatives of one passage.
//
// Flow: baseline compute → linked group with TWO variations (7-word A,
// 9-word B updated later) + an unlinked group → recompute → words_snippets
// counts B only (9), and /api/home + /api/migrations/latest serve the
// table-sourced total.
const {
  TEST_MANUSCRIPT_ID, API_BASE_URL, TEST_USERNAME, TEST_PASSWORD, SYSTEM_TOKEN,
  cleanupTestAnnotations,
} = require('./test-utils');

// Variation A: 7 prose words. Variation B (updated later): 9 — the
// representative, since it's the most recently updated.
const TEXT_A = 'Seven words of progress toward the book.';
const TEXT_B = 'Nine whole words of progress toward the book now.';
const REP_WORDS = 9;

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

    // --- a LINKED group with two variations + an unlinked group ---
    const groupCtx = await (await authed('/snippets', { method: 'POST', body: JSON.stringify({ mode: 'new' }) })).json();
    const varA = groupCtx.variation.variation_id;
    check('snippet group + variation A created', groupCtx.variation.ordinal === 1, `#${groupCtx.snippet.snippet_id}`);
    let r = await authed(`/variations/${varA}`, { method: 'PUT', body: JSON.stringify({ text: TEXT_A }) });
    check('A text saved', r.status === 204);
    r = await authed(`/snippets/${groupCtx.snippet.snippet_id}/link`, {
      method: 'PUT', body: JSON.stringify({ manuscript_id: TEST_MANUSCRIPT_ID }),
    });
    check('group linked to the test manuscript', r.ok);
    // Variation B, based on A, updated later → the representative.
    const ctxB = await (await authed('/snippets', {
      method: 'POST', body: JSON.stringify({ mode: 'variation', source_variation_id: varA, freeze_source: false }),
    })).json();
    r = await authed(`/variations/${ctxB.variation.variation_id}`, { method: 'PUT', body: JSON.stringify({ text: TEXT_B }) });
    check('B text saved (most recently updated)', r.status === 204);
    // An UNLINKED group must not count toward any manuscript.
    const loose = await (await authed('/snippets', { method: 'POST', body: JSON.stringify({ mode: 'new' }) })).json();
    await authed(`/variations/${loose.variation.variation_id}`, {
      method: 'PUT', body: JSON.stringify({ text: 'These words float free of any book.' }),
    });

    const after = await compute();
    check('ONE representative counted (B, not A+B)', after.words_snippets === REP_WORDS,
      `got ${after.words_snippets}, want ${REP_WORDS}`);
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
    check('history endpoint returns today\'s row', today && today.words_snippets === REP_WORDS);
  } finally {
    // cleanupTestAnnotations wipes this user's snippets/variations; then
    // recompute so the table stays consistent for other consumers.
    await cleanupTestAnnotations();
    try { await admin('/admin/wordcount-compute', { method: 'POST' }); } catch (e) { /* best effort */ }
  }

  console.log(failed === 0 ? '\n✅ Test passed' : `\n❌ ${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(err => { console.error('Test crashed:', err); process.exit(1); });
