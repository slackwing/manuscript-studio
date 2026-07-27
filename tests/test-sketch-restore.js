/**
 * Soft-delete + Restore… for snippet variations: trash soft-deletes (widget
 * removed, sketch kept as deleted), the Snippet ▾ menu → Restore… lists it
 * (newest deletion first) and restoring re-inserts the widget.
 */
const { chromium } = require('playwright');
const { TEST_URL, cleanupTestAnnotations, loginAsTestUser } = require('./test-utils');
const HOME_URL = new URL('home.html', TEST_URL).href;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.on('dialog', d => d.accept()); // auto-confirm the delete prompt
  let failed = false;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed = true; };

  await cleanupTestAnnotations();
  await loginAsTestUser(page);
  await page.goto(HOME_URL);
  await page.waitForSelector('#home-new-pad', { timeout: 20000 });
  await page.click('#home-new-pad');
  await page.waitForSelector('.spm-overlay .ProseMirror', { timeout: 20000 });

  // Create a snippet, write identifying text so we can find it in the list.
  const ctx = await page.evaluate(() => window.WriteSysScratchpad.insertSnippet());
  const varId = ctx.sketch.sketch_id;
  await page.waitForSelector('.sn-widget .sn-render', { timeout: 10000 });
  await page.click('.sn-widget .sn-render');
  await page.waitForSelector('.sn-widget .sn-text', { timeout: 5000 });
  await page.fill('.sn-widget .sn-text', 'RESTOREME the salvia night');
  await page.locator('.sn-widget .sn-text').blur();
  await page.waitForTimeout(800);

  // API check: it's a LIVE sketch now (not in deleted list).
  const beforeDel = await page.evaluate(() => fetch('api/sketches/deleted').then(r => r.json()));
  check('not deleted before trash', !(beforeDel.sketches || []).some(v => /RESTOREME/.test(v.preview)));

  // Click the trash button → soft-delete + remove widget.
  await page.click('.sn-widget .sn-trash');
  await page.waitForTimeout(800);
  const widgetGone = await page.locator('.sn-widget').count();
  check('widget removed after trash', widgetGone === 0, String(widgetGone));

  // API check: now it IS in the deleted list.
  const afterDel = await page.evaluate(() => fetch('api/sketches/deleted').then(r => r.json()));
  const deletedRow = (afterDel.sketches || []).find(v => /RESTOREME/.test(v.preview));
  check('appears in deleted list after trash', !!deletedRow, JSON.stringify(afterDel.sketches && afterDel.sketches.map(v => v.preview)));
  check('deleted row carries deletion date', deletedRow && !!deletedRow.deleted_at, deletedRow && deletedRow.deleted_at);

  // Open the Snippet ▾ menu → Restore… and restore it.
  await page.click('.sn-btn'); // ⧉ Snippet ▾
  await page.waitForSelector('.sn-ins-restore', { timeout: 5000 });
  await page.click('.sn-ins-restore');
  await page.waitForSelector('.sn-ins-list button[data-vid]', { timeout: 5000 });
  const restoreBtn = page.locator(`.sn-ins-list button[data-vid="${varId}"]`);
  check('deleted sketch shown in Restore… picker', await restoreBtn.count() === 1);
  await restoreBtn.click();
  await page.waitForTimeout(800);

  // Widget re-inserted, and it's no longer in the deleted list.
  const backWidget = await page.locator('.sn-widget').count();
  check('widget re-inserted after restore', backWidget >= 1, String(backWidget));
  const afterRestore = await page.evaluate(() => fetch('api/sketches/deleted').then(r => r.json()));
  check('gone from deleted list after restore', !(afterRestore.sketches || []).some(v => /RESTOREME/.test(v.preview)));

  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
