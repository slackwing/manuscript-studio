// Multi-user / permissions v3 e2e (PERMISSIONS_PLAN.md): two real users on
// one local-mode manuscript — role grants, suggestion visibility + review,
// stale-after-migration, note visibility + hide, reader isolation, tab
// gating. API-driven through authenticated browser contexts (fast, low
// flake), with UI spot-checks where chrome gating is the point.
const { chromium } = require('playwright');
const os = require('os');
const path = require('path');
const fs = require('fs');
const {
  BASE_URL, API_BASE_URL, TEST_USERNAME, SYSTEM_TOKEN, loginAsTestUser, waitForPagination, psql,
} = require('./test-utils');

const SLUG = `mu-${TEST_USERNAME}-${Date.now()}`;
const EDITOR2 = `mu2${TEST_USERNAME}`;
const READER3 = `mu3${TEST_USERNAME}`;
const LOCAL_REPO_DIR = path.join(os.homedir(), '.config', 'manuscript-studio-dev', 'repos', 'git', 'local', SLUG);

function cleanup() {
  try { psql(`DELETE FROM note_hide WHERE note_id IN (SELECT note_id FROM note WHERE sentence_id LIKE '${SLUG}-%');`); } catch (e) {}
  try { psql(`DELETE FROM note_tag WHERE note_id IN (SELECT note_id FROM note WHERE sentence_id LIKE '${SLUG}-%');`); } catch (e) {}
  try { psql(`DELETE FROM note_version WHERE note_id IN (SELECT note_id FROM note WHERE sentence_id LIKE '${SLUG}-%');`); } catch (e) {}
  try { psql(`DELETE FROM note WHERE sentence_id LIKE '${SLUG}-%';`); } catch (e) {}
  try { psql(`DELETE FROM suggested_change WHERE sentence_id LIKE '${SLUG}-%';`); } catch (e) {}
  try { psql(`DELETE FROM people_order WHERE manuscript_id IN (SELECT manuscript_id FROM manuscript WHERE name = '${SLUG}');`); } catch (e) {}
  try { psql(`DELETE FROM role WHERE manuscript_id IN (SELECT manuscript_id FROM manuscript WHERE name = '${SLUG}');`); } catch (e) {}
  try { psql(`DELETE FROM manuscript WHERE name = '${SLUG}';`); } catch (e) {}
  try { fs.rmSync(LOCAL_REPO_DIR, { recursive: true, force: true }); } catch (e) {}
}

// api(page, method, path, body) → {status, json} via the page's session.
async function api(page, method, apiPath, body) {
  return page.evaluate(async ({ method, apiPath, body }) => {
    const csrf = sessionStorage.getItem('csrf_token') || localStorage.getItem('csrf_token') || '';
    const r = await fetch(apiPath, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await r.clone().json(); } catch (e) { /* non-JSON */ }
    return { status: r.status, json };
  }, { method, apiPath, body });
}

async function loginAs(browser, username, password) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const resp = await page.request.post(`${API_BASE_URL}/login`, {
    data: { username, password },
  });
  if (!resp.ok()) throw new Error(`login ${username}: ${resp.status()}`);
  const data = await resp.json();
  await page.goto(`${BASE_URL}/home.html`);
  await page.evaluate((csrf) => sessionStorage.setItem('csrf_token', csrf), data.csrf_token);
  return page;
}

(async () => {
  console.log('=== multi-user roles e2e ===\n');
  let failed = 0;
  const check = (name, ok, detail = '') => {
    console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` (${detail})` : ''}`);
    if (!ok) failed++;
  };
  cleanup();

  // Provision the two extra users (system token; idempotent upsert).
  for (const u of [EDITOR2, READER3]) {
    const r = await fetch(`${API_BASE_URL}/admin/users`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SYSTEM_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u, password: 'test' }),
    });
    if (!r.ok) { console.error(`provision ${u}: ${r.status}`); process.exit(1); }
  }

  const browser = await chromium.launch({ headless: true });
  try {
    // ---- owner: create manuscript, self-grant, grant others -------------
    const ownerPage = await loginAs(browser, TEST_USERNAME, 'test');
    let r = await api(ownerPage, 'POST', 'api/manuscripts', { display_name: 'MU Book', name: SLUG });
    check('owner creates local manuscript', r.status === 201, `status ${r.status}`);
    const mid = r.json.manuscript.manuscript_id;

    // v3.2: the creator arrives as admin+author already — grants below are
    // for the collaborators (self-author is an idempotent no-op kept to
    // prove idempotency).
    for (const [user, role] of [[TEST_USERNAME, 'author'],
                                [EDITOR2, 'editor'], [READER3, 'reader']]) {
      r = await api(ownerPage, 'POST', `api/manuscripts/${mid}/roles`, { username: user, role });
      check(`grant ${role} to ${user === TEST_USERNAME ? 'self' : user}`, r.status === 201, `status ${r.status}`);
    }
    // Editor cannot hand out roles (no manage-role-*).
    const e2Page = await loginAs(browser, EDITOR2, 'test');
    r = await api(e2Page, 'POST', `api/manuscripts/${mid}/roles`, { username: EDITOR2, role: 'author' });
    check('editor cannot self-promote to author', r.status === 403, `status ${r.status}`);

    // Wait for the seed bootstrap migration.
    let latest = null;
    for (let i = 0; i < 30 && !latest; i++) {
      const lr = await api(ownerPage, 'GET', `api/migrations/latest?manuscript_id=${mid}`);
      if (lr.status === 200) latest = lr.json;
      else await new Promise(res => setTimeout(res, 500));
    }
    check('seed migration completes', !!latest, latest && latest.commit_hash);
    const manu = await api(ownerPage, 'GET', `api/migrations/${latest.migration_id}/manuscript`);
    const titleSid = manu.json.sentences[0].id;

    // ---- suggestions: visibility + review + contested win ---------------
    r = await api(ownerPage, 'PUT', `api/sentences/${encodeURIComponent(titleSid)}/suggestion`,
      { text: '# MU Book (owner rewrite)' });
    check('owner files a suggestion', r.status === 200, `status ${r.status}`);
    r = await api(e2Page, 'PUT', `api/sentences/${encodeURIComponent(titleSid)}/suggestion`,
      { text: '# MU Book: Editor2 Revised' });
    check('editor2 files a competing suggestion', r.status === 200, `status ${r.status}`);

    r = await api(e2Page, 'GET', `api/migrations/${latest.migration_id}/suggestions`);
    check('editor2 sees BOTH suggestions (see-others-edits)',
      r.json.suggestions.length === 2, `count ${r.json.suggestions.length}`);
    check('payload exposes reviewer capability', r.json.can_review === true);

    // editor2 rejects the owner's suggestion (manage-others-suggestions).
    r = await api(e2Page, 'POST', `api/sentences/${encodeURIComponent(titleSid)}/suggestion/review`,
      { username: TEST_USERNAME, status: 'rejected' });
    check('editor2 rejects owner suggestion', r.status === 204, `status ${r.status}`);
    // ...and accepts their own (editor holds manage-suggestions).
    r = await api(e2Page, 'POST', `api/sentences/${encodeURIComponent(titleSid)}/suggestion/review`,
      { username: EDITOR2, status: 'accepted' });
    check('editor2 accepts own suggestion', r.status === 204, `status ${r.status}`);
    // v3.2: accepting is EXCLUSIVE per sentence — a second accept on the
    // same sentence (owner trying to accept their own) must 409.
    r = await api(ownerPage, 'POST', `api/sentences/${encodeURIComponent(titleSid)}/suggestion/review`,
      { username: TEST_USERNAME, status: 'accepted' });
    check('second accept on the same sentence is 409', r.status === 409, `status ${r.status}`);

    // Owner edits their rejected suggestion → review resets to unreviewed.
    r = await api(ownerPage, 'PUT', `api/sentences/${encodeURIComponent(titleSid)}/suggestion`,
      { text: '# MU Book (owner rewrite, v2)' });
    r = await api(ownerPage, 'GET', `api/migrations/${latest.migration_id}/suggestions`);
    const ownRow = r.json.suggestions.find(s => s.user_id === TEST_USERNAME);
    check('editing a reviewed suggestion resets its review', ownRow.review_status === null,
      String(ownRow.review_status));

    // accept-own-uncontested must SKIP the contested sentence.
    r = await api(ownerPage, 'POST', `api/migrations/${latest.migration_id}/accept-own-uncontested`);
    check('accept-own-uncontested skips contested sentences', r.json.accepted === 0, `accepted ${r.json.accepted}`);

    // ---- reader isolation ----------------------------------------------
    const r3Page = await loginAs(browser, READER3, 'test');
    r = await api(r3Page, 'GET', `api/migrations/${latest.migration_id}/suggestions`);
    check('reader sees NO others\' suggestions', r.json.suggestions.length === 0, `count ${r.json.suggestions.length}`);
    r = await api(r3Page, 'PUT', `api/sentences/${encodeURIComponent(titleSid)}/suggestion`,
      { text: '# MU Book (reader idea)' });
    check('reader CAN file their own suggestion', r.status === 200, `status ${r.status}`);
    r = await api(r3Page, 'POST', `api/sentences/${encodeURIComponent(titleSid)}/suggestion/review`,
      { username: EDITOR2, status: 'rejected' });
    check('reader cannot review others', r.status === 403, `status ${r.status}`);
    // v3.1: accepting changes the manuscript — even one's OWN suggestion
    // needs manage-suggestions.
    r = await api(r3Page, 'POST', `api/sentences/${encodeURIComponent(titleSid)}/suggestion/review`,
      { username: READER3, status: 'accepted' });
    check('reader cannot accept their OWN suggestion', r.status === 403, `status ${r.status}`);
    r = await api(r3Page, 'POST', `api/migrations/${latest.migration_id}/accept-own-uncontested`);
    check('reader cannot accept-own-uncontested', r.status === 403, `status ${r.status}`);
    r = await api(r3Page, 'PATCH', `api/manuscripts/${mid}/meta`, { word_goal: 1234 });
    check('reader cannot edit settings', r.status === 403, `status ${r.status}`);
    // Cleanup reader's suggestion so the editor2 push below is deterministic.
    await api(r3Page, 'DELETE', `api/sentences/${encodeURIComponent(titleSid)}/suggestion`);

    // Reader UI: outline/stats/people tabs and push button hidden.
    await r3Page.goto(`${BASE_URL}/?manuscript_id=${mid}`);
    await waitForPagination(r3Page);
    // applyBookPageGates polls for the session on a 250ms cadence — wait
    // for its visible effect, not just the session landing.
    await r3Page.waitForFunction(() =>
      document.querySelector('#pane-tabs .pane-tab[data-pane="outline"]').style.display === 'none',
      { timeout: 15000 });
    const gates = await r3Page.evaluate(() => ({
      outline: document.querySelector('#pane-tabs .pane-tab[data-pane="outline"]').style.display,
      stats: document.querySelector('#pane-tabs .pane-tab[data-pane="stats"]').style.display,
      people: document.querySelector('#pane-tabs .pane-tab[data-pane="people"]').style.display,
      gear: document.getElementById('mc-settings').style.display,
      push: document.getElementById('push-button-container').style.display,
    }));
    check('reader UI hides outline/stats/people/gear/push',
      gates.outline === 'none' && gates.stats === 'none' && gates.people === 'none'
      && gates.gear === 'none' && gates.push === 'none', JSON.stringify(gates));

    // ---- notes: visibility, manage-others, hide -------------------------
    r = await api(ownerPage, 'POST', 'api/notes',
      { sentence_id: titleSid, color: 'yellow', body: 'Owner note body' });
    check('owner creates a note', r.status === 201, `status ${r.status}`);
    const noteId = r.json.note_id;

    r = await api(e2Page, 'GET', `api/notes/sentence/${encodeURIComponent(titleSid)}`);
    check('editor2 sees the owner note (see-others-notes)',
      r.json.notes.some(n => n.note_id === noteId), `count ${r.json.notes.length}`);
    r = await api(e2Page, 'PUT', `api/notes/${noteId}`, { body: 'hacked' });
    check('editor2 cannot edit the note TEXT', r.status === 403, `status ${r.status}`);
    r = await api(e2Page, 'PUT', `api/notes/${noteId}`, { priority: 'must' });
    check('editor2 CAN retask/reprioritize (manage-others-notes)', r.status === 200, `status ${r.status}`);
    r = await api(e2Page, 'DELETE', `api/notes/${noteId}`);
    check('editor2 cannot delete the note', r.status === 403, `status ${r.status}`);
    r = await api(e2Page, 'POST', `api/notes/${noteId}/hide`);
    check('editor2 hides the note for themselves', r.status === 204, `status ${r.status}`);
    r = await api(e2Page, 'GET', `api/notes/sentence/${encodeURIComponent(titleSid)}`);
    check('hidden flag set for editor2', r.json.notes.find(n => n.note_id === noteId).hidden === true);
    r = await api(ownerPage, 'GET', `api/notes/sentence/${encodeURIComponent(titleSid)}`);
    check('owner never sees the hide', r.json.notes.find(n => n.note_id === noteId).hidden !== true);
    r = await api(r3Page, 'GET', `api/notes/sentence/${encodeURIComponent(titleSid)}`);
    check('reader sees no others\' notes', r.json.notes.length === 0, `count ${r.json.notes.length}`);

    // ---- push accepted-only + stale carry -------------------------------
    // editor2's accepted suggestion is the only accepted one → commit lands
    // it; the owner's unreviewed revision must survive the migration STALE.
    r = await api(e2Page, 'POST', `api/manuscripts/${mid}/migrations/${latest.migration_id}/push-suggestions`, {});
    check('editor2 commits all-accepted', r.status === 200, `status ${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);
    let latest2 = null;
    for (let i = 0; i < 30; i++) {
      const lr = await api(ownerPage, 'GET', `api/migrations/latest?manuscript_id=${mid}`);
      if (lr.status === 200 && lr.json.migration_id !== latest.migration_id) { latest2 = lr.json; break; }
      await new Promise(res => setTimeout(res, 500));
    }
    check('commit migrated to a new done migration', !!latest2);
    r = await api(ownerPage, 'GET', `api/migrations/${latest2.migration_id}/suggestions`);
    const carried = r.json.suggestions.find(s => s.user_id === TEST_USERNAME);
    check('owner\'s pending suggestion carried across the migration', !!carried);
    check('…and arrived STALE (its sentence text changed)', carried && carried.stale === true);

    // People endpoint shape.
    r = await api(ownerPage, 'GET', `api/manuscripts/${mid}/people`);
    check('people lists all three members', (r.json.members || []).length === 3, `members ${(r.json.members || []).length}`);
    check('people order non-empty', (r.json.order || []).length === 3);
  } finally {
    await browser.close();
    cleanup();
  }
  console.log(failed === 0 ? '\n✅ Test passed' : `\n❌ ${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(err => { console.error('Test crashed:', err); cleanup(); process.exit(1); });
