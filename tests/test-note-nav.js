// The book margin's note tour (2026-10-18): ‹ › flank the sentence preview
// ("‹ So, forgive me... ›") in the preview's own type — Georgia italic,
// same size and gray — with no counter. Idle (nothing selected) the bare
// ‹ › pair is the entry point. Prev/next wrap around.
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const { TEST_URL, TEST_USERNAME, TEST_MANUSCRIPT_ID, loginAsTestUser, waitForPagination, cleanupTestNotes } = require('./test-utils');
function psql(sql) {
  return execSync(`PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`, { encoding: 'utf8' }).trim();
}

(async () => {
  let failed = false;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed = true; };
  const browser = await chromium.launch({ headless: true });
  try {
    await cleanupTestNotes();
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await loginAsTestUser(page);
    await page.goto(TEST_URL);
    await waitForPagination(page);
    const sids = await page.evaluate(() => [...document.querySelectorAll('.pagedjs_pages p .sentence[data-sentence-id]')].slice(1, 4).map((s) => s.dataset.sentenceId));
    sids.forEach((sid, i) => psql(`INSERT INTO note (user_id, color, body, priority, task_type, position, manuscript_id, sentence_id)
      VALUES ('${TEST_USERNAME}', 'yellow', 'Nav note ${i}', 'can', 'write', 'n${i}', ${TEST_MANUSCRIPT_ID}, '${sid}')`));
    await page.reload();
    await waitForPagination(page);
    await page.waitForSelector('.note-nav-next:not([hidden])');
    check('no counter anywhere in the margin', (await page.locator('#note-margin .pw-nav-count').count()) === 0);
    check('idle: the bare ‹ › pair, preview hidden', await page.evaluate(() =>
      !document.querySelector('.note-nav-prev').hidden && !document.querySelector('#sentence-preview.visible')));
    await page.click('.note-nav-next');
    await page.waitForSelector('#sentence-preview.visible');
    const sel = () => page.evaluate(() => window.WriteSysNotes.currentSentenceId);
    // The tour runs in document order; read it back from the margin.
    const order = await page.evaluate(() => window.WriteSysNotes.annotatedOrdered());
    check('› from idle lands on the first annotated sentence', (await sel()) === order[0], `${await sel()} vs ${order[0]}`);
    const m = await page.evaluate(() => {
      const r = (s) => document.querySelector(s).getBoundingClientRect();
      const f = (s) => { const c = getComputedStyle(document.querySelector(s)); return [c.fontFamily, c.fontSize, c.fontStyle, c.color].join('|'); };
      const p = r('#sentence-preview'), a = r('.note-nav-prev'), b = r('.note-nav-next');
      return { flank: a.right <= p.left + 1 && b.left >= p.right - 1, oneLine: Math.abs(a.bottom - p.bottom) <= 2 && Math.abs(b.bottom - p.bottom) <= 2,
        same: f('.note-nav-prev') === f('#sentence-preview') && f('.note-nav-next') === f('#sentence-preview'), font: f('#sentence-preview') };
    });
    check('‹ preview › on one line', m.flank && m.oneLine, JSON.stringify(m));
    check('the buttons wear the preview\'s type (font, size, italic, gray)', m.same, m.font);
    await page.click('.note-nav-next');
    await page.waitForFunction((s) => window.WriteSysNotes.currentSentenceId === s, order[1]);
    check('› steps to the next note', true);
    await page.click('.note-nav-prev');
    await page.click('.note-nav-prev');
    await page.waitForFunction((s) => window.WriteSysNotes.currentSentenceId === s, order[order.length - 1], { timeout: 5000 })
      .then(() => check('‹ from the first wraps to the last', true))
      .catch(async () => check('‹ from the first wraps to the last', false, await sel()));
  } catch (e) {
    check('run', false, e.message);
  } finally {
    psql(`DELETE FROM note WHERE body LIKE 'Nav note %'`);
  }
  await browser.close();
  console.log(failed ? '\n❌ some checks failed' : '\n✅ all passed');
  process.exit(failed ? 1 : 0);
})();
