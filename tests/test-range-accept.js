// Range ✓ (batch accept, 2026-10-18): a shift-click range's gutter stack
// gains a check on top (reviewers only). House two-click: the first click
// arms it and greens the range, a 2s pause disarms both, a second click
// accepts the suggestion every selected sentence SHOWS — deletion proposals
// included — and leaves sentences without one alone.
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const { TEST_URL, TEST_USERNAME, loginAsTestUser, waitForPagination, cleanupTestAnnotations } = require('./test-utils');
function psql(sql) {
  return execSync(`PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`, { encoding: 'utf8' }).trim();
}

(async () => {
  let failed = false;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed = true; };
  const browser = await chromium.launch({ headless: true });
  let ids = [];
  try {
    psql(`DELETE FROM suggested_change WHERE user_id='${TEST_USERNAME}'`);
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    await loginAsTestUser(page);
    await page.goto(TEST_URL);
    await waitForPagination(page);
    // Four consecutive prose sentences of one paragraph: an edit, a
    // deletion, none, an edit.
    ids = await page.evaluate(() => {
      const spans = [...document.querySelectorAll('.pagedjs_pages p .sentence[data-sentence-id]')];
      for (let i = 0; i + 3 < spans.length; i++) {
        const four = spans.slice(i, i + 4);
        if (new Set(four.map((s) => s.closest('p'))).size === 1 && new Set(four.map((s) => s.dataset.sentenceId)).size === 4) {
          return four.map((s) => s.dataset.sentenceId);
        }
      }
      return [];
    });
    check('found four sentences in one paragraph', ids.length === 4, JSON.stringify(ids));
    await page.evaluate(async (ids) => {
      const S = window.WriteSysSuggestions, R = window.WriteSysRenderer;
      await S.putSuggestion(ids[0], R.sentenceMap[ids[0]] + ' EDITED');
      await S.putSuggestion(ids[1], '');
      await S.putSuggestion(ids[3], R.sentenceMap[ids[3]] + ' ALSO');
      await S.loadForMigration(R.currentMigrationID);
      await R.renderManuscript();
    }, ids);
    await waitForPagination(page);
    const status = () => psql(`SELECT string_agg(sentence_id || ':' || coalesce(review_status, 'pending'), ',' ORDER BY sentence_id) FROM suggested_change WHERE user_id='${TEST_USERNAME}'`);
    check('three pending suggestions (an edit, a deletion, an edit)', (status().match(/pending/g) || []).length === 3, status());

    await page.evaluate(() => { window.WriteSysRenderer.currentSelectedSentenceId = null; });
    await page.locator(`.pagedjs_pages .sentence[data-sentence-id="${ids[0]}"]`).first().click();
    await page.locator(`.pagedjs_pages .sentence[data-sentence-id="${ids[3]}"]`).first().click({ modifiers: ['Shift'] });
    await page.waitForSelector('.range-accept');
    const stack = await page.evaluate(() => {
      const top = (sel) => document.querySelector(sel).getBoundingClientRect().top;
      return top('.range-accept') < top('.range-copy') && top('.range-copy') < top('.range-sketch') && top('.range-sketch') < top('.range-trash.range-del');
    });
    check('✓ tops the stack: accept, copy, sketch, trash', stack);
    // Every stack button answers hover — and its icon stays visible on the
    // hover fill (the ✓ once went white on pale green).
    for (const cls of ['range-accept', 'range-copy', 'range-sketch', 'range-del']) {
      const b = page.locator(`.range-trash.${cls}`);
      const look = () => b.evaluate((e) => { const c = getComputedStyle(e); return { bg: c.backgroundColor, fg: c.color }; });
      const rest = await look();
      await b.hover();
      await page.waitForTimeout(250);
      const hov = await look();
      check(`${cls}: hover changes it, icon still contrasts`, (hov.bg !== rest.bg || hov.fg !== rest.fg) && hov.fg !== hov.bg
        && !(hov.fg === 'rgb(255, 255, 255)' && /^rgb\((2[2-5]\d), (2[2-5]\d), (2[2-5]\d)\)$/.test(hov.bg)), JSON.stringify({ rest, hov }));
      await page.mouse.move(2, 2);
    }
    const bg = () => page.evaluate(() => {
      const el = document.querySelector('.sentence.range-selected');
      el.getAnimations().forEach((a) => a.finish());
      return getComputedStyle(el).backgroundColor;
    });
    await page.click('.range-accept');
    check('first click arms: the range turns green', (await bg()) === 'rgba(46, 125, 50, 0.16)', await bg());
    check('…and accepts nothing yet', (status().match(/accepted/g) || []).length === 0, status());
    await page.waitForFunction(() => !document.querySelector('.range-accept.confirming'), null, { timeout: 5000 });
    check('a pause disarms: back to the selection gray', (await bg()) === 'rgb(208, 208, 208)', await bg());
    await page.click('.range-accept');
    await page.click('.range-accept');
    await page.waitForFunction(() => !document.body.classList.contains('range-delete-mode'), null, { timeout: 10000 });
    const st = status();
    check('second click accepts the edit AND the deletion (and the other edit)',
      st.split(',').every((x) => x.endsWith(':accepted')) && st.split(',').length === 3, st);
    check('the sentence without a suggestion got none', !st.includes(ids[2]));
  } catch (e) {
    console.log(`❌ Test errored: ${e.message}`);
    failed = true;
  } finally {
    psql(`DELETE FROM suggested_change WHERE user_id='${TEST_USERNAME}'`);
    await cleanupTestAnnotations();
    await browser.close();
  }
  console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS');
  process.exit(failed ? 1 : 0);
})();
