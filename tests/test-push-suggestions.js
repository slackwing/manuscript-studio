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
  cleanupTestAnnotations,
  loginAsTestUser,
  TEST_USERNAME,
} = require('./test-utils');

function psql(sql) {
  return execSync(
    `PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`,
    { encoding: 'utf-8' }
  ).trim();
}

const REPO_DIR = path.join(os.homedir(), '.config/manuscript-studio-dev/repos/test-manuscripts');

function git(args, cwd) {
  return execSync(`git -C "${cwd || REPO_DIR}" ${args}`, { encoding: 'utf-8' }).trim();
}

function setupBareRemote() {
  const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-push-remote-'));
  execSync(`git init --bare -q -b main "${bareDir}"`);
  try { git(`remote remove origin`); } catch (_) {}
  git(`remote add origin "${bareDir}"`);
  git(`push -q origin main`);

  // Clean up stray suggestions-* branches in the local repo so the test starts
  // from a known state. Otherwise prior dev runs could pollute branch counts.
  const localBranches = execSync(`git -C "${REPO_DIR}" branch --list 'suggestions-*'`, { encoding: 'utf-8' });
  localBranches.split('\n').map(s => s.replace('*', '').trim()).filter(Boolean).forEach(b => {
    try { git(`branch -D "${b}"`); } catch (_) {}
  });
  return bareDir;
}

function teardownBareRemote(bareDir) {
  try { git(`remote remove origin`); } catch (_) {}
  // Nuke local suggestions-* branches so next run starts clean.
  try {
    const out = execSync(`git -C "${REPO_DIR}" branch --list 'suggestions-*'`, { encoding: 'utf-8' });
    out.split('\n').map(s => s.replace('*', '').trim()).filter(Boolean).forEach(b => {
      try { git(`branch -D "${b}"`); } catch (_) {}
    });
  } catch (_) {}
  if (bareDir && fs.existsSync(bareDir)) fs.rmSync(bareDir, { recursive: true, force: true });
}

(async () => {
  console.log('=== Push-to-PR end-to-end ===\n');

  // Suggestions FK to sentence; wipe before annotation cleanup deletes sentences.
  psql(`DELETE FROM suggested_change WHERE user_id = '${TEST_USERNAME}'`);
  await cleanupTestAnnotations();

  // Get a fresh, predictable bare remote for this run.
  const bareDir = setupBareRemote();
  console.log(`[setup] bare remote at ${bareDir}`);

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
    await page.locator('.suggestion-modal-textarea').fill(newText);
    await page.locator('.suggestion-modal-textarea').press('Enter');
    await page.waitForSelector('#suggestion-modal', { state: 'detached', timeout: 3000 });
    await page.waitForTimeout(500);

    // Push button should now show. Label is always "Push (N)" — no Push New.
    await page.waitForSelector('.push-btn-primary', { timeout: 3000 });
    const initialLabel = (await page.locator('.push-btn-primary .push-btn-label').textContent()).trim();
    assert(/^Push \(1\)$/.test(initialLabel),
      `Initial label is "Push (1)" (got "${initialLabel}")`);
    // No dropdown caret before any push (no branch yet → no View item).
    assert(await page.locator('.push-btn-caret').count() === 0,
      `No dropdown caret before first push`);

    // Click Push — no confirm, no alert on success.
    await page.locator('.push-btn-primary').click();
    // Wait for the spinner to come and go (busy class toggles).
    await page.waitForFunction(
      () => {
        const c = document.getElementById('push-button-container');
        // Spinner SVG class set during the request.
        return c && !c.classList.contains('push-busy');
      },
      null,
      { timeout: 10000 }
    );
    // After push, the dropdown caret should appear (View on GitHub item).
    await page.waitForSelector('.push-btn-caret', { timeout: 3000 });
    assert(true, 'Push completed and dropdown appears');

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

    // Second push: force-update, branch list unchanged.
    await page.locator('.push-btn-primary').click();
    await page.waitForFunction(
      () => {
        const c = document.getElementById('push-button-container');
        return c && !c.classList.contains('push-busy');
      },
      null,
      { timeout: 10000 }
    );
    const branchesAfter = execSync(`git -C "${bareDir}" branch --list 'suggestions-*'`, { encoding: 'utf-8' })
      .split('\n').map(s => s.replace('*', '').trim()).filter(Boolean);
    assert(branchesAfter.length === 1 && branchesAfter[0] === branch,
      `Second push reuses the same branch (saw "${branchesAfter.join('|')}")`);

    // View on GitHub menu item points at the canonical compare URL.
    await page.locator('.push-btn-caret').click();
    await page.waitForSelector('.push-menu:not([hidden])', { timeout: 2000 });
    const viewHref = await page.locator('.push-menu-item').getAttribute('href');
    assert(typeof viewHref === 'string' && viewHref.includes(`/compare/${branch}`),
      `View on GitHub points at /compare/${branch} (got "${viewHref}")`);

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
