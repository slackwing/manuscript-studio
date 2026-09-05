/**
 * Sketch editor literal-editing behaviors: Tab inserts \t (Shift-Tab escapes),
 * auto-grow (no internal scroll), and the grey → tab-marker overlay aligns with
 * the textarea's tabs. Drives the real scratchpad modal on dev.
 */
const { chromium } = require('playwright');
const { TEST_URL, BASE_URL, cleanupTestAnnotations, loginAsTestUser } = require('./test-utils');
const HOME_URL = new URL('home.html', TEST_URL).href;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  let failed = false;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed = true; };

  await cleanupTestAnnotations();
  await loginAsTestUser(page);
  await page.goto(HOME_URL);
  // Create a pad (opens the modal), insert a sketch, flip into the editor.
  await page.waitForSelector('.card-ghost[data-ghost="scratchpad"]', { timeout: 20000 });
  await page.click('.card-ghost[data-ghost="scratchpad"]');
  await page.waitForSelector('.spm-overlay .ProseMirror', { timeout: 20000 });
  await page.evaluate(() => window.WriteSysScratchpad.insertSketch());
  await page.waitForSelector('.sn-widget .sn-render', { timeout: 10000 });
  await page.click('.sn-widget .sn-render');
  await page.waitForSelector('.sn-widget .sn-text', { timeout: 5000 });
  const ta = page.locator('.sn-widget .sn-text').first();

  // 1. Tab inserts a real \t at the caret (not focus change).
  await ta.click();
  await ta.fill('east coasters');
  await ta.press('End');
  await ta.press('Enter');
  await ta.press('Tab');
  await ta.type('yeah well adrian');
  const val = await ta.inputValue();
  check('Tab inserts \\t (\\n\\t present)', val.includes('east coasters\n\tyeah well adrian'), JSON.stringify(val));

  // 2. Shift-Tab escapes (blurs the textarea).
  await ta.press('Shift+Tab');
  await page.waitForTimeout(200);
  const stillFocused = await page.evaluate(() => document.activeElement && document.activeElement.classList.contains('sn-text'));
  check('Shift+Tab escapes the field', stillFocused === false);

  // Re-enter edit for geometry checks.
  await page.click('.sn-widget .sn-render');
  await page.waitForSelector('.sn-widget .sn-text', { timeout: 5000 });
  const ta2 = page.locator('.sn-widget .sn-text').first();

  // 3. Never scrolls internally: scrollHeight <= clientHeight (auto-grown).
  const geo = await ta2.evaluate(el => ({ sh: el.scrollHeight, ch: el.clientHeight, overflow: getComputedStyle(el).overflowY }));
  check('editor auto-grew (no internal scroll)', geo.sh <= geo.ch + 2, JSON.stringify(geo));

  // 4. Overlay renders a → marker per tab, and aligns near the textarea tab.
  const overlay = await page.evaluate(() => {
    const o = document.querySelector('.sn-widget .sn-text-overlay');
    if (!o) return null;
    const tabs = o.querySelectorAll('.sn-tab');
    const before = tabs.length ? getComputedStyle(tabs[0], '::before').content : '';
    return { markers: tabs.length, arrow: before };
  });
  check('overlay has a tab marker', overlay && overlay.markers >= 1, JSON.stringify(overlay));
  check('marker draws → glyph', overlay && /→|2192|→/.test(overlay.arrow), JSON.stringify(overlay && overlay.arrow));

  // 4. Copy-reference → "From clipboard" round trip. The widget's copy
  //    button (right of freeze) writes ms-variation:<id>; the ⧉ Sketch menu's
  //    "From clipboard" option enables only for a VALID copied reference
  //    and mints a related sibling variation.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE_URL });
  const copyBtn = page.locator('.sn-widget .sn-copyref').first();
  check('copy button present (right of freeze)', (await copyBtn.count()) === 1);
  const order = await page.evaluate(() => {
    const kids = Array.from(document.querySelectorAll('.sn-widget .sn-actions > *')).map(e => e.className);
    return { freeze: kids.findIndex(c => /sn-freeze/.test(c)), copy: kids.findIndex(c => /sn-copyref/.test(c)) };
  });
  check('copy right after freeze (sparkles after copy)', order.copy === order.freeze + 1, JSON.stringify(order));
  await copyBtn.click();
  await page.waitForSelector('.sn-copyref.sn-copied', { timeout: 4000 }); // write is async
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  const variationId = await page.evaluate(() => document.querySelector('.sn-widget').dataset.variationId);
  check('copies ms-variation:<id>', clip === `ms-variation:${variationId}`, clip);

  // 2026-08-23: the menu NEVER reads the clipboard (Firefox's paste prompt
  // was stealing the menu's first click) — the in-app copy record is the
  // source of truth, so junk in the OS clipboard doesn't disable it.
  await page.evaluate(() => navigator.clipboard.writeText('just some prose'));
  await page.locator('.sn-btn', { hasText: 'Sketch' }).dispatchEvent('mousedown');
  await page.waitForSelector('.sn-insertpop .sn-ins-clip');
  await page.waitForSelector('.sn-insertpop .sn-ins-clip:not([disabled])', { timeout: 8000 });
  check('From clipboard follows the in-app copy record (clipboard never read)', true);
  // Toggle the menu closed with the real button, then reopen fresh.
  await page.locator('.sn-btn', { hasText: 'Sketch' }).dispatchEvent('mousedown');
  await page.waitForSelector('.sn-insertpop', { state: 'hidden' });

  // With a valid reference it enables, and clicking mints a sibling.
  await page.evaluate((t) => navigator.clipboard.writeText(t), `ms-variation:${variationId}`);
  await page.locator('.sn-btn', { hasText: 'Sketch' }).dispatchEvent('mousedown');
  await page.waitForSelector('.sn-insertpop .sn-ins-clip');
  await page.waitForFunction(() => {
    const b = document.querySelector('.sn-ins-clip');
    return b && !b.disabled;
  }, { timeout: 8000 });
  check('From clipboard enables for a valid reference', true);
  const widgetsBefore = await page.locator('.sn-widget').count();
  await page.locator('.sn-ins-clip').click();
  await page.waitForFunction((n) => document.querySelectorAll('.sn-widget').length === n + 1, widgetsBefore, { timeout: 10000 });
  check('clicking it inserts a related sibling variation', true);
  // Rail buttons render after the new widget's ctx fetch — wait, don't count.
  const gotRail = await page.waitForFunction(
    () => document.querySelectorAll('.sn-widget .sn-rail-btn').length >= 2,
    null, { timeout: 10000 }).then(() => true).catch(() => false);
  check('new widget shows the sibling rail', gotRail,
    gotRail ? '' : `rail buttons=${await page.locator('.sn-widget .sn-rail-btn').count()}`);

  // 5. The sketch's NOTE (026): a colored square — the same component that
  //    fronts highlighted text — sits top-left of the widget; clicking opens
  //    the note float (no trash, derived unremovable "sketch" chip).
  const sq = page.locator('.sn-widget .sn-note-solo').first();
  check('note square present in the widget header', (await sq.count()) === 1);
  const sqBeforeStatus = await page.evaluate(() => {
    // Identity content lives inside the shell's header slot now.
    const kids = Array.from(document.querySelectorAll('.sn-widget .pw-head-slot > *'));
    const si = kids.findIndex(k => k.classList.contains('sn-note-solo'));
    const st = kids.findIndex(k => k.classList.contains('sn-status'));
    return { si, st };
  });
  check('square sits left of SKETCH status', sqBeforeStatus.si === sqBeforeStatus.st - 1, JSON.stringify(sqBeforeStatus));
  const ctxNote = await page.evaluate(async () => {
    const id = document.querySelector('.sn-widget').dataset.variationId;
    const r = await fetch(`api/variations/${id}`, { credentials: 'include' });
    return (await r.json()).note || null;
  });
  check('variation context embeds the sketch note', !!ctxNote && ctxNote.note_id > 0 && ctxNote.color === 'yellow', JSON.stringify(ctxNote));

  await sq.dispatchEvent('mousedown');
  await page.waitForSelector('.sn-note-float .sticky-note', { timeout: 10000 });
  check('clicking the square opens the note float', true);
  check('sketch note has NO trash (lives with the sketch)', (await page.locator('.sn-note-float .note-trash').count()) === 0);
  const snipChip = page.locator('.sn-note-float .tag-chip.sketch-chip');
  check('derived "sketch" chip present', (await snipChip.count()) === 1);
  check('sketch chip is unremovable (no ×)', (await page.locator('.sn-note-float .tag-chip.sketch-chip .tag-chip-remove').count()) === 0);

  // Typing in the float SAVES (sketch notes are versionless — the update
  // once 500'd on their empty note_version history).
  await page.locator('.sn-note-float .note-input').click();
  await page.keyboard.type('Sketch note body from the square.');
  // Condition-wait on the debounced save landing in the DB (no fixed sleep).
  const { execSync: exq } = require('child_process');
  const readBody = () => exq(
    `PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "SELECT coalesce(body,'(null)') FROM note WHERE note_id=${ctxNote.note_id}"`,
    { encoding: 'utf-8' }).trim();
  let savedBody = '';
  for (let i = 0; i < 40 && !/Sketch note body from the square/.test(savedBody); i++) {
    await page.waitForTimeout(250);
    savedBody = readBody();
  }
  check('typed note body persists to the DB', /Sketch note body from the square/.test(savedBody), savedBody);

  // Make it a task (type dropdown), complete it → the square turns into
  // the green check.
  await page.locator('.sn-note-float .dim-chip.dim-type').click();
  await page.waitForSelector('.dim-pop button[data-v="edit"]');
  await page.locator('.dim-pop button[data-v="edit"]').click();
  await page.waitForTimeout(400);
  const fcheck = page.locator('.sn-note-float .complete-check');
  await fcheck.click();
  await page.waitForTimeout(150);
  await fcheck.click();
  await page.waitForSelector('.sn-widget .sn-note-solo.sn-note-done', { timeout: 8000 });
  check('completing the sketch note turns the square into a green check', true);

  // 6. Copy-ref on a SUPERSEDED variation with an UNREADABLE clipboard
  //    (real-world Firefox refuses programmatic reads): the copy button's
  //    in-app record makes "From clipboard" work anyway.
  // (Dismiss the note float by clicking back into the editor — Escape
  // would close the whole modal.)
  await page.locator('.spm-editor .ProseMirror').click({ position: { x: 10, y: 10 }, force: true });
  await page.waitForTimeout(300);
  const supId = await page.evaluate(async () => {
    const ed = window.WriteSysScratchpad;
    const a = await ed.insertSketch();
    await ed.variationApi.saveText(a.variation.variation_id, 'superseded clipboard source');
    return a.variation.variation_id;
  });
  await page.waitForTimeout(700);
  // Supersede through the widget's own button so the widget re-renders
  // into its superseded (read-only) look — the state the user acts on.
  const supWidget = page.locator(`.sn-widget[data-variation-id="${supId}"]`);
  await supWidget.locator('.sn-supersede').click();
  await page.waitForSelector(`.sn-widget[data-variation-id="${supId}"].sn-state-superseded`, { timeout: 6000 });
  check('superseded widget still shows the copy button', await supWidget.locator('.sn-copyref').isVisible());
  await supWidget.locator('.sn-copyref').click();
  await page.waitForTimeout(300);
  check('in-app record of the copied reference', await page.evaluate(() =>
    localStorage.getItem('ms_last_variation_ref')) === String(supId));
  // The harshest Firefox behavior: readText neither resolves nor rejects
  // (prompt pending). The timeout race must hand over to the fallback.
  await page.evaluate(() => {
    navigator.clipboard.readText = () => new Promise(() => {});
  });
  await page.locator('#spm-toolbar button', { hasText: 'Sketch' }).first().click();
  await page.waitForSelector('.sn-insertpop .sn-ins-clip');
  check('spinner shows while the check runs', await page.locator('.sn-ins-clip .sn-clip-spin').count() === 1);
  // The 700ms timeout race hands over to the in-app record → enabled.
  await page.waitForSelector('.sn-ins-clip:not([disabled])', { timeout: 6000 });
  check('spinner gone once settled', await page.locator('.sn-ins-clip .sn-clip-spin').count() === 0);
  check('From clipboard enabled via fallback (clipboard unreadable)', true);
  const widgetsBeforeSup = await page.locator('.sn-widget').count();
  await page.locator('.sn-ins-clip').click();
  await page.waitForFunction((n) => document.querySelectorAll('.sn-widget').length === n + 1,
    widgetsBeforeSup, { timeout: 8000 });
  check('creates a sibling from the superseded source', true);

  const fs = require('fs');
  if (!fs.existsSync('tests/screenshots')) fs.mkdirSync('tests/screenshots', { recursive: true });
  await page.screenshot({ path: 'tests/screenshots/sketch-editor.png' });
  console.log('📸 tests/screenshots/sketch-editor.png');

  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
