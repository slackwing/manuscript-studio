/**
 * Push-to-PR feature: end-to-end.
 *
 * Setup: add a bare-repo "remote" to the dev test manuscript so the handler
 * can actually `git push`. Without this, push would fail since the test repo
 * has no `origin`.
 *
 * Flow under test:
 *   1. Write a suggestion → button appears with "Push (1)".
 *   2. Click Push → POST /push-suggestions (no confirm dialog).
 *   3. Verify branch exists in the bare remote at the expected commit
 *      with the canonical suggestions-{shortSHA}-{user} name.
 *   4. Verify the file content on that branch reflects the suggestion.
 *   5. Click again → branch list unchanged (force-push reuses same name).
 *   6. After the first push, "View on GitHub" appears in the dropdown.
 *
 * Cleanup: remove the bare remote + clear suggestions.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const {
  TEST_URL,
  cleanupTestAnnotations, resetTestManuscript,
  loginAsTestUser,
  TEST_USERNAME, TEST_MANUSCRIPT_NAME,
} = require('./test-utils');
const { suggestEditor } = require('./test-utils');

function psql(sql) {
  return execSync(
    `PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`,
    { encoding: 'utf-8' }
  ).trim();
}

const REPO_DIR = path.join(os.homedir(), '.config/manuscript-studio-dev/repos', TEST_MANUSCRIPT_NAME);
// Since the git/[local,remote] layout (037): see test-sketch-place-push.js —
// the fixture repo IS the push remote; rewinds must nuke the server clone.
const CHECKOUT_DIR = path.join(os.homedir(), '.config/manuscript-studio-dev/repos', 'git', 'remote', TEST_MANUSCRIPT_NAME);

function git(args, cwd) {
  return execSync(`git -C "${cwd || REPO_DIR}" ${args}`, { encoding: 'utf-8' }).trim();
}

function setupBareRemote() {
  // Reset the test manuscript repo to its original commit. A previous test
  // run may have created additional commits (e.g. the .segman opt-in
  // commit later in this test). main must be at "Initial test manuscript"
  // so the assertions about base state hold.
  // Reset target: the worker-fixture uniquifying commit when present
  // (workers ≥2 — rewinding past it would collide sentence IDs with
  // worker 1's byte-identical history), else the true initial commit.
  const uniq = execSync(`git -C "${REPO_DIR}" log --format=%H --grep='worker fixture' -n 1`, { encoding: 'utf-8' }).trim();
  const initialCommit = uniq || execSync(`git -C "${REPO_DIR}" log --reverse --format=%H | head -1`, { encoding: 'utf-8' }).trim();
  execSync(`git -C "${REPO_DIR}" reset --hard ${initialCommit} 2>/dev/null`);
  execSync(`git -C "${REPO_DIR}" clean -fd 2>/dev/null`);

  // Clean up stray suggestions-* branches so the test starts from a known
  // state, and nuke the server's clone so it re-clones the rewound fixture.
  const localBranches = execSync(`git -C "${REPO_DIR}" branch --list 'suggestions-*'`, { encoding: 'utf-8' });
  localBranches.split('\n').map(s => s.replace('*', '').trim()).filter(Boolean).forEach(b => {
    try { git(`branch -D "${b}"`); } catch (_) {}
  });
  fs.rmSync(CHECKOUT_DIR, { recursive: true, force: true });
  return REPO_DIR;
}

function teardownBareRemote(bareDir) {
  // bareDir IS the fixture repo now — never delete it; just drop pushed
  // suggestion branches so the next run starts clean.
  try {
    const out = execSync(`git -C "${REPO_DIR}" branch --list 'suggestions-*'`, { encoding: 'utf-8' });
    out.split('\n').map(s => s.replace('*', '').trim()).filter(Boolean).forEach(b => {
      try { git(`branch -D "${b}"`); } catch (_) {}
    });
  } catch (_) {}
}

(async () => {
  console.log('=== Push-to-PR end-to-end ===\n');

  // Suggestions FK to sentence; wipe before annotation cleanup deletes sentences.
  psql(`DELETE FROM suggested_change WHERE user_id = '${TEST_USERNAME}'`);
  await cleanupTestAnnotations();

  // Get a fresh, predictable bare remote for this run.
  const bareDir = setupBareRemote();
  console.log(`[setup] fixture remote at ${bareDir}`);
  // The rewind moved origin behind the DB's latest migration; re-sync so the
  // push base commit is reachable from a fresh server clone.
  await resetTestManuscript();

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1400, height: 900 });
  page.on('console', msg => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      console.log(`[browser ${msg.type()}] ${msg.text()}`);
    }
  });
  page.on('pageerror', err => console.log(`[page error] ${err.message}`));

  // No dialogs are expected on the happy path. Accept any that arise
  // (failure alerts) so they don't deadlock the test, and surface them.
  page.on('dialog', async (d) => {
    console.log(`[unexpected dialog] ${d.message()}`);
    await d.accept();
  });

  let failed = false;
  function assert(cond, msg) {
    if (cond) console.log(`✓ ${msg}`);
    else { console.log(`✗ ${msg}`); failed = true; }
  }

  try {
    await loginAsTestUser(page);
    await page.goto(TEST_URL);
    await page.waitForSelector('.pagedjs_page', { timeout: 30000 });
    await page.waitForSelector('.sentence', { timeout: 10000 });
    await page.waitForTimeout(1500);

    // Write a suggestion via the in-page API (faster + deterministic than UI clicks).
    const target = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('.sentence[data-sentence-id]'));
      const longEnough = els.find(el => {
        const t = el.textContent.trim();
        return t.length > 30 && !t.startsWith('#');
      });
      if (!longEnough) return null;
      const map = window.WriteSysRenderer && window.WriteSysRenderer.sentenceMap;
      return {
        id: longEnough.dataset.sentenceId,
        text: (map && map[longEnough.dataset.sentenceId]) || longEnough.textContent,
      };
    });
    assert(!!target && !!target.id, `Found a prose sentence (${target && target.id.slice(0, 12)}...)`);

    const newText = target.text.replace(/\.$/, '') + ' (PUSHED EDIT).';
    await page.evaluate((sid) => window.WriteSysSuggestions.openModal(sid), target.id);
    await page.waitForSelector('#suggestion-modal');
    await (await suggestEditor(page)).fill(newText);
    await (await suggestEditor(page)).press('Escape');
    await page.waitForSelector('#suggestion-modal', { state: 'detached', timeout: 3000 });
    await page.waitForTimeout(500);

    // v3.3 button row: accept pair arms the push pair; View stays disabled
    // until a branch exists.
    // The row refreshes after the post-save repagination — wait on the
    // title, not the element.
    await page.waitForFunction(() => {
      const el = document.getElementById('accept-btn');
      return el && el.title === 'Accept my uncontested (0/1)';
    }, null, { timeout: 20000 });
    assert(true, 'Accept button reads "Accept my uncontested (0/1)"');
    assert(await page.locator('#view-btn[disabled]').count() === 1,
      'View disabled before any push');
    await page.locator('#accept-btn').click();
    await page.waitForFunction(() => {
      const el = document.getElementById('push-btn');
      return el && !el.disabled && el.title === 'Push own accepted (1)';
    }, null, { timeout: 10000 });

    // Click Push — no confirm, no alert on success. Success re-renders the
    // row with an enabled View link.
    await page.locator('#push-btn').click();
    await page.waitForSelector('a#view-btn[href]', { timeout: 15000 });
    assert(true, 'Push completed and View armed');

    // Verify the branch landed on the bare remote with the canonical name.
    const branches = execSync(`git -C "${bareDir}" branch --list`, { encoding: 'utf-8' });
    const suggestionsBranches = branches
      .split('\n')
      .map(s => s.replace('*', '').trim())
      .filter(b => b.startsWith('suggestions-'));
    assert(suggestionsBranches.length === 1, `Exactly one suggestions branch on remote (saw ${suggestionsBranches.length}: "${suggestionsBranches.join('|')}")`);
    const branch = suggestionsBranches[0];
    const expected = new RegExp(`^suggestions-[0-9a-f]{7}-${TEST_USERNAME}$`);
    assert(expected.test(branch),
      `Branch name matches suggestions-{sha7}-${TEST_USERNAME} (got "${branch}")`);
    const fileOnBranch = execSync(
      `git -C "${bareDir}" show ${branch}:test.manuscript`,
      { encoding: 'utf-8' }
    );
    assert(fileOnBranch.includes('PUSHED EDIT'),
      `Pushed branch contains the suggested edit`);

    // Second push: force-update, branch list unchanged. (Suggestions stay
    // accepted after a push, so the button is still armed.)
    await page.waitForFunction(() => {
      const el = document.getElementById('push-btn');
      return el && !el.disabled;
    }, null, { timeout: 10000 });
    await page.locator('#push-btn').click();
    await page.waitForFunction(() => {
      const el = document.getElementById('push-btn');
      return el && !el.disabled;
    }, null, { timeout: 15000 });
    const branchesAfter = execSync(`git -C "${bareDir}" branch --list 'suggestions-*'`, { encoding: 'utf-8' })
      .split('\n').map(s => s.replace('*', '').trim()).filter(Boolean);
    assert(branchesAfter.length === 1 && branchesAfter[0] === branch,
      `Second push reuses the same branch (saw "${branchesAfter.join('|')}")`);

    // View points at the canonical compare URL.
    const viewHref = await page.getAttribute('a#view-btn', 'href');
    assert(typeof viewHref === 'string' && viewHref.includes(`/compare/${branch}`),
      `View points at /compare/${branch} (got "${viewHref}")`);

    // Without a sibling .segman in the source tree, the pushed commit
    // should NOT include one — we don't presume on repos that don't use
    // the format. (The opt-in path — where a .segman exists at base and
    // gets refreshed alongside the .manuscript — is unit-tested in
    // internal/migrations: TestWriteCommitPushBranch_MultipleFiles +
    // TestPathExistsAtCommit. Reproducing end-to-end here would require
    // moving the test repo's HEAD between commits and re-bootstrapping,
    // which tangles with the dev server's local-clone state in flaky ways.)
    const filesOnBranch = execSync(`git -C "${bareDir}" ls-tree -r --name-only ${branch}`, { encoding: 'utf-8' });
    assert(!filesOnBranch.split('\n').some(p => p.endsWith('.segman')),
      `No .segman pushed when none exists at base (saw: ${filesOnBranch.split('\n').filter(Boolean).join(', ')})`);

  } catch (e) {
    console.log(`✗ Test errored: ${e.message}\n${e.stack}`);
    failed = true;
  } finally {
    await browser.close();
    teardownBareRemote(bareDir);
    psql(`DELETE FROM suggested_change WHERE user_id = '${TEST_USERNAME}'`);
    await cleanupTestAnnotations();
  }

  if (failed) {
    console.log('\n❌ Test failed');
    process.exit(1);
  }
  console.log('\n✅ Test passed');
})().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
