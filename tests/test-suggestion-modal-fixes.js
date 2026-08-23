/**
 * Suggestion-modal robustness: raw variation-editor input + failed-save
 * preservation.
 *
 * Input: the pane edits RAW .manuscript text (shared edit-pane) — Enter and
 * Tab insert literal characters; the → overlay marks tabs. (Historical note:
 * length (2 chars → 1), but the old code subtracted the count of ALL
 * newlines before the caret, so after pressing Shift+Enter the caret
 * landed BEFORE the glyph and subsequent typing came out reversed
 * ("abc\n" + "def" → "abcdef¶" instead of "abc¶def").
 *
 * Bug 2 (failed save): save() used to close() the modal BEFORE the PUT
 * resolved, so a 500/409/network failure destroyed the user's typed text.
 * Now the modal must stay open (text intact) on failure; the
 * newText === current early-return still closes immediately without a PUT.
 */

const { execSync } = require('child_process');
const { chromium } = require('playwright');
const {
  TEST_URL,
  cleanupTestAnnotations,
  loginAsTestUser,
  waitForPagination, TEST_USERNAME,
} = require('./test-utils');

function psql(sql) {
  return execSync(
    `PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`,
    { encoding: 'utf-8' }
  ).trim();
}

(async () => {
  console.log('=== Suggestion modal: caret math + failed-save preservation ===\n');

  // Wipe leftover suggestions FIRST — cleanupTestAnnotations deletes
  // sentence rows and a lingering FK would block it.
  psql(`DELETE FROM suggested_change WHERE user_id = '${TEST_USERNAME}'`);
  await cleanupTestAnnotations();

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1400, height: 900 });

  let failed = false;
  function assert(cond, msg) {
    if (cond) console.log(`✓ ${msg}`);
    else { console.log(`✗ ${msg}`); failed = true; }
  }

  const alerts = [];
  page.on('dialog', async d => { alerts.push(d.message()); await d.accept(); });

  const putRequests = [];
  page.on('request', r => {
    if (r.method() === 'PUT' && r.url().includes('/suggestion')) putRequests.push(r.url());
  });

  try {
    await loginAsTestUser(page);
    await page.goto(TEST_URL);
    await page.waitForSelector('.pagedjs_page', { timeout: 30000 });
    await page.waitForSelector('.sentence', { timeout: 10000 });
    await waitForPagination(page);

    const first = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('.sentence[data-sentence-id]'));
      const el = els.find(e => {
        const t = e.textContent.trim();
        return t.length > 30 && !t.startsWith('#');
      });
      if (!el) return null;
      const map = window.WriteSysRenderer && window.WriteSysRenderer.sentenceMap;
      return {
        id: el.dataset.sentenceId,
        text: (map && map[el.dataset.sentenceId]) || el.textContent,
      };
    });
    assert(!!first && !!first.id, `Found a prose sentence (${first && first.id.slice(0, 12)}...)`);

    // ---- Raw variation-editor mode: newlines and tabs stay LITERAL ----
    // (The glyph conversion died with the old modal — the pane now edits raw
    // .manuscript text exactly like a sketch variation: Enter = \n, Tab = \t.)

    await page.evaluate((sid) => window.WriteSysSuggestions.openModal(sid), first.id);
    await page.waitForSelector('#suggestion-modal', { timeout: 3000 });
    const ta = page.locator('.suggestion-modal-textarea');

    await ta.fill('abc');
    await ta.press('Enter');
    await page.keyboard.type('def');
    const typed = await ta.inputValue();
    assert(typed === 'abc\ndef',
      `Enter inserts a REAL newline, caret follows (got ${JSON.stringify(typed)})`);
    await ta.press('Tab');
    const tabbed = await ta.inputValue();
    assert(tabbed === 'abc\ndef\t',
      `Tab inserts a literal \\t like the variation editor (got ${JSON.stringify(tabbed)})`);
    // The shared overlay renders the tab as a → marker.
    const overlayTabs = await page.evaluate(() =>
      document.querySelectorAll('#suggestion-modal .sn-text-overlay .sn-tab').length);
    assert(overlayTabs === 1, `Tab overlay glyph rendered (got ${overlayTabs})`);

    await ta.press('Escape');
    await page.waitForSelector('#suggestion-modal', { state: 'detached', timeout: 3000 });

    // ---- Bug 2: failed save keeps the modal (and text) open ----

    await page.route('**/api/sentences/*/suggestion', route => {
      if (route.request().method() === 'PUT') {
        return route.fulfill({ status: 500, body: 'boom' });
      }
      return route.continue();
    });

    await page.evaluate((sid) => window.WriteSysSuggestions.openModal(sid), first.id);
    await page.waitForSelector('#suggestion-modal', { timeout: 3000 });
    const survivorText = 'edited text that must survive a failed save';
    await page.locator('.suggestion-modal-textarea').fill(survivorText);
    await page.locator('.suggestion-modal-textarea').press('Escape');
    await page.waitForTimeout(500);

    const modalStillOpen = await page.locator('#suggestion-modal').count();
    assert(modalStillOpen === 1, 'Modal stays open after a 500 on PUT');
    const keptText = modalStillOpen === 1
      ? await page.locator('.suggestion-modal-textarea').inputValue()
      : '';
    assert(keptText === survivorText,
      `User's text is preserved in the modal (got "${keptText}")`);
    // Autosave pane: failures surface in the STATUS slot (retry ladder), not
    // a blocking alert — the modal quietly retries until it lands.
    const statusText = await page.locator('#suggestion-modal .sn-save').textContent();
    assert(/failed to save/i.test(statusText),
      `Retry-ladder status shown instead of an alert (got "${statusText}")`);
    assert(alerts.length === 0, `No blocking alert on a retryable failure (got ${JSON.stringify(alerts)})`);

    await page.unroute('**/api/sentences/*/suggestion');
    if (modalStillOpen === 1) {
      // Server reachable again: restore the ORIGINAL text so the flush-on-close
      // collapses the suggestion to none (autosave close always saves).
      await page.locator('.suggestion-modal-textarea').fill(first.text);
      await page.locator('.suggestion-modal-textarea').press('Escape');
      await page.waitForSelector('#suggestion-modal', { state: 'detached', timeout: 5000 });
    }

    const rows = psql(`SELECT COUNT(*) FROM suggested_change WHERE user_id='${TEST_USERNAME}'`);
    assert(rows === '0', `No suggestion row remains after revert-and-close (count: ${rows})`);

    // ---- newText === current still closes immediately, without a PUT ----

    const putsBefore = putRequests.length;
    await page.evaluate((sid) => window.WriteSysSuggestions.openModal(sid), first.id);
    await page.waitForSelector('#suggestion-modal', { timeout: 3000 });
    await page.locator('.suggestion-modal-textarea').press('Escape'); // unchanged text
    await page.waitForSelector('#suggestion-modal', { state: 'detached', timeout: 3000 });
    assert(true, 'Unchanged text closes the modal immediately');
    await page.waitForTimeout(500);
    assert(putRequests.length === putsBefore,
      `Unchanged text issues no PUT (got ${putRequests.length - putsBefore} extra)`);

    const assert2 = (n, ok, extra) => assert(ok, n + (extra ? ' — ' + extra : ''));
    // --- Pane-widget shell: title, rails, 0↔letter, revert, review icons ---
    await page.evaluate((sid) => window.WriteSysSuggestions.openModal(sid), first.id);
    await page.waitForSelector('#suggestion-modal', { timeout: 5000 });
    const title = () => page.evaluate(() => document.querySelector('#suggestion-modal .sn-status').textContent.trim());
    assert2('clean modal titles "Suggest edit"', /^Suggest edit$/i.test(await title()), await title());
    assert2('no corner asterisk button in the rail',
      await page.evaluate(() => !document.querySelector('#suggestion-modal .sn-rail-self')));
    assert2('left pane row titles "suggested edit"; no revert button while clean', await page.evaluate(() => {
      const t = document.querySelector('#suggestion-modal .pw-actionrow-left .pw-row-title');
      return t && t.textContent.trim() === 'suggested edit'
        && !document.querySelector('#suggestion-modal .sgm-revert');
    }));
    assert2('both panes carry rails on their right edges (shell geometry)', await page.evaluate(() => {
      const m = document.querySelector('#suggestion-modal');
      const railLast = (p) => p && p.lastElementChild && p.lastElementChild.classList.contains('sn-rail');
      return railLast(m.querySelector('.pw-left')) && railLast(m.querySelector('.pw-right'))
        && !m.querySelector('.pw-right').classList.contains('pw-collapsed');
    }));
    assert2('own rail button reads 0 while unchanged', await page.evaluate(() =>
      document.querySelector('#suggestion-modal .pw-rail-left .sn-rail-btn').textContent.trim() === '0'));
    assert2('no review icons while unchanged', await page.evaluate(() =>
      document.querySelectorAll('#suggestion-modal .pw-actionrow-left .pw-actbtn').length === 0));
    assert2('version caption single-numbered', await page.evaluate(() =>
      /^currently committed$/.test(document.querySelector('#suggestion-modal .pw-actionrow-right .pw-row-title').textContent.trim())));
    await page.locator('.suggestion-modal-textarea').fill(first.text + ' TITLETEST.');
    await page.locator('.suggestion-modal-textarea').dispatchEvent('input');
    await page.waitForTimeout(100);
    assert2('changed modal titles "Suggested edit", no title reject link', await page.evaluate(() => {
      const el = document.querySelector('#suggestion-modal .sn-status');
      return /Suggested edit/i.test(el.textContent) && !el.querySelector('a');
    }));
    assert2('own rail button swaps 0 → user letter on change', await page.evaluate(() =>
      document.querySelector('#suggestion-modal .pw-rail-left .sn-rail-btn').textContent.trim().startsWith('T')));
    assert2('revert ICON appears once changed, right of reject', await page.evaluate(() => {
      const btns = [...document.querySelectorAll('#suggestion-modal .pw-actionrow-left .pw-actbtn')];
      const i = btns.findIndex(b => b.classList.contains('sgm-revert'));
      const j = btns.findIndex(b => b.classList.contains('sgm-reject'));
      return i >= 0 && j >= 0 && i > j;
    }));
    assert2('Accept ✓ / Reject ✗ state icons appear on the left action row', await page.evaluate(() => {
      const btns = [...document.querySelectorAll('#suggestion-modal .pw-actionrow-left .pw-actbtn')];
      return btns.length >= 2 && btns[0].classList.contains('sgm-accept') && btns[1].classList.contains('sgm-reject')
        && btns[0].title === 'Accept' && btns[1].title === 'Reject';
    }));
    assert2('review icons are tinted at rest (green ✓ / red ✗ before hover)', await page.evaluate(() => {
      const [a, r] = document.querySelectorAll('#suggestion-modal .pw-actionrow-left .pw-actbtn');
      const c = (el) => getComputedStyle(el).color;
      return a.classList.contains('pw-tint') && r.classList.contains('pw-tint')
        && c(a) !== c(document.querySelector('#suggestion-modal .sn-save'));
    }));
    assert2('no "+ sentence after" link anywhere in the modal', await page.evaluate(() =>
      !document.querySelector('#suggestion-modal .sgm-insert-after')));
    // Nav appears once the autosaved suggestion lands in the model.
    await page.waitForFunction(() => {
      const nav = document.querySelector('#suggestion-modal .pw-nav');
      return nav && !nav.hidden && /^\d+\/\d+$/.test(nav.querySelector('.pw-nav-count').textContent.trim());
    }, null, { timeout: 8000 });
    assert2('nav flippers show i/n across suggested edits', true);
    // left-pane revert copies committed back in, modal stays open
    await page.locator('#suggestion-modal .sgm-revert').click();
    await page.waitForTimeout(150);
    assert2('revert restores committed text in the editor',
      (await page.locator('.suggestion-modal-textarea').inputValue()) === first.text);
    assert2('title returns to "Suggest edit" after revert', /^Suggest edit$/i.test(await title()), await title());
    assert2('modal still open after revert',
      (await page.locator('#suggestion-modal').count()) === 1);
    // Review own suggestion via the state icons: Accept → pressed + green,
    // rail letter tinted; re-click clears.
    await page.locator('.suggestion-modal-textarea').fill(first.text + ' ACCEPTME.');
    await page.locator('.suggestion-modal-textarea').dispatchEvent('input');
    await page.waitForTimeout(600);
    await page.locator('#suggestion-modal .pw-actionrow-left .sgm-accept').click();
    await page.waitForFunction(() =>
      document.querySelector('#suggestion-modal .pw-actionrow-left .sgm-accept.pw-on'), null, { timeout: 10000 });
    assert2('accepting own suggestion presses the ✓ state button', true);
    assert2('rail letter tinted by the accepted state', await page.evaluate(() =>
      document.querySelector('#suggestion-modal .pw-rail-left .sn-rail-btn').classList.contains('pw-colored')));
    let accRows = '0';
    for (let i = 0; i < 20; i++) {
      accRows = psql(`SELECT count(*) FROM suggested_change WHERE user_id = '${TEST_USERNAME}' AND review_status = 'accepted'`);
      if ((accRows.match(/^\s*(\d+)\s*$/m) || [])[1] === '1') break;
      await page.waitForTimeout(250);
    }
    assert2('own review persisted server-side',
      (accRows.match(/^\s*(\d+)\s*$/m) || [])[1] === '1', `rows=${accRows}`);
    // Collapse the right pane by re-clicking the selected version, then
    // reopen — the toggle policy in the shell.
    await page.locator('#suggestion-modal .pw-rail-right .sn-rail-btn[data-key="0"]').click();
    assert2('re-clicking 0 collapses the right pane', await page.evaluate(() =>
      document.querySelector('#suggestion-modal .pw-right').classList.contains('pw-collapsed')));
    await page.locator('#suggestion-modal .pw-rail-right .sn-rail-btn[data-key="0"]').click();
    assert2('clicking 0 again reopens it', await page.evaluate(() =>
      !document.querySelector('#suggestion-modal .pw-right').classList.contains('pw-collapsed')));
    // Revert (discard) empties the suggestion; close leaves no row.
    await page.locator('#suggestion-modal .sgm-revert').click();
    await page.waitForTimeout(400);
    await page.locator('.suggestion-modal-textarea').press('Escape');
    await page.waitForSelector('#suggestion-modal', { state: 'detached', timeout: 20000 });
    let rejRows = '1';
    for (let i = 0; i < 20; i++) {
      rejRows = psql(`SELECT count(*) FROM suggested_change WHERE user_id = '${TEST_USERNAME}'`);
      if ((rejRows.match(/^\s*(\d+)\s*$/m) || [])[1] === '0') break;
      await page.waitForTimeout(250);
    }
    assert2('revert + close leaves no suggestion row',
      (rejRows.match(/^\s*(\d+)\s*$/m) || [])[1] === '0', `rows=${rejRows}`);


  } catch (e) {
    console.log(`✗ Test errored: ${e.message}`);
    failed = true;
  } finally {
    await browser.close();
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
