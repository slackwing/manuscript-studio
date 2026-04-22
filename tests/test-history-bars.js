/**
 * History bars (left margin) end-to-end test.
 *
 * Creates a fresh test repo with three commits' worth of edits, triggers
 * admin/sync between each commit, then loads the page and verifies:
 *   - left-margin .history-bar elements appear on edited sentences
 *   - hover shows the popup with prior versions
 *
 * The dev manuscript is large; we only need the FIRST sentence to have
 * history, so we edit a known prefix.
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const {
  TEST_URL,
  TEST_MANUSCRIPT_NAME,
  API_BASE_URL,
  SYSTEM_TOKEN,
  cleanupTestAnnotations,
  loginAsTestUser,
} = require('./test-utils');

const REPO_PARENT = process.env.MANUSCRIPT_STUDIO_DEV_CONFIG_DIR
  || `${process.env.HOME}/.config/manuscript-studio-dev`;
const REPO_DIR = path.join(REPO_PARENT, 'repos', TEST_MANUSCRIPT_NAME);
const MANUSCRIPT_FILE = path.join(REPO_DIR, 'test.manuscript');

function git(...args) {
  return execSync(['git', '-C', REPO_DIR, '-c', 'user.email=test@example.com',
                   '-c', 'user.name=Test', ...args].join(' '),
                  { encoding: 'utf-8' });
}

// Sync the explicit current HEAD hash (not the "HEAD" literal). The server's
// pending-row dedup is by literal commit string, so passing a real SHA avoids
// collisions with the cleanup helper's "HEAD" sync that may still be in flight.
async function syncToHead() {
  const hash = git('rev-parse', 'HEAD').trim();
  const response = await fetch(`${API_BASE_URL}/admin/sync`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SYSTEM_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ manuscript_name: TEST_MANUSCRIPT_NAME, commit_hash: hash }),
  });
  if (!response.ok) throw new Error(`sync ${response.status}: ${await response.text()}`);
  // Sync runs async; poll until the migration row for this hash hits 'done'.
  for (let i = 0; i < 80; i++) {
    await new Promise(r => setTimeout(r, 250));
    const status = execSync(
      `PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "SELECT status FROM migration WHERE commit_hash='${hash}' LIMIT 1"`,
      { encoding: 'utf-8' }
    ).trim();
    if (status === 'done') return;
    if (status === 'error') throw new Error(`migration for ${hash} ended in error`);
  }
  throw new Error(`migration for ${hash} did not finish in 20s`);
}

(async () => {
  console.log('=== History bars end-to-end ===\n');

  // Reset everything to a known state, then build commit history.
  await cleanupTestAnnotations();

  // Reset the repo back to the initial commit so test-history runs are
  // idempotent — otherwise leftover commits from a prior failed run cause
  // duplicate-hash conflicts on sync. cleanupTestAnnotations already
  // re-bootstrapped the initial commit, so we don't sync after the reset.
  const initialCommit = git('rev-list', '--max-parents=0', 'HEAD').trim();
  git('reset', '--hard', initialCommit);

  // Capture original content so we can restore at end.
  const originalContent = fs.readFileSync(MANUSCRIPT_FILE, 'utf-8');

  let failed = false;
  function assert(cond, msg) {
    if (cond) console.log(`✓ ${msg}`);
    else { console.log(`✗ ${msg}`); failed = true; }
  }

  let browser;
  try {
    // Edit the first sentence three times, syncing after each.
    // The original first sentence in test.manuscript starts with "It is a"
    // (per the wildfire opening). We'll just rewrite the very first paragraph.
    const lines = originalContent.split('\n');
    // Find the first non-blank, non-heading line (the first prose line).
    let firstProseIdx = lines.findIndex(l => l.trim() && !l.startsWith('#'));
    if (firstProseIdx < 0) throw new Error('could not find prose line');

    const versions = [
      // Each version: a small edit so the matcher pairs them.
      'A short tweaked first sentence.',
      'A short tweaked first sentence here.',
      'A slightly longer tweaked first sentence here today.',
    ];

    for (let i = 0; i < versions.length; i++) {
      const newLines = [...lines];
      newLines[firstProseIdx] = versions[i];
      fs.writeFileSync(MANUSCRIPT_FILE, newLines.join('\n'));
      git('add', '-A');
      git('commit', '-q', '-m', `"history-test-v${i + 1}"`);
      const head = git('rev-parse', '--short', 'HEAD').trim();
      console.log(`commit v${i + 1}: ${head}`);
      await syncToHead();
    }

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1400, height: 900 });

    await loginAsTestUser(page);
    await page.goto(TEST_URL);
    await page.waitForSelector('.pagedjs_page', { timeout: 30000 });
    await page.waitForSelector('.sentence', { timeout: 10000 });
    // Give history.js a moment to fetch + render.
    await page.waitForTimeout(2500);

    const totalBars = await page.locator('.history-bar').count();
    assert(totalBars > 0, `Some history bars rendered (got ${totalBars})`);

    // The bar lanes carry data-lane="1|2|3"; lane 1 must exist for the most
    // recently edited sentence.
    const lane1 = await page.locator('.history-bar[data-lane="1"]').count();
    assert(lane1 > 0, `At least one lane-1 bar (got ${lane1})`);

    // Hover the first container, expect popup with at least one row.
    const firstContainer = page.locator('.history-bar-container').first();
    await firstContainer.hover();
    await page.waitForSelector('#history-popup', { timeout: 3000 });
    const popupRows = await page.locator('#history-popup .history-popup-row').count();
    assert(popupRows >= 2, `Popup has >=2 rows (history + current) (got ${popupRows})`);
    const hasNow = await page.locator('#history-popup .history-popup-current').count();
    assert(hasNow === 1, `Popup includes current "now" row`);

    // Mouse out → popup gone.
    await page.mouse.move(0, 0);
    await page.waitForTimeout(300);
    const popupGone = await page.locator('#history-popup').count();
    assert(popupGone === 0, `Popup hides on mouseleave`);

  } catch (e) {
    console.log(`✗ Test errored: ${e.message}`);
    failed = true;
  } finally {
    if (browser) await browser.close();

    // Reset the repo back to the initial commit; cleanupTestAnnotations will
    // re-bootstrap it on the next test run.
    try {
      git('reset', '--hard', initialCommit);
    } catch (e) {
      console.warn('restore failed (continuing):', e.message);
    }
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
