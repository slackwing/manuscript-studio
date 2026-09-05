/**
 * FULL sketch lifecycle, through to the PUSHED FILE BYTES — the test that
 * would have caught the glued-anchor + paragraph-loss bugs (2026-08-16):
 *
 *   1. shift-select a range whose FIRST sentence starts a paragraph (\n\t)
 *      → sketch-from-selection (anchors as suggestions, variation A frozen);
 *   2. in the pad: branch A → B, type multi-paragraph replacement text;
 *   3. PLACE B (the real widget button → replacePlan suggestions);
 *   4. PUSH from the book page to a bare remote;
 *   5. assert the pushed .manuscript: opener and &end each on their OWN
 *      line, placed text present EXACTLY ONCE, paragraph marker preserved
 *      inside the region, original region text gone;
 *   6. push again → file unchanged (no anchor duplication from re-push).
 */
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const { TEST_URL, TEST_USERNAME, TEST_PASSWORD, TEST_MANUSCRIPT_NAME, loginAsTestUser, waitForPagination, cleanupTestNotes, resetTestManuscript, ensureWorkerUniquified } = require('./test-utils');

const psql = (sql) => execSync(
  `PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`,
  { encoding: 'utf-8' }).trim().split('\n')[0];

const REPO_DIR = path.join(os.homedir(), '.config/manuscript-studio-dev/repos', TEST_MANUSCRIPT_NAME);
// Since the git/[local,remote] layout (037), the server works in a CLONE of
// the fixture; pushed suggestion branches land back in the fixture repo
// itself (its origin). The old temp bare remote is gone: the fixture IS the
// remote to assert on, and rewinding it must nuke the server's clone so the
// next access re-clones instead of failing a non-ff pull.
const CHECKOUT_DIR = path.join(os.homedir(), '.config/manuscript-studio-dev/repos', 'git', 'remote', TEST_MANUSCRIPT_NAME);
const git = (args, cwd) => execSync(`git -C "${cwd || REPO_DIR}" ${args}`, { encoding: 'utf-8' }).trim();

function setupBareRemote() {
  const uniq = execSync(`git -C "${REPO_DIR}" log --format=%H --grep='worker fixture' -n 1`, { encoding: 'utf-8' }).trim();
  const initial = uniq || execSync(`git -C "${REPO_DIR}" log --reverse --format=%H | head -1`, { encoding: 'utf-8' }).trim();
  execSync(`git -C "${REPO_DIR}" reset --hard ${initial} 2>/dev/null`);
  execSync(`git -C "${REPO_DIR}" clean -fd 2>/dev/null`);
  // A rewind that lost the uniquify commit would collide this worker's
  // sentence IDs with worker 1's — put it back before anything syncs.
  ensureWorkerUniquified(REPO_DIR);
  execSync(`git -C "${REPO_DIR}" branch --list 'suggestions-*'`, { encoding: 'utf-8' })
    .split('\n').map(s => s.replace('*', '').trim()).filter(Boolean)
    .forEach(b => { try { git(`branch -D "${b}"`); } catch (_) {} });
  fs.rmSync(CHECKOUT_DIR, { recursive: true, force: true });
  return REPO_DIR;
}

(async () => {
  let failed = false;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed = true; };

  psql(`DELETE FROM suggested_change WHERE user_id='${TEST_USERNAME}'`);
  await cleanupTestNotes();
  const bareDir = setupBareRemote();
  // Rewound origin: re-sync so the DB base commit exists in a fresh clone.
  await resetTestManuscript();

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('dialog', async (d) => { console.log('[dialog]', d.message().slice(0, 80)); await d.accept(); });
  await loginAsTestUser(page);
  await page.goto(TEST_URL);
  await waitForPagination(page);

  // Range starting at a PARAGRAPH-START sentence (raw text begins \n\t).
  const range = await page.evaluate(() => {
    const map = window.WriteSysRenderer.sentenceMap;
    const ids = window.WriteSysRenderer.currentSentences.map(s => s.sentence_id || s.id);
    for (let i = 4; i < ids.length - 3; i++) {
      const el = document.querySelector(`.sentence[data-sentence-id="${ids[i]}"]`);
      if (el && !el.closest('h1,h2,h3') && (map[ids[i]] || '').startsWith('\n\t')
        && (map[ids[i]] || '').length > 40) {
        return { aId: ids[i], bId: ids[i + 2], firstRaw: map[ids[i]] };
      }
    }
    return null;
  });
  check('found a paragraph-start range', !!range, range && range.firstRaw.slice(0, 30));
  const origSketch = range.firstRaw.slice(2, 42); // distinctive original text

  await page.locator(`.sentence[data-sentence-id="${range.aId}"]`).first().click();
  // Range anchor is set synchronously by range-delete's click handler.
  await page.waitForFunction((id) => window.WriteSysRangeDelete
    && window.WriteSysRangeDelete.anchorId === id, range.aId, { timeout: 5000 });
  await page.locator(`.sentence[data-sentence-id="${range.bId}"]`).first().click({ modifiers: ['Shift'] });
  await page.waitForSelector('.range-trash.range-sketch', { timeout: 5000 });
  await page.locator('.range-trash.range-sketch').click();
  await page.waitForSelector('#sketch-sel-modal', { timeout: 5000 });
  await page.locator('#ssm-go').click();
  await page.waitForSelector('#sketch-sel-modal', { state: 'detached', timeout: 20000 });
  const slug = psql(`SELECT s.sketch_id FROM sketch s JOIN variation v ON v.sketch_id = s.sketch_id
    WHERE s.user_id='${TEST_USERNAME}' AND v.ordinal = 1 ORDER BY v.created_at DESC LIMIT 1`);
  check('sketch minted from selection', /^[a-z0-9]{6,}$/.test(slug), slug);
  // The modal can detach before the region-wrapping suggestion PUT lands;
  // placing against a book without the region alerts missing-anchor. Wait
  // for the suggestion row itself (server truth, no client timing).
  {
    let wrapped = '0';
    for (let i = 0; i < 50 && wrapped === '0'; i++) {
      wrapped = psql(`SELECT count(*) FROM suggested_change
        WHERE user_id='${TEST_USERNAME}' AND text LIKE '%&sketch#${slug}%'`).trim();
      if (wrapped === '0') await page.waitForTimeout(200);
    }
    check('region-wrapping suggestion landed', wrapped !== '0', wrapped);
  }

  // Open the sketch's home pad; branch A → B; type replacement; PLACE.
  const padId = await page.evaluate(async (s) =>
    (await (await fetch(`api/sketches/${s}/home`, { credentials: 'same-origin' })).json()).scratchpad_id, slug);
  check('home pad resolved', padId > 0, String(padId));
  await page.goto(new URL('home.html', TEST_URL).href);
  await page.evaluate((id) => window.WriteSysScratchpadModal.open(id), padId);
  await page.waitForSelector('.sn-widget .sn-branch', { timeout: 15000 });
  const widgetsBefore = await page.locator('.sn-widget').count();
  await page.locator('.sn-widget .sn-branch').first().click();
  await page.waitForFunction((n) => document.querySelectorAll('.sn-widget').length === n + 1, widgetsBefore, { timeout: 15000 });
  // New widget's ctx loaded: its draft preview renders as .sn-render.sn-clickable
  // (the frozen source widget's preview is .sn-frozen, so this pins the NEW one).
  await page.waitForFunction(() => {
    const ws = document.querySelectorAll('.sn-widget');
    return ws.length && ws[ws.length - 1].querySelector('.sn-render.sn-clickable');
  }, null, { timeout: 15000 });
  // Enter edit on the NEW widget (B) — click its preview.
  await page.locator('.sn-widget .sn-render.sn-clickable').last().click();
  await page.waitForSelector('.sn-widget textarea.sn-text', { timeout: 15000 });
  const ta = page.locator('.sn-widget textarea.sn-text').first();
  // Autosave lands as PUT api/variations/N; match the save carrying the FULL
  // typed text (an intermediate debounce save can't contain the last line).
  const saved1 = page.waitForResponse((r) => r.request().method() === 'PUT'
    && /\/api\/variations\/\d+$/.test(r.url()) && r.ok()
    && (r.request().postData() || '').includes('beta second paragraph'), { timeout: 15000 });
  await page.keyboard.press('Control+a');
  await page.keyboard.type('PLACEDMARK alpha paragraph replacing the original region text entirely.');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await page.keyboard.type('PLACEDMARK beta second paragraph keeping its indent marker.');
  await saved1; // autosave settled server-side
  // Place variation B (the widget button — real replacePlan path).
  // canonize is the LAST write of placeVariation (after all suggestion PUTs).
  const placeBtn = page.locator('.sn-widget .sn-place');
  const canonized1 = page.waitForResponse((r) => r.url().includes('/canonize') && r.ok(), { timeout: 30000 });
  await placeBtn.last().click();
  await canonized1; // suggestions PUT + canonize done
  const sugCount = psql(`SELECT count(*) FROM suggested_change WHERE user_id='${TEST_USERNAME}'`);
  check('placement wrote suggestions', parseInt(sugCount, 10) >= 2, sugCount);

  // Push from the book page.
  await page.goto(TEST_URL);
  await waitForPagination(page);
  // v3.3 button row: accept my uncontested (if pending), push own accepted.
  await page.waitForSelector('#accept-btn', { timeout: 15000 });
  if (!(await page.locator('#accept-btn[disabled]').count())) {
    await page.locator('#accept-btn').click();
  }
  await page.waitForFunction(() => {
    const el = document.getElementById('push-btn');
    return el && !el.disabled;
  }, null, { timeout: 15000 });
  // The push-suggestions POST returns only after the server-side git push
  // completed, so the branch is on the fixture remote once it resolves.
  const pushResp1 = page.waitForResponse((r) => r.url().includes('/push-suggestions') && r.ok(), { timeout: 30000 });
  await page.locator('#push-btn').click();
  await pushResp1;
  await page.waitForSelector('a#view-btn[href]', { timeout: 30000 });

  const readBranchFile = () => {
    const branch = execSync(`git -C "${bareDir}" branch --list 'suggestions-*' | head -1`, { encoding: 'utf-8' }).replace('*', '').trim();
    if (!branch) return null;
    const file = execSync(`git -C "${bareDir}" ls-tree --name-only ${branch} | grep manuscript$ | head -1`, { encoding: 'utf-8' }).trim();
    return { branch, text: execSync(`git -C "${bareDir}" show ${branch}:${file}`, { encoding: 'utf-8' }) };
  };
  const pushed = readBranchFile();
  check('push created a suggestions branch', !!pushed, pushed && pushed.branch);
  const f = pushed ? pushed.text : '';
  const count = (needle) => f.split(needle).length - 1;

  // Context dump for diagnosis: the opener line and its neighbors.
  {
    const i = f.indexOf(`&sketch#${slug}{}`);
    console.log('CONTEXT:', JSON.stringify(f.slice(Math.max(0, i - 80), i + 120)));
  }
  // THE assertions that would have caught the 2026-08-16 bugs:
  check('opener anchor on its OWN line (not glued to the previous paragraph)',
    new RegExp(`^&sketch#${slug}\\{\\}$`, 'm').test(f));
  check('&end anchor on its OWN line', new RegExp(`^&end#${slug}$`, 'm').test(f));
  check('opener appears exactly once', count(`&sketch#${slug}{}`) === 1, String(count(`&sketch#${slug}{}`)));
  check('&end appears exactly once', count(`&end#${slug}`) === 1, String(count(`&end#${slug}`)));
  check('placed text appears exactly once (no duplication)',
    count('PLACEDMARK alpha') === 1 && count('PLACEDMARK beta') === 1,
    `alpha=${count('PLACEDMARK alpha')} beta=${count('PLACEDMARK beta')}`);
  check('paragraph marker preserved inside the region (indented second para)',
    /\n\tPLACEDMARK beta/.test(f));
  check('first placed paragraph starts right after the opener line',
    new RegExp(`^&sketch#${slug}\\{\\}\\n\\t?PLACEDMARK alpha`, 'm').test(f));
  check('original region text replaced (gone from the file)',
    !f.includes(origSketch), origSketch.slice(0, 25));

  // Second push: force-push same branch — content must be IDENTICAL (no
  // anchor duplication from suggestions surviving a push).
  await page.waitForFunction(() => {
    const el = document.getElementById('push-btn');
    return el && !el.disabled;
  }, null, { timeout: 15000 });
  const pushResp2 = page.waitForResponse((r) => r.url().includes('/push-suggestions') && r.ok(), { timeout: 30000 });
  await page.locator('#push-btn').click();
  await pushResp2; // server-side force-push completed
  const pushed2 = readBranchFile();
  check('second push does not duplicate anchors',
    pushed2 && pushed2.text === f);

  // --- SMART RE-PLACE (place-plan endpoint): a ONE-WORD edit must yield a
  //     surgical per-sentence plan — no whole-region rewrite, no blanket
  //     deletes (the 2026-08-16 review-unreadability root cause). ---
  const sugsBefore = parseInt(psql(`SELECT count(*) FROM suggested_change WHERE user_id='${TEST_USERNAME}'`), 10);
  await page.goto(new URL('home.html', TEST_URL).href);
  await page.evaluate((id) => window.WriteSysScratchpadModal.open(id), padId);
  await page.waitForSelector('.sn-widget .sn-branch', { timeout: 15000 });
  const wBefore = await page.locator('.sn-widget').count();
  await page.locator('.sn-widget .sn-branch').last().click();
  await page.waitForFunction((n) => document.querySelectorAll('.sn-widget').length === n + 1, wBefore, { timeout: 15000 });
  // New (draft, clickable) widget's ctx loaded — same condition as above.
  await page.waitForFunction(() => {
    const ws = document.querySelectorAll('.sn-widget');
    return ws.length && ws[ws.length - 1].querySelector('.sn-render.sn-clickable');
  }, null, { timeout: 15000 });
  await page.locator('.sn-widget .sn-render.sn-clickable').last().click();
  await page.waitForSelector('.sn-widget textarea.sn-text', { timeout: 15000 });
  // The settled autosave must hold BOTH the edited first line and the last-typed
  // second line (an intermediate save could contain GLORIOUSLY alone).
  const saved2 = page.waitForResponse((r) => r.request().method() === 'PUT'
    && /\/api\/variations\/\d+$/.test(r.url()) && r.ok()
    && (r.request().postData() || '').includes('GLORIOUSLY')
    && (r.request().postData() || '').includes('indent marker'), { timeout: 15000 });
  await page.keyboard.press('Control+a');
  await page.keyboard.type('PLACEDMARK alpha paragraph replacing the original region text GLORIOUSLY.');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await page.keyboard.type('PLACEDMARK beta second paragraph keeping its indent marker.');
  await saved2; // autosave settled server-side
  const canonized2 = page.waitForResponse((r) => r.url().includes('/canonize') && r.ok(), { timeout: 30000 });
  await page.locator('.sn-widget .sn-place').last().click();
  await canonized2; // re-place plan applied + canonize done
  const sugsAfter = parseInt(psql(`SELECT count(*) FROM suggested_change WHERE user_id='${TEST_USERNAME}'`), 10);
  check('re-place adds NO blanket suggestions (surgical per-sentence plan)',
    sugsAfter <= sugsBefore + 1, `before=${sugsBefore} after=${sugsAfter}`);
  check('the one-word edit landed in a suggestion',
    psql(`SELECT count(*) FROM suggested_change WHERE user_id='${TEST_USERNAME}' AND text LIKE '%GLORIOUSLY%'`) === '1');
  check('no empty-delete artifacts from the re-place',
    psql(`SELECT count(*) FROM suggested_change sc JOIN sentence s ON s.sentence_id=sc.sentence_id WHERE sc.user_id='${TEST_USERNAME}' AND trim(sc.text)='' AND s.text LIKE '%PLACEDMARK%'`) === '0');

  // Cleanup.
  psql(`DELETE FROM suggested_change WHERE user_id='${TEST_USERNAME}'`);
  try { git('remote remove origin'); } catch (_) {}
  // bareDir IS the fixture repo now — never delete it; just drop the
  // pushed suggestion branches so the next run starts clean.
  execSync(`git -C "${REPO_DIR}" branch --list 'suggestions-*'`, { encoding: 'utf-8' })
    .split('\n').map(s => s.replace('*', '').trim()).filter(Boolean)
    .forEach(b => { try { git(`branch -D "${b}"`); } catch (_) {} });
  console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS');
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('Test crashed:', e); process.exit(1); });
