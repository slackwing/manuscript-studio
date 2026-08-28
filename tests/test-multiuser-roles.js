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
  try { psql(`DELETE FROM suggestion_review_event WHERE manuscript_id IN (SELECT manuscript_id FROM manuscript WHERE name = '${SLUG}');`); } catch (e) {}
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
      { text: '&title{MU Book (owner rewrite)}' });
    check('owner files a suggestion', r.status === 200, `status ${r.status}`);
    r = await api(e2Page, 'PUT', `api/sentences/${encodeURIComponent(titleSid)}/suggestion`,
      { text: '&title{MU Book: Editor2 Revised}' });
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
      { text: '&title{MU Book (owner rewrite, v2)}' });
    r = await api(ownerPage, 'GET', `api/migrations/${latest.migration_id}/suggestions`);
    const ownRow = r.json.suggestions.find(s => s.user_id === TEST_USERNAME);
    check('editing a reviewed suggestion resets its review', ownRow.review_status === null,
      String(ownRow.review_status));

    // accept-own-uncontested must SKIP the contested sentence.
    r = await api(ownerPage, 'POST', `api/migrations/${latest.migration_id}/accept-uncontested`, { scope: 'own' });
    check('accept-uncontested(own) skips contested sentences', r.json.accepted === 0, `accepted ${r.json.accepted}`);
    r = await api(ownerPage, 'POST', `api/migrations/${latest.migration_id}/accept-uncontested`, { scope: 'all' });
    check('accept-uncontested(all) also skips contested sentences', r.json.accepted === 0, `accepted ${r.json.accepted}`);

    // ---- suggested-edit history (040): verdicts logged with snapshots ---
    r = await api(ownerPage, 'GET', 'api/suggestion-history');
    check('owner can list suggestion history', r.status === 200, `status ${r.status}`);
    const evts = ((r.json && r.json.events) || []).filter(e => e.manuscript_id === mid);
    check('history holds the reject and the accept',
      evts.some(e => e.status === 'rejected' && e.owner_id === TEST_USERNAME && e.reviewer_id === EDITOR2)
      && evts.some(e => e.status === 'accepted' && e.owner_id === EDITOR2 && e.reviewer_id === EDITOR2),
      JSON.stringify(evts.map(e => [e.owner_id, e.status])));
    const rejEvt = evts.find(e => e.status === 'rejected' && e.owner_id === TEST_USERNAME);
    check('history snapshots the suggested text at verdict time',
      !!rejEvt && rejEvt.suggested_text === '&title{MU Book (owner rewrite)}',
      rejEvt && rejEvt.suggested_text);
    check('history snapshots the committed text',
      !!rejEvt && rejEvt.committed_text.includes('MU Book'), rejEvt && rejEvt.committed_text);
    check('history events carry the manuscript display name',
      !!rejEvt && typeof rejEvt.manuscript_name === 'string' && rejEvt.manuscript_name.length > 0,
      rejEvt && rejEvt.manuscript_name);

    // ---- reader isolation ----------------------------------------------
    const r3Page = await loginAs(browser, READER3, 'test');
    r = await api(r3Page, 'GET', `api/migrations/${latest.migration_id}/suggestions`);
    check('reader sees NO others\' suggestions', r.json.suggestions.length === 0, `count ${r.json.suggestions.length}`);
    r = await api(r3Page, 'PUT', `api/sentences/${encodeURIComponent(titleSid)}/suggestion`,
      { text: '&title{MU Book (reader idea)}' });
    check('reader CAN file their own suggestion', r.status === 200, `status ${r.status}`);
    r = await api(r3Page, 'POST', `api/sentences/${encodeURIComponent(titleSid)}/suggestion/review`,
      { username: EDITOR2, status: 'rejected' });
    check('reader cannot review others', r.status === 403, `status ${r.status}`);
    // v3.1: accepting changes the manuscript — even one's OWN suggestion
    // needs manage-suggestions.
    r = await api(r3Page, 'POST', `api/sentences/${encodeURIComponent(titleSid)}/suggestion/review`,
      { username: READER3, status: 'accepted' });
    check('reader cannot accept their OWN suggestion', r.status === 403, `status ${r.status}`);
    r = await api(r3Page, 'POST', `api/migrations/${latest.migration_id}/accept-uncontested`, { scope: 'own' });
    check('reader cannot batch-accept', r.status === 403, `status ${r.status}`);
    r = await api(r3Page, 'PATCH', `api/manuscripts/${mid}/meta`, { word_goal: 1234 });
    check('reader cannot edit settings', r.status === 403, `status ${r.status}`);
    r = await api(r3Page, 'GET', 'api/suggestion-history');
    check('reader sees NO history events on the manuscript (no see-others-edits)',
      r.status === 200 && ((r.json && r.json.events) || []).filter(e => e.manuscript_id === mid).length === 0,
      JSON.stringify(r.json && r.json.events));
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

    // ---- modal: revert/redo is OWNERSHIP-gated, review power or not ------
    await ownerPage.goto(`${BASE_URL}/?manuscript_id=${mid}`);
    await waitForPagination(ownerPage);
    await ownerPage.evaluate((sid) => window.WriteSysSuggestions.openModal(sid), titleSid);
    await ownerPage.waitForSelector('#suggestion-modal', { timeout: 5000 });
    const railTitles = await ownerPage.evaluate(() =>
      [...document.querySelectorAll('#suggestion-modal .pw-rail-left .sn-rail-btn')].map(b => b.title));
    check('owner modal rail lists editor2\'s suggestion',
      railTitles.some(t => t.startsWith(EDITOR2)), railTitles.join('|'));
    await ownerPage.evaluate((who) => {
      const btn = [...document.querySelectorAll('#suggestion-modal .pw-rail-left .sn-rail-btn')]
        .find(b => b.title.startsWith(who));
      btn.click();
    }, EDITOR2);
    await ownerPage.waitForTimeout(200);
    check('no revert/redo on another user\'s suggestion pane', await ownerPage.evaluate(() =>
      !document.querySelector('#suggestion-modal .sgm-revert')
      && !document.querySelector('#suggestion-modal .sgm-redo')));
    check('review icons still offered there (review power is separate)', await ownerPage.evaluate(() =>
      !!document.querySelector('#suggestion-modal .sgm-accept')
      && !!document.querySelector('#suggestion-modal .sgm-reject')));
    await ownerPage.keyboard.press('Escape');
    await ownerPage.waitForSelector('#suggestion-modal', { state: 'detached', timeout: 10000 });

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

    // ---- push gate + group settling (SUGGESTION_REVIEW_RULES.md) --------
    // titleSid still holds the owner's UNREVIEWED revision beside editor2's
    // accepted one → the sentence is not fully reviewed and must not push.
    r = await api(e2Page, 'POST', `api/manuscripts/${mid}/migrations/${latest.migration_id}/push-suggestions`, {});
    check('push refuses while a sibling edit is unreviewed', r.status === 400, `status ${r.status}`);

    // A pending suggestion on an untouched sentence must migrate as-is.
    const metaSid = manu.json.sentences[1].id;
    r = await api(ownerPage, 'PUT', `api/sentences/${encodeURIComponent(metaSid)}/suggestion`,
      { text: '&meta{chapter-align}{left}' });
    check('owner files a pending suggestion on another sentence', r.status === 200, `status ${r.status}`);

    // Reject the sibling → title fully reviewed → its accepted edit pushes.
    r = await api(e2Page, 'POST', `api/sentences/${encodeURIComponent(titleSid)}/suggestion/review`,
      { username: TEST_USERNAME, status: 'rejected' });
    check('editor2 rejects the sibling revision', r.status === 204, `status ${r.status}`);
    r = await api(e2Page, 'POST', `api/manuscripts/${mid}/migrations/${latest.migration_id}/push-suggestions`, {});
    check('fully-reviewed sentence commits', r.status === 200, `status ${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);
    let latest2 = null;
    for (let i = 0; i < 30; i++) {
      const lr = await api(ownerPage, 'GET', `api/migrations/latest?manuscript_id=${mid}`);
      if (lr.status === 200 && lr.json.migration_id !== latest.migration_id) { latest2 = lr.json; break; }
      await new Promise(res => setTimeout(res, 500));
    }
    check('commit migrated to a new done migration', !!latest2);
    r = await api(ownerPage, 'GET', `api/migrations/${latest2.migration_id}/suggestions`);
    // CONSUMMATION: the fully-reviewed title group (applied accepted +
    // rejected sibling) retires wholesale; the meta sentence's pending
    // suggestion carries FRESH (its sentence text never changed).
    const titleRows = r.json.suggestions.filter(s => s.text.startsWith('&title'));
    check('consummated title group fully retired', titleRows.length === 0,
      JSON.stringify(titleRows.map(x => [x.user_id, x.review_status])));
    const metaCarried = r.json.suggestions.find(
      s => s.user_id === TEST_USERNAME && s.text === '&meta{chapter-align}{left}');
    check('pending suggestion on an untouched sentence carries', !!metaCarried);
    check('…and stays FRESH (its sentence text is unchanged)', metaCarried && metaCarried.stale === false);

    // ---- unrelated external commit: broken acceptance --------------------
    // Accept the carried meta suggestion (sole row → fully reviewed), then
    // rewrite THAT sentence in the repo directly — the "unrelated deploy".
    // The acceptance no longer matches the new text: it must carry, reset
    // to unreviewed, arrive stale, and log an 'unaccepted' history event.
    const metaSid2 = metaCarried.sentence_id;
    r = await api(e2Page, 'POST', `api/sentences/${encodeURIComponent(metaSid2)}/suggestion/review`,
      { username: TEST_USERNAME, status: 'accepted' });
    check('editor2 accepts the carried suggestion', r.status === 204, `status ${r.status}`);

    const { execSync } = require('child_process');
    const mfile = fs.readdirSync(LOCAL_REPO_DIR).find(f => f.endsWith('.manuscript'));
    const mpath = path.join(LOCAL_REPO_DIR, mfile);
    fs.writeFileSync(mpath, fs.readFileSync(mpath, 'utf8')
      .replace('&meta{chapter-align}{center}', '&meta{chapter-align}{right}'));
    execSync(`git -C "${LOCAL_REPO_DIR}" -c user.email=t@e.com -c user.name=T commit -am "external edit"`);
    const extHash = execSync(`git -C "${LOCAL_REPO_DIR}" rev-parse HEAD`, { encoding: 'utf8' }).trim();
    const sync = await fetch(`${API_BASE_URL}/admin/sync`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SYSTEM_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ manuscript_name: SLUG, commit_hash: extHash }),
    });
    check('external commit syncs', sync.ok, `status ${sync.status}`);
    let latest3 = null;
    for (let i = 0; i < 40; i++) {
      const lr = await api(ownerPage, 'GET', `api/migrations/latest?manuscript_id=${mid}`);
      if (lr.status === 200 && lr.json.commit_hash === extHash) { latest3 = lr.json; break; }
      await new Promise(res => setTimeout(res, 500));
    }
    check('external commit migrated', !!latest3);
    r = await api(ownerPage, 'GET', `api/migrations/${latest3.migration_id}/suggestions`);
    const broken = r.json.suggestions.find(
      s => s.user_id === TEST_USERNAME && s.text === '&meta{chapter-align}{left}');
    check('broken acceptance carries across the external migration', !!broken);
    check('…reset to UNREVIEWED', broken && broken.review_status === null,
      broken && String(broken.review_status));
    check('…and arrived STALE (its sentence text changed)', broken && broken.stale === true);
    r = await api(ownerPage, 'GET', 'api/suggestion-history');
    const unacc = ((r.json && r.json.events) || []).filter(e => e.manuscript_id === mid && e.status === 'unaccepted');
    check('history logs the unaccepted event (reviewer: migration)',
      unacc.length === 1 && unacc[0].reviewer_id === 'migration'
      && unacc[0].suggested_text === '&meta{chapter-align}{left}',
      JSON.stringify(unacc.map(e => [e.reviewer_id, e.suggested_text])));

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
