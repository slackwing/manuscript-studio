// Daily vs other points (049): each point_event records whether its task
// was on the owner's daily-tasks board when it was scored (from_daily) —
// stamped live at scoring time, and BACKFILLED for history by rebuilding
// each past board as of the event (one board function for the page, the
// stamp and the backfill). The points API splits each day into daily /
// other; the landing grid paints them green / gold (test-points-grid).
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const { TEST_URL, TEST_USERNAME, TEST_MANUSCRIPT_ID, cleanupTestNotes, loginAsTestUser } = require('./test-utils');
const HOME_URL = new URL('home.html', TEST_URL).href;
function psql(sql) {
  return execSync(
    `PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8' }).trim();
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  let failed = false;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed = true; };
  const M = TEST_MANUSCRIPT_ID;
  const U = TEST_USERNAME;

  try {
    await cleanupTestNotes();
    psql(`DELETE FROM daily_rule WHERE user_id='${U}'`);
    // The board pool (≤16, so every eligible task is on every board):
    // three tasks created three days ago. Plus a task created TODAY (never
    // on today's random pick) and one created YESTERDAY (on today's board,
    // not on yesterday's).
    psql(`INSERT INTO note (user_id, color, body, priority, task_type, position, manuscript_id, created_at)
          SELECT '${U}', 'yellow', 'Board task ' || i, 'can', 'write', 'a' || i, ${M}, now() - interval '3 days'
          FROM generate_series(1, 3) i`);
    psql(`INSERT INTO note (user_id, color, body, priority, task_type, position, manuscript_id, created_at)
          VALUES ('${U}', 'green', 'Fresh task', 'can', 'write', 'b1', ${M}, now()),
                 ('${U}', 'blue', 'Yesterday task', 'can', 'write', 'b2', ${M}, now() - interval '1 day 1 minute')`);
    const idOf = (body) => parseInt(psql(`SELECT note_id FROM note WHERE user_id='${U}' AND body='${body}'`), 10);

    await loginAsTestUser(page);
    await page.goto(HOME_URL);
    await page.waitForSelector('.card-manuscript', { timeout: 15000 });
    const csrf = await page.evaluate(() => sessionStorage.getItem('csrf_token') || localStorage.getItem('csrf_token') || '');
    const score = (id, pts) => page.evaluate(async ({ id, pts, csrf }) => (await fetch(`api/notes/${id}/points`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ points: pts }),
    })).status, { id, pts, csrf });
    const lastFlag = (id) => psql(`SELECT from_daily FROM point_event WHERE note_id=${id} ORDER BY point_event_id DESC LIMIT 1`);

    // ---- live stamp ----
    check('score a board task → 204', (await score(idOf('Board task 1'), 4)) === 204);
    check('…stamped daily', lastFlag(idOf('Board task 1')) === 't');
    check('score a task created today → 204', (await score(idOf('Fresh task'), 2)) === 204);
    check('…stamped other (not on today\'s board)', lastFlag(idOf('Fresh task')) === 'f');
    const pin = await page.evaluate(async ({ id, csrf }) => (await fetch(`api/notes/${id}/pin`, {
      method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrf } })).status, { id: idOf('Fresh task'), csrf });
    check('pin it → 204', pin === 204);
    await score(idOf('Fresh task'), 3);
    check('…now pinned, its points stamp daily', lastFlag(idOf('Fresh task')) === 't');

    // ---- backfill: history scored before 049 (from_daily NULL) ----
    // This time yesterday (relative to now, so it's "yesterday" in the
    // server's configured timezone too): a board task (on yesterday's board)
    // → daily; the task created a minute before (after yesterday's midnight)
    // → other; a board task DELETED today was still on yesterday's board →
    // daily.
    psql(`INSERT INTO point_event (note_id, points, scored_at) VALUES
          (${idOf('Board task 2')}, 5, now() - interval '1 day'),
          (${idOf('Yesterday task')}, 1, now() - interval '1 day'),
          (${idOf('Board task 3')}, 7, now() - interval '1 day')`);
    psql(`UPDATE note SET deleted_at = now() WHERE note_id = ${idOf('Board task 3')}`);
    check('three history rows unclassified', psql(`SELECT count(*) FROM point_event pe JOIN note n USING (note_id)
      WHERE n.user_id='${U}' AND pe.from_daily IS NULL`) === '3');
    const api = await page.evaluate(() => fetch('api/points-daily', { credentials: 'same-origin' }).then((r) => r.json()));
    check('the points API classified them (lazy backfill)', psql(`SELECT count(*) FROM point_event pe JOIN note n USING (note_id)
      WHERE n.user_id='${U}' AND pe.from_daily IS NULL`) === '0');
    check('a board task on yesterday\'s board → daily', lastFlag(idOf('Board task 2')) === 't');
    check('a task created after yesterday\'s midnight → other', lastFlag(idOf('Yesterday task')) === 'f');
    check('a task deleted since still counts for yesterday (as-of) → daily', lastFlag(idOf('Board task 3')) === 't');

    // ---- the API's per-day split ----
    const days = Object.fromEntries((api.days || []).map((d) => [d.date, d]));
    const t = days[api.today] || {};
    const y = (api.days || []).find((d) => d.date < api.today) || {};
    check('today: 9 points, 7 daily (4 board + 3 pinned), 2 other', t.points === 9 && t.daily === 7, JSON.stringify(t));
    check('yesterday: 13 points, 12 daily, 1 other', y.points === 13 && y.daily === 12, JSON.stringify(y));
  } catch (e) {
    console.log(`❌ Test errored: ${e.message}`);
    failed = true;
  } finally {
    psql(`DELETE FROM daily_rule WHERE user_id='${U}'`);
    await browser.close();
    await cleanupTestNotes();
  }
  console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS');
  process.exit(failed ? 1 : 0);
})();
