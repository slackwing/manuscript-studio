// Canonize onto a boundary sentence that ALREADY has a pending suggestion:
// the + must appear (no longer suppressed) and the canonize must COMPOSE —
// one suggestion carrying the user's prose edit AND the &snippet region.
const { chromium } = require('playwright');
const { TEST_URL, TEST_USERNAME, loginAsTestUser, cleanupTestAnnotations, cleanupTestNotes } = require('./test-utils');
const { execSync } = require('child_process');
const psql = (sql) => execSync(
  `PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`,
  { encoding: 'utf-8' }).trim();

(async () => {
  await cleanupTestAnnotations();
  await cleanupTestNotes();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('dialog', d => d.dismiss()); // decline freeze-all
  let failed = false;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed = true; };

  await loginAsTestUser(page);
  // a variation to canonize
  await page.goto(new URL('home.html', TEST_URL).href);
  await page.waitForSelector('#home-new-pad'); await page.click('#home-new-pad');
  await page.waitForSelector('.spm-overlay .ProseMirror');
  await page.locator('.spm-editor .ProseMirror').click();
  await page.evaluate(async () => {
    const ed = window.WriteSysScratchpad;
    const ctx = await ed.insertSnippet();
    await ed.variationApi.saveText(ctx.variation.variation_id, 'Composed canon region text.');
    window.__sk = ctx.variation.variation_id;
  });
  const sk = await page.evaluate(() => window.__sk);
  await page.click('#spm-close');
  await page.waitForSelector('.spm-overlay', { state: 'detached' });

  await page.goto(`${TEST_URL}/index.html`);
  await page.waitForSelector('.sentence[data-sentence-id]', { timeout: 40000 });
  await page.waitForTimeout(4000);

  // find a + zone boundary, put a SUGGESTION on that sentence first
  const boundary = await page.evaluate(() => document.querySelector('.import-zone[data-sentence-id]').dataset.sentenceId);
  const edited = await page.evaluate(async (sid) => {
    const orig = window.WriteSysRenderer.sentenceMap[sid];
    const text = orig.replace(/\.\s*$/, '') + ' EDITED FIRST.';
    const csrf = localStorage.getItem('csrf_token') || sessionStorage.getItem('csrf_token');
    const r = await fetch(`api/sentences/${encodeURIComponent(sid)}/suggestion`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({ text }),
    });
    return r.ok ? text : null;
  }, boundary);
  check('pending suggestion placed on the boundary sentence', !!edited);

  await page.reload();
  await page.waitForSelector('.sentence[data-sentence-id]', { timeout: 40000 });
  await page.waitForTimeout(4000);
  const zoneStill = await page.evaluate((sid) =>
    !!document.querySelector(`.import-zone[data-sentence-id="${CSS.escape(sid)}"]`), boundary);
  check('+ still appears at a suggested boundary', zoneStill);

  // canonize through the modal at that boundary
  await page.evaluate((sid) => {
    document.querySelector(`.import-zone[data-sentence-id="${CSS.escape(sid)}"] .import-tab`).click();
  }, boundary);
  await page.waitForSelector('#im-blocks .im-block, #im-blocks button, #import-modal', { timeout: 10000 });
  await page.waitForTimeout(800);
  // pick our variation (search narrows it)
  await page.fill('#im-q', 'Composed canon region');
  await page.waitForTimeout(600);
  const picked = await page.evaluate(() => {
    const b = document.querySelector('#im-blocks [data-variation-id], #im-blocks .im-block');
    if (!b) return false;
    b.click();
    return true;
  });
  check('variation picked in modal', picked);
  await page.fill('#im-label', 'Compose Test');
  await page.click('#im-go');
  await page.waitForSelector('#import-modal', { state: 'detached', timeout: 20000 });

  const sug = psql(`SELECT text FROM suggested_change WHERE sentence_id='${boundary}' AND user_id='${TEST_USERNAME}'`);
  check('ONE suggestion holds the edit AND the region',
    sug.includes('EDITED FIRST.') && sug.includes('&snippet#') && sug.includes('&end#'),
    JSON.stringify(sug.slice(0, 80)));
  const canonized = psql(`SELECT canon_variation_id IS NOT NULL FROM snippet WHERE snippet_id = (SELECT snippet_id FROM variation WHERE variation_id=${sk})`);
  check('variation group canonized', canonized === 't');

  // cleanup: remove the composed suggestion + decanonize fixture leftovers
  psql(`DELETE FROM suggested_change WHERE sentence_id='${boundary}' AND user_id='${TEST_USERNAME}'`);
  console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS');
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('Test crashed:', e); process.exit(1); });
