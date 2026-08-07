// Regression: a snippet's edit-mode registers a "flusher" that fires on every
// scratchpad doc-save. renderEdit() runs on every enter-edit / tab-switch /
// rebuild; if it added a NEW flusher without removing the prior one, stale
// flushers accumulated, each holding an OLD text snapshot. The next doc-save
// fired them all at once — a race where an old snapshot could land last and
// CLOBBER current work (real data-loss bug, observed live). This drives many
// enter/leave-edit cycles then forces doc-saves, and asserts the variation's
// PERSISTED text (DB — the source of truth) is the final version, not a stale
// snapshot.
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const { TEST_URL, cleanupTestNotes, loginAsTestUser } = require('./test-utils');
const HOME_URL = new URL('home.html', TEST_URL).href;
function psql(sql) {
  return execSync(
    `PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8' });
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  page.on('dialog', d => d.accept());
  let failed = false;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed = true; };

  await cleanupTestNotes();
  await loginAsTestUser(page);
  await page.goto(HOME_URL);
  await page.waitForSelector('#home-new-pad'); await page.click('#home-new-pad');
  await page.waitForSelector('.spm-overlay .ProseMirror');

  // Insert a snippet widget; capture its variation_id for DB assertions.
  const ctx = await page.evaluate(() => window.WriteSysScratchpad.insertSnippet());
  const variationId = ctx && ctx.variation && ctx.variation.variation_id;
  check('snippet inserted', !!variationId, `variation_id=${variationId}`);
  await page.waitForSelector('.sn-widget .sn-clickable, .sn-widget .sn-render', { timeout: 6000 });
  await page.waitForTimeout(300);

  const enterEdit = async () => {
    await page.locator('.sn-widget .sn-clickable, .sn-widget .sn-render').first().click();
    await page.waitForSelector('.sn-widget textarea.sn-text', { timeout: 4000 });
    return page.locator('.sn-widget textarea.sn-text').first();
  };
  const leaveEdit = async () => { await page.locator('#spm-title').click(); await page.waitForTimeout(300); };

  // Build the text up across SEVERAL enter/leave cycles. Each re-runs
  // renderEdit(), which historically leaked a stale flusher holding that
  // cycle's snapshot. The pre-fix bug: those stale snapshots race on doc-save.
  const stages = ['One.', 'One. Two.', 'One. Two. Three.', 'One. Two. Three. Four.'];
  for (const s of stages) {
    const ta = await enterEdit();
    await ta.fill(s);
    await page.waitForTimeout(700); // debounced variation-save fires
    await leaveEdit();
  }

  // Final, longest edit — then force scratchpad doc-saves (each fires
  // flushVariations → every registered flusher). With the leak, a stale short
  // snapshot could land last and win here.
  const FINAL = 'One. Two. Three. Four. Five — the final and longest version that must survive.';
  const ta = await enterEdit();
  await ta.fill(FINAL);
  await page.waitForTimeout(300);
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.WriteSysScratchpad.saveNow && window.WriteSysScratchpad.saveNow());
    await page.waitForTimeout(500);
  }
  await leaveEdit();
  await page.evaluate(() => window.WriteSysScratchpad.saveNow && window.WriteSysScratchpad.saveNow());
  await page.waitForTimeout(800);

  // The PERSISTED text must be the final version — not a stale earlier snapshot.
  const dbText = psql(`SELECT text FROM variation WHERE variation_id=${variationId}`).trim();
  check('persisted variation text is the FINAL version (no stale-snapshot clobber)',
    dbText === FINAL, JSON.stringify(dbText.slice(0, 90)));

  // And it survives a reload (came from the DB, so this is belt-and-suspenders).
  await page.reload(); await page.waitForTimeout(800);
  const dbAfter = psql(`SELECT text FROM variation WHERE variation_id=${variationId}`).trim();
  check('final text still persisted after reload', dbAfter === FINAL, JSON.stringify(dbAfter.slice(0, 90)));

  await browser.close();
  console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS');
  process.exit(failed ? 1 : 0);
})();
