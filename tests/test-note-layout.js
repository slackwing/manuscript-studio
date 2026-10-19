// Sticky note size + layout (2026-10-18): the note component has ONE
// standard size (--sticky-note-width, note-widget.css) that every host uses
// — the desktop margin and the compact layout's note stack under the
// suggest-edit modal alike. The stack is the shared .sticky-note-grid:
// fixed-size notes, as many per row as fit, LEFT-aligned (a lane stays
// free). The bottom row's circles sit at a FIXED pitch (6px gaps) on any
// note width; the trash stays on the right.
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const { TEST_URL, TEST_USERNAME, TEST_MANUSCRIPT_ID, loginAsTestUser, waitForPagination, cleanupTestNotes } = require('./test-utils');
function psql(sql) {
  return execSync(`PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`, { encoding: 'utf8' }).trim();
}

(async () => {
  let failed = false;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed = true; };
  const U = TEST_USERNAME, M = TEST_MANUSCRIPT_ID;
  const browser = await chromium.launch({ headless: true });
  try {
    await cleanupTestNotes();
    const measure = (sel) => (s) => {
      const notes = [...document.querySelectorAll(`${s} > .sticky-note`)];
      const host = document.querySelector(s).getBoundingClientRect();
      const task = notes.find((n) => n.querySelector('.complete-check') && getComputedStyle(n.querySelector('.complete-check')).display !== 'none');
      let gaps = [], trashRight = null;
      if (task) {
        const row = task.querySelector('.priority-flag-chips');
        const kids = [...row.children].filter((c) => getComputedStyle(c).display !== 'none' && c.getBoundingClientRect().width > 0);
        const vis = kids.filter((c) => !c.classList.contains('note-trash'));
        gaps = vis.slice(1).map((k, i) => Math.round(k.getBoundingClientRect().left - vis[i].getBoundingClientRect().right));
        trashRight = Math.round(row.getBoundingClientRect().right - row.querySelector('.note-trash').getBoundingClientRect().right);
      }
      return {
        widths: notes.map((n) => Math.round(n.getBoundingClientRect().width)),
        tops: notes.map((n) => Math.round(n.getBoundingClientRect().top)),
        lefts: notes.map((n) => Math.round(n.getBoundingClientRect().left - host.left)),
        gaps, trashRight,
      };
    };
    for (const [vw, vh, where] of [[1400, 1000, 'desktop'], [900, 1000, 'compact'], [390, 844, 'phone']]) {
      const page = await browser.newPage({ viewport: { width: vw, height: vh } });
      await loginAsTestUser(page);
      await page.goto(TEST_URL);
      await waitForPagination(page);
      const sid = await page.evaluate(() => document.querySelectorAll('.pagedjs_pages .sentence[data-sentence-id]')[2].dataset.sentenceId);
      psql(`DELETE FROM note WHERE user_id='${U}' AND body LIKE 'Layout note%'`);
      psql(`INSERT INTO note (user_id, color, body, priority, task_type, position, manuscript_id, sentence_id) VALUES
        ('${U}', 'yellow', 'Layout note one', 'can', 'write', 'l1', ${M}, '${sid}'),
        ('${U}', 'green', 'Layout note two', 'can', 'write', 'l2', ${M}, '${sid}'),
        ('${U}', 'blue', 'Layout note three', 'can', 'write', 'l3', ${M}, '${sid}')`);
      await page.reload();
      await waitForPagination(page);
      await page.evaluate(() => { window.WriteSysRenderer.currentSelectedSentenceId = null; });
      const span = page.locator(`.pagedjs_pages .sentence[data-sentence-id="${sid}"]`).first();
      await span.click();
      let host;
      if (where === 'desktop') {
        host = '#sticky-notes-container';
      } else {
        await page.waitForTimeout(300);
        await span.click(); // the second click opens the suggest-edit modal + its note stack
        host = '#sgm-notes-stack';
      }
      await page.waitForFunction((h) => document.querySelectorAll(`${h} > .sticky-note`).length >= 4, host, { timeout: 10000 });
      const m = await page.evaluate(measure(), host);
      check(`${where} ${vw}px: every note (incl. the create card) is the standard 232px`, m.widths.length >= 4 && m.widths.every((w) => Math.abs(w - 232) <= 1), JSON.stringify(m.widths));
      check(`${where}: circles 6px apart, trash flush right`, m.gaps.length >= 3 && m.gaps.every((g) => g === 6) && Math.abs(m.trashRight) <= 1, JSON.stringify({ gaps: m.gaps, trashRight: m.trashRight }));
      if (where === 'compact') {
        check('compact: several notes share a row (grid, not a column)', m.tops[0] === m.tops[1] && m.tops[1] === m.tops[2], JSON.stringify(m.tops));
        check('compact: left-aligned rows', m.lefts[0] === 0 && m.lefts[3] === 0, JSON.stringify(m.lefts));
      }
      if (where === 'phone') {
        check('phone: left-aligned, a lane left free on the right', m.lefts.every((l) => l === 0), JSON.stringify(m.lefts));
      }
      await page.close();
    }
  } catch (e) {
    console.log(`❌ Test errored: ${e.message}`);
    failed = true;
  } finally {
    psql(`DELETE FROM note WHERE user_id='${TEST_USERNAME}' AND body LIKE 'Layout note%'`);
    await browser.close();
  }
  console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS');
  process.exit(failed ? 1 : 0);
})();
