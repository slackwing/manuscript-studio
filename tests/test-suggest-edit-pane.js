/**
 * Suggest-edit modal on the SHARED edit pane (edit-pane.js) — end to end.
 *
 * Builds real history (three commits editing the first sentence), then checks:
 *   - AUTOSAVE-AS-YOU-TYPE: typed text hits the DB without closing the modal;
 *   - split panes: left editable (monospace .sn-text), right read-only version;
 *   - the right rail: * on top, then 0 (committed, default) and 1..3 history
 *     versions, DISABLED/greyed where the content didn't change at that hop;
 *   - clicking an enabled version shows that commit's text on the right;
 *   - Escape closes only after a successful flush; revert-to-original on close
 *     collapses the suggestion (no row left).
 */
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const {
  TEST_URL,
  TEST_MANUSCRIPT_NAME,
  TEST_USERNAME,
  API_BASE_URL,
  SYSTEM_TOKEN,
  cleanupTestAnnotations,
  loginAsTestUser,
  waitForPagination,
} = require('./test-utils');
const { suggestEditor } = require('./test-utils');

const REPO_PARENT = process.env.MANUSCRIPT_STUDIO_DEV_CONFIG_DIR
  || `${process.env.HOME}/.config/manuscript-studio-dev`;
const REPO_DIR = path.join(REPO_PARENT, 'repos', TEST_MANUSCRIPT_NAME);
const MANUSCRIPT_FILE = path.join(REPO_DIR, 'test.manuscript');

function git(...args) {
  return execSync(['git', '-C', REPO_DIR, '-c', 'user.email=test@example.com',
                   '-c', 'user.name=Test', ...args].join(' '),
                  { encoding: 'utf-8' });
}
function psql(sql) {
  return execSync(
    `PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`,
    { encoding: 'utf-8' }
  ).trim();
}
async function syncToHead() {
  const hash = git('rev-parse', 'HEAD').trim();
  const response = await fetch(`${API_BASE_URL}/admin/sync`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${SYSTEM_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ manuscript_name: TEST_MANUSCRIPT_NAME, commit_hash: hash }),
  });
  // 409 = this commit was already migrated (e.g. restoring to the initial
  // commit at teardown) — that's success for our purposes.
  if (response.status === 409) return;
  if (!response.ok) throw new Error(`sync ${response.status}: ${await response.text()}`);
  for (let i = 0; i < 80; i++) {
    await new Promise(r => setTimeout(r, 250));
    const status = psql(`SELECT status FROM migration WHERE commit_hash='${hash}' LIMIT 1`);
    if (status === 'done') return;
    if (status === 'error') throw new Error(`migration for ${hash} ended in error`);
  }
  throw new Error(`migration for ${hash} did not finish in 20s`);
}

(async () => {
  console.log('=== Suggest-edit shared pane e2e ===\n');
  await cleanupTestAnnotations();
  const initialCommit = git('rev-list', '--max-parents=0', 'HEAD').trim();
  git('reset', '--hard', initialCommit);
  const originalContent = fs.readFileSync(MANUSCRIPT_FILE, 'utf-8');

  let failed = false;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed = true; };

  let browser;
  try {
    // v1 == v2 (unchanged hop → hop 2 disabled), v3 differs.
    const lines = originalContent.split('\n');
    const firstProseIdx = lines.findIndex(l => l.trim() && !l.startsWith('#'));
    const versions = [
      'Version one of the pane test sentence.',
      'Version one of the pane test sentence.',   // unchanged commit
      'Version three of the pane test sentence.',  // current committed
    ];
    for (let i = 0; i < versions.length; i++) {
      const newLines = [...lines];
      newLines[firstProseIdx] = versions[i];
      fs.writeFileSync(MANUSCRIPT_FILE, newLines.join('\n'));
      git('add', '-A');
      git('commit', '-q', '--allow-empty', '-m', `"pane-test-v${i + 1}"`);
      await syncToHead();
    }

    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await loginAsTestUser(page);
    await page.goto(`${TEST_URL}/index.html`);
    await waitForPagination(page, 40000);

    const target = await page.evaluate((needle) => {
      const map = window.WriteSysRenderer.sentenceMap;
      for (const [id, text] of Object.entries(map)) {
        if (text.includes(needle)) return { id, text };
      }
      return null;
    }, 'Version three');
    check('found the sentence with history', !!target, target && target.id);

    // History-bars data loads async after render (pagedjs-config afterRendered
    // → WriteSysHistory.loadHistory); the modal's version rail needs it.
    await page.waitForFunction(
      (sid) => !!(window.WriteSysHistory && window.WriteSysHistory.bySentenceId
        && window.WriteSysHistory.bySentenceId[sid]),
      target.id,
      { timeout: 15000 }
    );

    await page.evaluate((sid) => window.WriteSysSuggestions.openModal(sid), target.id);
    await page.waitForSelector('#suggestion-modal');

    // Layout: shared monospace pane on the left, version pane on the right,
    // rail with * on top.
    const layout = await page.evaluate(() => {
      const m = document.querySelector('#suggestion-modal');
      // v3 added a LEFT user rail — this check targets the RIGHT (history) rail.
      const rail = [...m.querySelectorAll('.pw-rail-right .sn-rail-btn')].map(b => ({
        t: b.textContent.trim(), dis: b.disabled, cls: b.className,
      }));
      return {
        paneIsShared: !!m.querySelector('.sgm-left .sn-text-wrap textarea.sn-text.suggestion-modal-textarea'),
        rightPane: !!m.querySelector('.pw-content-right .suggestion-modal-original'),
        rail,
        mono: getComputedStyle(m.querySelector('.suggestion-modal-textarea')).fontFamily,
      };
    });
    check('left pane is the SHARED monospace component', layout.paneIsShared);
    check('right read-only pane present', layout.rightPane);
    check('monospace font in edit pane', /monaco|menlo|mono/i.test(layout.mono), layout.mono);
    // 2026-08-20: the corner * button is gone (meaning was opaque); the rail
    // is version numbers only.
    check('rail: 0..3 (no corner asterisk)', layout.rail.map(r => r.t).join(',') === '0,1,2,3', JSON.stringify(layout.rail.map(r => r.t)));
    const r = Object.fromEntries(layout.rail.map(x => [x.t, x]));
    check('version 1 enabled (changed: v3→v1-content... hop differs)', r['1'].dis === false, JSON.stringify(r['1']));
    check('version 2 disabled (unchanged commit)', r['2'].dis === true, JSON.stringify(r['2']));

    // Default right pane = 0 · committed.
    const v0 = await page.locator('.suggestion-modal-original').inputValue();
    check('right pane defaults to committed text', v0.includes('Version three'), JSON.stringify(v0.slice(0, 40)));

    // Click version 1 → previous commit's text.
    await page.locator('#suggestion-modal .sn-rail [data-ver="1"]').click();
    const v1 = await page.locator('.suggestion-modal-original').inputValue();
    check('version 1 shows the prior commit text', v1.includes('Version one'), JSON.stringify(v1.slice(0, 40)));
    const label = await page.locator('#suggestion-modal .pw-actionrow-right .pw-row-title').textContent();
    check('version label updates (single caption, no leading number)', /^1 commit ago$/.test(label.trim()), label);

    // AUTOSAVE AS YOU TYPE: no close, no button — the debounced PUT is the event.
    await (await suggestEditor(page)).click();
    await page.keyboard.press('End');
    const autosavePut = page.waitForResponse(
      (r) => r.request().method() === 'PUT'
        && r.url().includes(`/sentences/${encodeURIComponent(target.id)}/suggestion`)
        && r.ok(),
      { timeout: 15000 }
    );
    await page.keyboard.type(' Autosaved tail.');
    await autosavePut; // debounced autosave landed server-side
    // ...and the saver settled locally (status cleared after the await).
    await page.waitForFunction(() => {
      const el = document.querySelector('#suggestion-modal .sn-save');
      return el && el.textContent === '';
    }, null, { timeout: 10000 });
    const rows = psql(`SELECT text FROM suggested_change WHERE sentence_id='${target.id}' AND user_id='${TEST_USERNAME}'`);
    check('typed text AUTOSAVED without closing the modal', rows.includes('Autosaved tail.'), JSON.stringify(rows.slice(0, 60)));
    const status = await page.locator('#suggestion-modal .sn-save').textContent();
    check('save status settled (empty)', status === '', JSON.stringify(status));

    // Revert to original and close — suggestion collapses, no row left.
    await (await suggestEditor(page)).fill(target.text);
    await (await suggestEditor(page)).press('Escape');
    // Detach ⇒ close() already awaited the flush PUT — DB is settled.
    await page.waitForSelector('#suggestion-modal', { state: 'detached', timeout: 5000 });
    const left = psql(`SELECT COUNT(*) FROM suggested_change WHERE sentence_id='${target.id}' AND user_id='${TEST_USERNAME}'`);
    check('revert-and-close leaves no suggestion row', left === '0', left);
  } catch (e) {
    console.error('Test crashed:', e);
    failed = true;
  } finally {
    // Restore the repo to the initial commit + resync so later tests see the
    // canonical fixture.
    try {
      git('reset', '--hard', initialCommit);
      await syncToHead();
    } catch (e) { console.error('fixture restore failed:', e.message); }
    if (browser) await browser.close();
  }
  console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS');
  process.exit(failed ? 1 : 0);
})();
