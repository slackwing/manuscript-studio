// Manuscript lifecycle e2e (MANUSCRIPT_LIFECYCLE_PLAN Phases 1/2/5):
// ghost-card creation → local-mode book → insert menu → docx-import modal
// filing a composed suggestion → local Commit (commit + migrate + reload) →
// settings modal via the title gear. Worker-scoped names; cleans up after
// itself (row, grant, suggestion rows, on-disk repo).
const { chromium } = require('playwright');
const os = require('os');
const path = require('path');
const fs = require('fs');
const {
  BASE_URL, TEST_USERNAME, loginAsTestUser, waitForPagination, psql,
} = require('./test-utils');

const SLUG = `lifecycle-${TEST_USERNAME}-${Date.now()}`;
const TITLE = `Lifecycle Book ${TEST_USERNAME}`;
const LOCAL_REPO_DIR = path.join(os.homedir(), '.config', 'manuscript-studio-dev', 'repos', 'git', 'local', SLUG);

function cleanup() {
  try { psql(`DELETE FROM suggested_change WHERE sentence_id LIKE '${SLUG}-%';`); } catch (e) { /* none */ }
  try { psql(`DELETE FROM manuscript_access WHERE manuscript_name = '${SLUG}';`); } catch (e) { /* none */ }
  try { psql(`DELETE FROM manuscript WHERE name = '${SLUG}';`); } catch (e) { /* none */ }
  try { fs.rmSync(LOCAL_REPO_DIR, { recursive: true, force: true }); } catch (e) { /* none */ }
}

(async () => {
  console.log('=== manuscript lifecycle e2e ===\n');
  let failed = 0;
  const check = (name, ok, detail = '') => {
    console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` (${detail})` : ''}`);
    if (!ok) failed++;
  };

  cleanup(); // stale leftovers from a crashed run must not 409 the create

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('dialog', d => d.accept()); // batch-accept confirm
  try {
    await loginAsTestUser(page);

    // ---- Phase 1: ghost cards + creation modal --------------------------
    await page.goto(`${BASE_URL}/home.html`);
    await page.waitForSelector('.home-section');
    check('manuscript ghost card renders', !!(await page.$('.card-ghost[data-ghost="manuscript"]')));
    check('scratchpad ghost card renders', !!(await page.$('.card-ghost[data-ghost="scratchpad"]')));

    await page.click('.card-ghost[data-ghost="manuscript"]');
    await page.waitForSelector('#msm-overlay #msm-form');
    check('creation modal opens', true);
    await page.fill('#msm-overlay [name="display_name"]', TITLE);
    const derived = await page.$eval('#msm-overlay [name="name"]', el => el.value);
    check('slug derives from title', derived === `lifecycle-book-${TEST_USERNAME}`, derived);
    await page.fill('#msm-overlay [name="name"]', SLUG); // worker-scoped override
    await page.fill('#msm-overlay [name="word_goal"]', '50000');
    await Promise.all([
      page.waitForURL(/manuscript_id=\d+/, { timeout: 30000 }),
      page.click('#msm-overlay #msm-go'),
    ]);
    check('create navigates into the new book', true, page.url());

    // v3.2: the creator lands as ADMIN + AUTHOR — no self-granting needed
    // before working on the book.
    await waitForPagination(page);
    await page.waitForFunction(() => !!window.currentSession);
    const mid = parseInt(new URL(page.url()).searchParams.get('manuscript_id'), 10);
    const roles = await page.evaluate((mid) => {
      const m = (window.currentSession.accessible_manuscripts || []).find(x => x.manuscript_id === mid);
      return m ? m.roles : [];
    }, mid);
    check('creator holds admin + author out of the box',
      roles.includes('admin') && roles.includes('author'), roles.join(','));
    // The strip name lands via renderer's setName retry loop (waits for the
    // session bootstrap, up to ~5s) — poll for it rather than racing it.
    await page.waitForFunction(() =>
      (document.getElementById('mc-name') || {}).textContent.trim().length > 0,
      { timeout: 10000 }).catch(() => {});
    const title = await page.textContent('#mc-name');
    check('title strip shows the display name', title === TITLE, title);
    // v3.3: the seed is &title{...} — it must render as the H1 title page,
    // NOT as literal markdown.
    const seedTitle = await page.$eval('.pagedjs_page h1.cmd-title', (el) => {
      const c = el.cloneNode(true);
      c.querySelectorAll('.import-endzone').forEach(z => z.remove());
      return c.textContent.trim();
    });
    check('seeded &title renders as the title page', seedTitle === TITLE, seedTitle);

    // ---- Phase 5: end-zone + insert menu + docx modal -------------------
    await page.waitForSelector('.import-endzone .import-end-tab', { timeout: 15000 });
    check('end-of-book + renders on the last page', true);
    await page.click('.import-endzone .import-end-tab');
    await page.waitForSelector('#insert-menu');
    const menuItems = await page.$$eval('#insert-menu button', bs => bs.map(b => b.textContent));
    check('insert menu offers sketch, docx, chapter',
      menuItems.length === 3 && /docx/i.test(menuItems[1]) && /chapter/i.test(menuItems[2]), menuItems.join(' | '));
    await page.click('#insert-menu [data-act="docx"]');
    await page.waitForSelector('#import-docx-modal');
    check('docx import modal opens', true);

    // File conversion is covered by unit + vendored libs; here the preview
    // is filled directly (it is editable by design) to exercise the
    // compose-as-one-suggestion path.
    await page.fill('#idx-preview', '&chapter{Chapter 1}{The Test}\n\nFirst imported paragraph.\n\tSecond imported paragraph.');
    await page.click('#idx-go');
    await page.waitForSelector('#import-docx-overlay', { state: 'detached', timeout: 20000 });
    await waitForPagination(page);
    const sugCount = await page.evaluate(() => Object.keys((window.WriteSysSuggestions || {}).bySentenceId || {}).length);
    check('import filed exactly one composed suggestion', sugCount === 1, `count ${sugCount}`);

    // ---- v3.3 button row: accept pair then push/commit pair ------------
    await page.waitForFunction(() => {
      const el = document.getElementById('accept-btn');
      return el && el.title === 'Accept my uncontested (1)' && /0\/1/.test(el.textContent);
    }, { timeout: 20000 });
    check('accept button offers my uncontested (1)', true);
    const pushDisabled = await page.getAttribute('#push-btn', 'disabled');
    check('commit button disabled before any accept', pushDisabled !== null);
    await page.click('#accept-btn');
    await page.waitForFunction(() => {
      const el = document.getElementById('push-btn');
      return el && !el.disabled && el.title === 'Commit own accepted (1)';
    }, { timeout: 20000 });
    check('accepting arms Commit own accepted (1)', true);
    check('git commit glyph (not octocat) on local', !!(await page.$('#push-btn .mc-ic-commit')));
    check('no View button on local manuscripts', !(await page.$('#view-btn')));
    // 2026-08-25: accepted is the quiet default — NO ✓ superscript.
    check('accepted suggestion carries no ✓ marker', !(await page.$('sup.sg-review.accepted')));

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'load', timeout: 45000 }), // commit → migrate → reload
      page.click('#push-btn'),
    ]);
    await waitForPagination(page);
    const bodyText = await page.evaluate(() => document.body.innerText);
    check('imported chapter is committed prose', bodyText.includes('First imported paragraph.'), '');
    const sugAfter = await page.evaluate(() => Object.keys((window.WriteSysSuggestions || {}).bySentenceId || {}).length);
    check('suggestion consumed by the commit', sugAfter === 0, `count ${sugAfter}`);
    const commits = psql(`SELECT count(*) FROM migration m JOIN manuscript man ON man.manuscript_id = m.manuscript_id WHERE man.name = '${SLUG}' AND m.status = 'done';`);
    check('two done migrations (seed + commit)', /^\s*2\s*$/m.test(commits), commits.trim().split('\n')[2]);

    // ---- Phase 2: settings gear + modal --------------------------------
    await page.click('#mc-settings');
    await page.waitForSelector('#msm-overlay #msm-form');
    const roValues = await page.$$eval('#msm-overlay .msm-ro-value', els => els.map(e => e.textContent));
    check('settings shows read-only slug + storage', roValues.includes(SLUG) && roValues.some(v => /local/.test(v)), roValues.join(' | '));
    await page.fill('#msm-overlay [name="display_name"]', TITLE + ' II');
    await page.click('#msm-overlay #msm-go');
    await page.waitForSelector('#msm-overlay', { state: 'detached' });
    await page.waitForFunction(
      (want) => document.getElementById('mc-name') && document.getElementById('mc-name').textContent === want,
      TITLE + ' II', { timeout: 10000 }
    );
    check('title strip updates after settings save', true);

    // Stats pane shows the values but no longer offers inline editing.
    await page.click('.pane-tab[data-pane="stats"]');
    await page.waitForSelector('#stats-goal');
    const editable = await page.$('.stats-editable');
    check('stats pane has no inline editors', !editable);
    const goalText = await page.textContent('#stats-goal');
    check('word goal still displays', goalText === '50,000', goalText);
  } finally {
    await browser.close();
    cleanup();
  }
  console.log(failed === 0 ? '\n✅ Test passed' : `\n❌ ${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(err => { console.error('Test crashed:', err); cleanup(); process.exit(1); });
