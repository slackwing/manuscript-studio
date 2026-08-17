/**
 * Range-delete e2e EXTENSIONS — CODE_REVIEW_AUG_2026.md AREA 3 §3.4:
 *   D1 selection is order-independent (B then shift-A == A then shift-B);
 *      unknown ids no-op
 *   D2 shift-MOUSEDOWN swallows the native browser selection
 *   D3 exit paths: Escape / empty-area click / plain sentence click
 *      re-anchors / trash click stays in mode
 *   D4 trash two-click: arm → 2s auto-disarm → re-arm → apply
 *   D5 mid-range PUT failure: alert, mode exits, earlier PUTs stand,
 *      later ids untouched, refetch + re-render still run
 *   D6 trash geometry correct under mobile transform: scale
 *
 * The happy path (shift-click select → arm → apply → empty suggestions +
 * strikethrough) already lives in tests/test-range-delete.js — NOT
 * duplicated here.
 */
const { execSync } = require('child_process');
const { chromium } = require('playwright');
const {
  BASE_URL, TEST_URL, TEST_USERNAME, TEST_PASSWORD,
  waitForPagination, paginationStamp, waitForRepagination,
} = require('./test-utils');

const psql = (sql) => execSync(
  `PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`,
  { encoding: 'utf-8' }).trim();

(async () => {
  console.log('=== Range-delete e2e extensions (D1–D6) ===\n');
  psql(`DELETE FROM suggested_change WHERE user_id='${TEST_USERNAME}'`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  let failed = false;
  const check = (n, ok, extra) => {
    console.log(`${ok ? '✅' : '❌'} ${n}${extra !== undefined ? ' — ' + extra : ''}`);
    if (!ok) failed = true;
  };
  const dialogs = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); d.accept().catch(() => {}); });

  const modeState = () => page.evaluate(() => ({
    selected: [...new Set([...document.querySelectorAll('.sentence.range-selected')]
      .map((e) => e.dataset.sentenceId))],
    modeOn: document.body.classList.contains('range-delete-mode'),
    trash: document.querySelectorAll('.range-trash:not(.range-sketch)').length,
  }));
  const clickSentence = async (id, modifiers) => {
    // A PLAIN click on the currently-selected sentence would open the
    // suggest-edit modal (renderer re-click behavior — covered elsewhere)
    // and swallow the rest of the test. Clear the selection first so every
    // plain click here is a fresh anchor click.
    if (!modifiers) {
      await page.evaluate(() => {
        window.WriteSysRenderer.currentSelectedSentenceId = null;
        document.querySelectorAll('.sentence.selected').forEach((el) => el.classList.remove('selected'));
      });
    }
    await page.locator(`.sentence[data-sentence-id="${id}"]`).first()
      .click(modifiers ? { modifiers } : {});
  };

  try {
    await page.goto(`${BASE_URL}/login.html`);
    await page.evaluate(async ([u, p]) => {
      const r = await fetch('api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify({ username: u, password: p }),
      });
      const d = await r.json();
      localStorage.setItem('csrf_token', d.csrf_token);
    }, [TEST_USERNAME, TEST_PASSWORD]);
    await page.goto(TEST_URL);
    await waitForPagination(page);

    // Prose sentences on the FIRST page (stable geometry, no cross-page
    // ambiguity for the range checks that follow).
    const picks = await page.evaluate(() => {
      const ids = window.WriteSysRenderer.currentSentences.map((s) => s.sentence_id || s.id);
      const firstPage = document.querySelector('.pagedjs_page');
      const spans = [...firstPage.querySelectorAll('.sentence[data-sentence-id]')]
        .filter((s) => s.textContent.trim().length > 30 && !s.closest('h1,h2,h3'));
      const pick = (i) => spans[i] && spans[i].dataset.sentenceId;
      const between = (aId, bId) => ids.slice(ids.indexOf(aId), ids.indexOf(bId) + 1);
      return {
        a: pick(1), b: pick(5), c: pick(3), d: pick(7),
        ab: between(pick(1), pick(5)),
        cd: between(pick(3), pick(7)),
      };
    });
    check('Setup: picked range endpoints on page 1',
      !!picks.a && !!picks.b && !!picks.d && picks.ab.length >= 3,
      `${picks.ab.length} sentences A→B`);

    // ---- D1: order independence + unknown ids ------------------------------
    await clickSentence(picks.a);
    await clickSentence(picks.b, ['Shift']);
    const fwd = await modeState();
    await page.keyboard.press('Escape');
    await clickSentence(picks.b);
    await clickSentence(picks.a, ['Shift']);
    const rev = await modeState();
    check('D1: A→shift-B and B→shift-A select the SAME range',
      fwd.modeOn && rev.modeOn
      && JSON.stringify([...fwd.selected].sort()) === JSON.stringify([...rev.selected].sort())
      && fwd.selected.length === picks.ab.length,
      `fwd=${fwd.selected.length} rev=${rev.selected.length} expected=${picks.ab.length}`);
    // Unknown ids: select() must no-op and leave the current range alone.
    await page.evaluate(() => window.WriteSysRangeDelete.select('no-such-id', 'also-missing'));
    const afterUnknown = await modeState();
    check('D1: unknown ids no-op (range unchanged)',
      afterUnknown.modeOn && afterUnknown.selected.length === rev.selected.length);
    await page.keyboard.press('Escape');

    // ---- D2: shift-mousedown swallows native selection ---------------------
    const target = page.locator(`.sentence[data-sentence-id="${picks.c}"]`).first();
    const box = await target.boundingBox();
    await page.keyboard.down('Shift');
    await page.mouse.move(box.x + 5, box.y + 5);
    await page.mouse.down();
    const nativeSel = await page.evaluate(() => String(window.getSelection() || ''));
    await page.mouse.up();
    await page.keyboard.up('Shift');
    check('D2: shift-MOUSEDOWN in the pages leaves no native selection',
      nativeSel === '', nativeSel.slice(0, 40));
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.WriteSysRangeDelete.exit());

    // ---- D3: exit paths ----------------------------------------------------
    // (a) Escape exits.
    await clickSentence(picks.a);
    await clickSentence(picks.b, ['Shift']);
    check('D3: range armed for Escape', (await modeState()).modeOn);
    await page.keyboard.press('Escape');
    let st = await modeState();
    check('D3: Escape exits (mode off, highlights gone, trash removed)',
      !st.modeOn && st.selected.length === 0 && st.trash === 0);
    // (b) empty-area click exits.
    await clickSentence(picks.a);
    await clickSentence(picks.b, ['Shift']);
    await page.mouse.click(10, 400); // far-left gutter: no sentence, no trash
    st = await modeState();
    check('D3: plain click on empty space exits', !st.modeOn && st.selected.length === 0);
    // (c) plain sentence click exits AND re-anchors.
    await clickSentence(picks.a);
    await clickSentence(picks.b, ['Shift']);
    await clickSentence(picks.c); // re-anchor
    st = await modeState();
    check('D3: plain sentence click exits the mode', !st.modeOn && st.selected.length === 0);
    await clickSentence(picks.d, ['Shift']);
    st = await modeState();
    check('D3: ...and re-anchors (shift-click from the new anchor works)',
      st.modeOn && JSON.stringify([...st.selected].sort()) === JSON.stringify([...picks.cd].sort()),
      `${st.selected.length}/${picks.cd.length}`);
    // (d) trash click keeps the mode.
    await page.locator('.range-trash:not(.range-sketch)').click();
    st = await modeState();
    check('D3: trash click stays in the mode (arming, not exiting)',
      st.modeOn && st.selected.length === picks.cd.length && st.trash === 1);
    await page.keyboard.press('Escape');

    // ---- D4: arm → 2s auto-disarm → re-arm → apply -------------------------
    await clickSentence(picks.a);
    await clickSentence(picks.b, ['Shift']);
    const trash = page.locator('.range-trash:not(.range-sketch)');
    await trash.click();
    check('D4: first click arms (confirming)',
      await page.evaluate(() => document.querySelector('.range-trash:not(.range-sketch)').classList.contains('confirming')));
    // The arm auto-disarms after 2s.
    await page.waitForFunction(() => {
      const t = document.querySelector('.range-trash:not(.range-sketch)');
      return t && !t.classList.contains('confirming');
    }, null, { timeout: 5000 });
    check('D4: arm auto-disarms after the 2s window (mode + range survive)',
      (await modeState()).modeOn);
    const before4 = psql(`SELECT COUNT(*) FROM suggested_change WHERE user_id='${TEST_USERNAME}'`);
    check('D4: disarmed click applied nothing', before4 === '0', before4);
    // Re-arm and apply.
    const stamp4 = await paginationStamp(page);
    await trash.click();
    check('D4: re-arm works after a disarm',
      await page.evaluate(() => document.querySelector('.range-trash:not(.range-sketch)').classList.contains('confirming')));
    await trash.click();
    await waitForRepagination(page, stamp4);
    const rows4 = psql(`SELECT COUNT(*) FROM suggested_change WHERE user_id='${TEST_USERNAME}' AND text=''`);
    check('D4: armed second click applies — empty suggestion per range sentence',
      rows4 === String(picks.ab.length), `rows=${rows4} expected=${picks.ab.length}`);
    check('D4: mode exits after apply', !(await modeState()).modeOn);
    psql(`DELETE FROM suggested_change WHERE user_id='${TEST_USERNAME}'`);
    await page.goto(TEST_URL);
    await waitForPagination(page);

    // ---- D5: mid-range PUT failure -----------------------------------------
    await clickSentence(picks.a);
    await clickSentence(picks.b, ['Shift']);
    const failId = picks.ab[1]; // second sentence in the range
    await page.route(`**/api/sentences/${failId}/suggestion`, (route) => {
      if (route.request().method() === 'PUT') return route.fulfill({ status: 500, body: 'boom' });
      return route.fallback();
    });
    dialogs.length = 0;
    const stamp5 = await paginationStamp(page);
    const trash5 = page.locator('.range-trash:not(.range-sketch)');
    await trash5.click();
    await trash5.click();
    // apply(): alert → exit → refetch → re-render.
    await waitForRepagination(page, stamp5);
    check('D5: mid-range failure alerts once with the failing id',
      dialogs.length === 1 && dialogs[0].includes(failId) && dialogs[0].includes('review and retry'),
      JSON.stringify(dialogs));
    check('D5: mode exits after the failure', !(await modeState()).modeOn);
    const okBefore = psql(`SELECT COUNT(*) FROM suggested_change WHERE user_id='${TEST_USERNAME}' AND sentence_id='${picks.ab[0]}' AND text=''`);
    const failRow = psql(`SELECT COUNT(*) FROM suggested_change WHERE user_id='${TEST_USERNAME}' AND sentence_id='${failId}'`);
    const afterRows = picks.ab.slice(2).map((id) =>
      psql(`SELECT COUNT(*) FROM suggested_change WHERE user_id='${TEST_USERNAME}' AND sentence_id='${id}'`));
    check('D5: sentences BEFORE the failure keep their suggestion', okBefore === '1');
    check('D5: the failed sentence has none', failRow === '0');
    check('D5: sentences AFTER the failure were never attempted',
      afterRows.every((c) => c === '0'), JSON.stringify(afterRows));
    // The re-render reflects the partial state: first sentence struck.
    check('D5: refetch + re-render show the partial proposal',
      await page.evaluate((id) => {
        const el = document.querySelector(`.sentence[data-sentence-id="${CSS.escape(id)}"]`);
        return el && el.classList.contains('suggested-delete');
      }, picks.ab[0]));
    await page.unroute(`**/api/sentences/${failId}/suggestion`);
    psql(`DELETE FROM suggested_change WHERE user_id='${TEST_USERNAME}'`);
    await page.goto(TEST_URL);
    await waitForPagination(page);

    // ---- D6: trash geometry under transform: scale -------------------------
    await page.setViewportSize({ width: 500, height: 800 });
    await page.waitForFunction(() => {
      const el = document.querySelector('.pagedjs_pages');
      return el && el.style.transform.includes('scale');
    }, null, { timeout: 5000 });
    await clickSentence(picks.a);
    await clickSentence(picks.b, ['Shift']);
    const d6 = await page.evaluate(() => {
      const trashEl = document.querySelector('.range-trash:not(.range-sketch)');
      if (!trashEl) return null;
      const tr = trashEl.getBoundingClientRect();
      const sheet = trashEl.closest('.pagedjs_sheet') || trashEl.closest('.pagedjs_page');
      const sr = sheet.getBoundingClientRect();
      const sel = [...document.querySelectorAll('.sentence.range-selected')]
        .filter((el) => (el.closest('.pagedjs_sheet') || el.closest('.pagedjs_page')) === sheet)
        .map((el) => el.getBoundingClientRect()).filter((r) => r.height > 0);
      const top = Math.min(...sel.map((r) => r.top));
      const bottom = Math.max(...sel.map((r) => r.bottom));
      const m = document.querySelector('.pagedjs_pages').style.transform.match(/scale\(([\d.]+)\)/);
      return {
        scale: m ? parseFloat(m[1]) : 1,
        rightVsSheet: tr.right - sr.left,
        centerOffset: Math.abs((tr.top + tr.bottom) / 2 - (top + bottom) / 2),
        visibleWidth: tr.width,
      };
    });
    check('D6: trash rendered under scale', !!d6, d6 && `scale=${d6.scale}`);
    if (d6) {
      check('D6: trash sits fully off the sheet in the gutter (scaled space)',
        d6.rightVsSheet < 0, `right-vs-sheet=${d6.rightVsSheet.toFixed(1)}px`);
      check('D6: trash vertically centered on the range under scale (±8px)',
        d6.centerOffset <= 8, `offset=${d6.centerOffset.toFixed(1)}px`);
      await page.locator('.range-trash:not(.range-sketch)').click();
      check('D6: trash is clickable under scale (arms)',
        await page.evaluate(() => document.querySelector('.range-trash:not(.range-sketch)').classList.contains('confirming')));
    }
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1400, height: 900 });

  } catch (e) {
    console.log(`❌ Test errored: ${e.message}`);
    failed = true;
  } finally {
    psql(`DELETE FROM suggested_change WHERE user_id='${TEST_USERNAME}'`);
    await browser.close();
  }

  console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('Test crashed:', e); process.exit(1); });
