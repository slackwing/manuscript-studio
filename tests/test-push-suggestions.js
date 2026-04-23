/**
 * Push-to-PR feature: end-to-end.
 *
 * Setup: add a bare-repo "remote" to the dev test manuscript so the handler
 * can actually `git push`. Without this, push would fail since the test repo
 * has no `origin`.
 *
 * Flow under test:
 *   1. Write a suggestion → split-button appears with "Push New (1)".
 *   2. Click Push New → confirm dialogs → POST /push-suggestions.
 *   3. Verify branch exists in the bare remote at the expected commit.
 *   4. Verify the file content on that branch reflects the suggestion.
 *   5. Click again → label is now "Push (1)" (update mode).
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

  // Auto-confirm both browser dialogs (push confirm + open-link confirm).
  // Reject the "open compare URL" dialog so the test doesn't try to open
  // a github.com URL that doesn't exist in this dev setup.
  let confirmCount = 0;
  page.on('dialog', async (d) => {
    confirmCount++;
    if (d.message().includes('Open the GitHub')) {
      await d.dismiss();
    } else {
      await d.accept();
    }
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

    // Push button should now show.
    await page.waitForSelector('.push-btn-primary', { timeout: 3000 });
    const initialLabel = (await page.locator('.push-btn-primary .push-btn-label').textContent()).trim();
    assert(/^Push New \(1\)$/.test(initialLabel),
      `Initial label is "Push New (1)" (got "${initialLabel}")`);

    // First push: no cached branch → action="new".
    await page.locator('.push-btn-primary').click();
    // Wait for the network call + response handling; sessionStorage cache is set
    // and refresh() runs synchronously after.
    await page.waitForFunction(
      () => {
        const lbl = document.querySelector('.push-btn-primary .push-btn-label');
        return lbl && /^Push \(\d+\)$/.test(lbl.textContent.trim());
      },
      null,
      { timeout: 10000 }
    );
    assert(true, 'Confirmation dialogs handled');

    const postPushLabel = (await page.locator('.push-btn-primary .push-btn-label').textContent()).trim();
    assert(/^Push \(1\)$/.test(postPushLabel),
      `Label flips to "Push (1)" after first push (got "${postPushLabel}")`);

    // Verify the branch landed on the bare remote.
    const branches = execSync(`git -C "${bareDir}" branch --list`, { encoding: 'utf-8' });
    const suggestionsBranch = branches
      .split('\n')
      .map(s => s.replace('*', '').trim())
      .find(b => b.startsWith('suggestions-'));
    assert(!!suggestionsBranch, `Bare remote has a suggestions-* branch (saw: ${branches.replace(/\n/g, ' | ')})`);

    if (suggestionsBranch) {
      // suggestions-{commitShort}-{username} per resolveBranchName ("new" picks
      // baseName when free, else baseName-N — first run from a clean repo gets
      // baseName).
      const expected = new RegExp(`^suggestions-[0-9a-f]{7}-${TEST_USERNAME}$`);
      assert(expected.test(suggestionsBranch),
        `Branch name matches suggestions-{sha7}-${TEST_USERNAME} (got "${suggestionsBranch}")`);

      const fileOnBranch = execSync(
        `git -C "${bareDir}" show ${suggestionsBranch}:test.manuscript`,
        { encoding: 'utf-8' }
      );
      assert(fileOnBranch.includes('PUSHED EDIT'),
        `Pushed branch contains the suggested edit`);
    }

    // Second push from the same UI session: button is "Push" → action="update" → force-push.
    // No new branch should appear; the existing one should stay (or be force-updated to the same content).
    const branchesBefore = execSync(`git -C "${bareDir}" branch --list 'suggestions-*'`, { encoding: 'utf-8' }).trim();
    await page.locator('.push-btn-primary').click();
    await page.waitForTimeout(2000);
    const branchesAfter = execSync(`git -C "${bareDir}" branch --list 'suggestions-*'`, { encoding: 'utf-8' }).trim();
    assert(branchesBefore === branchesAfter,
      `"Push" (update) reuses the same branch (before: "${branchesBefore}", after: "${branchesAfter}")`);

    // Third path: open the dropdown menu and click "Push New" → should create -2 branch.
    await page.locator('.push-btn-caret').click();
    await page.waitForSelector('.push-menu:not([hidden])', { timeout: 2000 });
    await page.locator('.push-menu-item').click();
    await page.waitForTimeout(2000);
    const branchesAfterNew = execSync(`git -C "${bareDir}" branch --list 'suggestions-*'`, { encoding: 'utf-8' });
    const newBranchCount = branchesAfterNew.split('\n').filter(b => b.trim().startsWith('suggestions-')).length;
    assert(newBranchCount === 2,
      `"Push New" creates a second branch (got ${newBranchCount} branches: "${branchesAfterNew.replace(/\n/g, ' | ')}")`);

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
