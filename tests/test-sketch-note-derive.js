/**
 * 050: a sketch's note body is DERIVED from the sketch — its first prose
 * sentence, same segmenter as the manuscript — refreshed on every save of
 * the sketch until the owner types their own note. Drives the real pad
 * modal: type in the sketch, open the note square's float, read the body.
 * SHOT_DIR=<dir> also saves screenshots of the float (desktop + phone).
 */
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const { TEST_URL, cleanupTestAnnotations, loginAsTestUser } = require('./test-utils');
const HOME_URL = new URL('home.html', TEST_URL).href;
const psql = (sql) => execSync(
  `PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`,
  { encoding: 'utf8' }).trim();

(async () => {
  console.log('=== Sketch note derive (050) ===\n');
  const browser = await chromium.launch();
  let failed = 0;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed++; };
  const shot = async (page, name) => {
    if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/${name}.png` });
  };
  const until = async (fn, want, tries = 60) => {
    let v;
    for (let i = 0; i < tries; i++) { v = fn(); if (v === want) return v; await new Promise(r => setTimeout(r, 250)); }
    return v;
  };

  for (const vp of [{ name: 'desktop', width: 1280, height: 1000 }, { name: 'phone', width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
    const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    try {
      await cleanupTestAnnotations();
      await loginAsTestUser(page);
      await page.goto(HOME_URL);
      await page.waitForSelector('.card-ghost[data-ghost="scratchpad"]', { timeout: 20000 });
      await page.click('.card-ghost[data-ghost="scratchpad"]');
      await page.waitForSelector('.spm-overlay .ProseMirror', { timeout: 20000 });
      const ctx = await page.evaluate(() => window.WriteSysScratchpad.insertSketch());
      const vid = ctx.variation.variation_id;
      const noteId = psql(`SELECT note_id FROM note WHERE sketch_id='${ctx.sketch.sketch_id}' AND deleted_at IS NULL`);
      const body = () => psql(`SELECT coalesce(body,'(null)') || '|' || CASE WHEN body_auto THEN 't' ELSE 'f' END FROM note WHERE note_id=${noteId}`);
      check(`[${vp.name}] fresh sketch note is empty + derived`, body() === '(null)|t', body());

      // Type into the sketch the way the author does. A click into the
      // sketch also closes any open note float (outside mousedown).
      const ta = page.locator(`.sn-widget[data-variation-id="${vid}"] .sn-text`);
      const editSketch = async () => {
        // Close an open float the way a tap elsewhere does (on a phone it
        // covers the sketch below its square).
        await page.evaluate(() => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
        if (!(await ta.isVisible())) await page.click(`.sn-widget[data-variation-id="${vid}"] .sn-render`);
        await ta.waitFor();
        await ta.click();
      };
      await editSketch();
      await page.keyboard.type('The tide was *out*. Gulls everywhere.');
      check(`[${vp.name}] saving the sketch derives the note body`,
        await until(body, 'The tide was out.|t') === 'The tide was out.|t', body());

      const sq = page.locator(`.sn-widget[data-variation-id="${vid}"] .sn-note-solo`);
      await sq.dispatchEvent('mousedown');
      await page.waitForSelector('.sn-note-float .sticky-note');
      check(`[${vp.name}] the float shows the derived body`,
        (await page.inputValue('.sn-note-float .note-input')) === 'The tide was out.');
      const w = await page.locator('.sn-note-float').evaluate(el => Math.round(el.getBoundingClientRect().width));
      check(`[${vp.name}] the float is the standard note width (232px)`, w === 232, `w=${w}`);
      await shot(page, `sketch-note-derived-${vp.name}`);

      // Close, edit the sketch's first sentence, reopen: fresh, not cached.
      await editSketch();
      check(`[${vp.name}] a tap outside closes the float`, (await page.locator('.sn-note-float').count()) === 0);
      await page.keyboard.press('Control+Home');
      await page.keyboard.type('Low ');
      check(`[${vp.name}] editing the first sentence re-derives`,
        await until(body, 'Low The tide was out.|t') === 'Low The tide was out.|t', body());
      await sq.dispatchEvent('mousedown');
      await page.waitForSelector('.sn-note-float .sticky-note');
      check(`[${vp.name}] reopened float reads the new body (not a stale cache)`,
        (await page.inputValue('.sn-note-float .note-input')) === 'Low The tide was out.');

      // The owner writes their own → it sticks.
      await page.fill('.sn-note-float .note-input', 'Rewrite the gulls.');
      await page.locator('.sn-note-float .note-input').dispatchEvent('blur');
      check(`[${vp.name}] a typed note is the owner's (body_auto off)`,
        await until(body, 'Rewrite the gulls.|f') === 'Rewrite the gulls.|f', body());
      await editSketch();
      await page.keyboard.press('Control+Home');
      await page.keyboard.type('Very ');
      await page.waitForTimeout(2500);
      check(`[${vp.name}] later sketch saves leave the owner's note alone`, body() === 'Rewrite the gulls.|f', body());
      check(`[${vp.name}] no page errors`, errs.length === 0, errs.join(' | '));
    } catch (e) {
      check(`[${vp.name}] run`, false, e.message);
    }
    await page.close();
  }
  await browser.close();
  console.log(failed ? `\n❌ ${failed} failed` : '\n✅ all passed');
  process.exit(failed ? 1 : 0);
})();
