/**
 * Write-forwarding (2026-10-19): a tab loaded BEFORE a commit keeps working.
 * Its suggestion writes name sentences of the old migration; the server
 * forwards them along previous_sentence_id to the counterpart in the newest
 * migration instead of orphaning them (or, once the new one was done,
 * refusing with 409 "blocked until you reload"):
 *   - unchanged sentence → lands on its counterpart, base = the old text;
 *   - sentence the commit CHANGED → lands too, but stale (no push until
 *     looked at), base = the old text (the NEW badge);
 *   - sentence the commit DELETED → 409 stale (nothing to land on);
 *   - review / delete forward the same way;
 *   - while a migration is RUNNING, a write waits for it (its carry-forward
 *     copies suggestions mid-run — a write behind it was orphaned).
 * And the Reload banner keeps your place: ?scroll_to= names the sentence
 * you were on, forwarded to its new id after the reload.
 */
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const {
  TEST_URL, TEST_MANUSCRIPT_NAME, TEST_MANUSCRIPT_ID, TEST_USERNAME, API_BASE_URL, SYSTEM_TOKEN,
  cleanupTestAnnotations, resetTestManuscript, loginAsTestUser, waitForPagination,
} = require('./test-utils');

const REPO_PARENT = process.env.MANUSCRIPT_STUDIO_DEV_CONFIG_DIR || `${process.env.HOME}/.config/manuscript-studio-dev`;
const REPO_DIR = path.join(REPO_PARENT, 'repos', TEST_MANUSCRIPT_NAME);
const MANUSCRIPT_FILE = path.join(REPO_DIR, 'test.manuscript');
const git = (...args) => execSync(['git', '-C', REPO_DIR, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', ...args].join(' '), { encoding: 'utf-8' });
const psql = (sql) => execSync(`PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`, { encoding: 'utf8' }).trim();

async function syncToHead() {
  const hash = git('rev-parse', 'HEAD').trim();
  const r = await fetch(`${API_BASE_URL}/admin/sync`, {
    method: 'POST', headers: { Authorization: `Bearer ${SYSTEM_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ manuscript_name: TEST_MANUSCRIPT_NAME, commit_hash: hash }),
  });
  if (!r.ok) throw new Error(`sync ${r.status}`);
  for (let i = 0; i < 120; i++) {
    await new Promise((res) => setTimeout(res, 250));
    const st = psql(`SELECT status FROM migration WHERE commit_hash='${hash}' ORDER BY migration_id DESC LIMIT 1`);
    if (st === 'done') return parseInt(psql(`SELECT migration_id FROM migration WHERE commit_hash='${hash}' ORDER BY migration_id DESC LIMIT 1`), 10);
    if (st === 'error') throw new Error('migration errored');
  }
  throw new Error('migration did not finish');
}

const S_TEXT = 'And something we can all relate to is, ultimately, forgivable—forgivable and forgiven.';
const T_OLD = 'Ah well, who in their 30s can\'t relate?';
const T_NEW = 'Ah well, who in their thirties can\'t relate?';
const D_TEXT = 'So let me just start with the one that\'s knocking now.';

(async () => {
  console.log('=== Write-forwarding ===\n');
  let failed = false;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed = true; };
  await cleanupTestAnnotations();
  const initialCommit = git('rev-list', '--max-parents=0', 'HEAD').trim();
  git('reset', '--hard', initialCommit);
  const original = fs.readFileSync(MANUSCRIPT_FILE, 'utf-8');
  const browser = await chromium.launch({ headless: true });
  let fakeMig = null;
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await loginAsTestUser(page);
    await page.goto(TEST_URL);
    await waitForPagination(page);
    const oldMig = await page.evaluate(() => window.WriteSysRenderer.currentMigrationID);
    const idFor = (mig, text) => psql(`SELECT sentence_id FROM sentence WHERE migration_id=${mig} AND btrim(text, E' \\n\\t')='${text.replace(/'/g, "''")}'`);
    const S = idFor(oldMig, S_TEXT), T = idFor(oldMig, T_OLD), D = idFor(oldMig, D_TEXT);
    check('fixture sentences found on the old migration', S && T && D, JSON.stringify({ S, T, D }));

    // ---- the commit: T changes, D goes, S stays ----------------------------
    let next = original.replace(T_OLD, T_NEW).replace('\t' + D_TEXT + '\n', '');
    check('the commit changes T and drops D', next !== original && !next.includes(D_TEXT) && next.includes(T_NEW));
    fs.writeFileSync(MANUSCRIPT_FILE, next);
    git('add', '-A');
    git('commit', '-q', '-m', '"forwarding-test"');
    const newMig = await syncToHead();
    const S2 = idFor(newMig, S_TEXT), T2 = idFor(newMig, T_NEW);
    check('new migration done; S and T have counterparts', newMig > oldMig && S2 && T2, JSON.stringify({ newMig, S2, T2 }));
    check('the page is still on the OLD migration (a stale tab)', (await page.evaluate(() => window.WriteSysRenderer.currentMigrationID)) === oldMig);

    const csrf = await page.evaluate(() => localStorage.getItem('csrf_token') || sessionStorage.getItem('csrf_token') || '');
    const put = (id, text) => page.evaluate(async ({ id, text, csrf }) => {
      const r = await fetch(`api/sentences/${encodeURIComponent(id)}/suggestion`, {
        method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ text }),
      });
      return { status: r.status, body: r.status === 200 ? await r.json() : null };
    }, { id, text, csrf });
    const row = (id) => psql(`SELECT text || '|' || stale || '|' || coalesce(base_text,'') || '|' || coalesce(review_status,'') FROM suggested_change WHERE sentence_id='${id}' AND user_id='${TEST_USERNAME}'`);

    // ---- forwarded writes ---------------------------------------------------------
    const sEdit = 'And something we can all relate to is, in the end, forgivable—forgivable and forgiven.';
    let r = await put(S, sEdit);
    check('a write to an unchanged sentence of the old version → 200, forwarded', r.status === 200 && r.body.sentence_id === S2, JSON.stringify(r).slice(0, 120));
    check('…lands on its counterpart: not stale, base = what you saw', row(S2) === `${sEdit}|false|${S_TEXT}|`, row(S2));
    check('…nothing left on the old sentence', row(S) === '');
    const tEdit = 'Ah well, who in their 30s can\'t relate, honestly?';
    r = await put(T, tEdit);
    check('a write to a sentence the commit CHANGED → forwarded too', r.status === 200 && r.body.sentence_id === T2, JSON.stringify(r).slice(0, 120));
    // (base_text is the RAW sentence row — its paragraph lead included.)
    check('…but held for a look: stale, base = the old text', row(T2).startsWith(`${tEdit}|true|`) && row(T2).endsWith(`${T_OLD}|`), row(T2));
    r = await put(D, 'Gone anyway.');
    check('a write to a sentence the commit DELETED → 409 stale', r.status === 409);
    const review = await page.evaluate(async ({ id, u, csrf }) => (await fetch(`api/sentences/${encodeURIComponent(id)}/suggestion/review`, {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ username: u, status: 'accepted' }),
    })).status, { id: S, u: TEST_USERNAME, csrf });
    check('review on the old id forwards (accepts the counterpart\'s suggestion)', review === 204 && row(S2).endsWith('|accepted'), row(S2));
    const cur = await page.evaluate(async (id) => (await fetch(`api/sentences/${encodeURIComponent(id)}/current`, { credentials: 'same-origin' })).json(), S);
    check('GET /sentences/{old}/current → the new id', cur.sentence_id === S2, JSON.stringify(cur));
    const del = await page.evaluate(async ({ id, csrf }) => (await fetch(`api/sentences/${encodeURIComponent(id)}/suggestion`, {
      method: 'DELETE', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrf } })).status, { id: T, csrf });
    check('delete on the old id forwards', del === 204 && row(T2) === '');

    // ---- a running migration holds writes until it's done ------------------
    fakeMig = psql(`INSERT INTO migration (manuscript_id, commit_hash, status, processed_at, started_at)
                    VALUES (${TEST_MANUSCRIPT_ID}, 'f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0', 'running', now(), now()) RETURNING migration_id`).split('\n')[0];
    const t0 = Date.now();
    const pending = put(S2, 'Held while migrating.');
    // Still pending 1.2s later = held (a race, not a sleep: the assertion
    // IS that nothing resolves in the window).
    const raced = await Promise.race([pending.then(() => 'landed'), new Promise((res) => setTimeout(() => res('held'), 1200))]);
    check('while a migration runs, the write waits', raced === 'held' && row(S2).startsWith(sEdit), `${raced} ${row(S2)}`);
    psql(`UPDATE migration SET status='error' WHERE migration_id=${fakeMig}`);
    r = await pending;
    check('…and lands once it ends', r.status === 200 && row(S2).startsWith('Held while migrating.|') && Date.now() - t0 >= 1200, `${r.status} ${row(S2)}`);
    psql(`DELETE FROM migration WHERE migration_id=${fakeMig}`);
    fakeMig = null;

    // ---- the Reload banner keeps your place --------------------------------
    await page.evaluate(() => window.WriteSysRenderer.checkForNewerMigration());
    await page.waitForSelector('#stale-migration-banner');
    const text = await page.locator('.stale-migration-text').textContent();
    check('banner no longer says edits are blocked', !/blocked/i.test(text), text);
    await page.locator(`.pagedjs_pages .sentence[data-sentence-id="${S}"]`).first().click();
    await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.click('.stale-migration-reload')]);
    await waitForPagination(page);
    await page.waitForFunction((id) => new URLSearchParams(location.search).get('scroll_to') === id, S2, { timeout: 10000 })
      .catch(() => {});
    const after = await page.evaluate((id) => {
      const el = document.querySelector(`.sentence[data-sentence-id="${id}"]`);
      const rr = el && el.getBoundingClientRect();
      return { mig: window.WriteSysRenderer.currentMigrationID, url: new URLSearchParams(location.search).get('scroll_to'),
        selected: !!el && el.classList.contains('selected'), inView: !!rr && rr.top >= 0 && rr.bottom <= window.innerHeight };
    }, S2);
    check('Reload lands on the new version, on the sentence you were on (forwarded id, selected, in view)',
      after.mig === newMig && after.url === S2 && after.selected && after.inView, JSON.stringify(after));
  } catch (e) {
    check('run', false, e.message);
  } finally {
    if (fakeMig) psql(`DELETE FROM migration WHERE migration_id=${fakeMig}`);
    try { git('reset', '--hard', initialCommit); } catch (e) { /* continue */ }
    await resetTestManuscript();
    await browser.close();
  }
  console.log(failed ? '\n❌ some checks failed' : '\n✅ all passed');
  process.exit(failed ? 1 : 0);
})();
