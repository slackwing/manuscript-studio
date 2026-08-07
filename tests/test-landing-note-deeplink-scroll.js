// REGRESSION: clicking a note card on the landing page must open its
// scratchpad AND actually land on the note — even while snippet widgets are
// still loading/growing during the scroll (API latency is injected to force
// that). Broke once when a shared scroll hold kept re-arming with a stale base
// during widget builds, yanking the settle-scroll back to the top.
const { chromium } = require('playwright');
const { TEST_URL, cleanupTestNotes, loginAsTestUser } = require('./test-utils');
const HOME_URL = new URL('home.html', TEST_URL).href;

const LATENCY_MS = 300; // widgets must straggle in while the settle-scroll runs

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('dialog', d => d.accept());
  let failed = false;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed = true; };

  await cleanupTestNotes();
  await loginAsTestUser(page);
  await page.goto(HOME_URL);
  await page.waitForSelector('#home-new-pad'); await page.click('#home-new-pad');
  await page.waitForSelector('.spm-overlay .ProseMirror');
  await page.locator('.spm-editor .ProseMirror').click();

  // Long pad: prose + snippets WITH TEXT above the note, so on reopen the
  // widgets mount async and grow, shifting the note's position while the
  // deep-link scroll is settling. Note goes near the BOTTOM.
  const focusEnd = () => page.evaluate(() => {
    const view = window.WriteSysScratchpad.view;
    const sc = view.state.schema;
    view.dispatch(view.state.tr.insert(view.state.doc.content.size, sc.nodes.paragraph.create()));
    const Sel = view.state.selection.constructor;
    view.dispatch(view.state.tr.setSelection(Sel.near(view.state.doc.resolve(view.state.doc.content.size), -1)));
    view.focus();
  });
  for (let k = 0; k < 3; k++) {
    await focusEnd();
    await page.keyboard.type(`Section ${k} of the deep-link scroll pad. `);
    await page.keyboard.press('Enter');
    await page.evaluate(async () => {
      const ed = window.WriteSysScratchpad;
      const ctx = await ed.insertSnippet();
      await ed.variationApi.saveText(ctx.variation.variation_id,
        Array.from({ length: 40 }, (_, i) => `Widget filler line ${i}.`).join('\n\n'));
    });
  }
  await focusEnd();
  for (let i = 0; i < 6; i++) { await page.keyboard.type(`Closing prose paragraph ${i} before the note. `); await page.keyboard.press('Enter'); }
  await page.keyboard.type('DEEPLINK TARGET note text lives here at the bottom. ');
  await page.waitForTimeout(300);

  // Note on "TARGET" (bottom of the pad).
  const noteId = await page.evaluate(async () => {
    const view = window.WriteSysScratchpad.view;
    let found = null;
    view.state.doc.descendants((node, pos) => {
      if (node.isText && node.text.includes('TARGET')) found = { from: pos + node.text.indexOf('TARGET'), to: pos + node.text.indexOf('TARGET') + 6 };
    });
    const Sel = view.state.selection.constructor;
    view.dispatch(view.state.tr.setSelection(Sel.create(view.state.doc, found.from, found.to)));
    view.focus();
    return null;
  }).then(async () => {
    await page.waitForTimeout(250);
    await page.locator('.sn-note-colorbar .sn-note-colorbtn').first().click();
    await page.waitForTimeout(900);
    return page.evaluate(() => {
      const ref = document.querySelector('.spm-editor .ProseMirror .sn-note-ref');
      return ref && parseInt(ref.dataset.noteId, 10);
    });
  });
  check('note created at the bottom of a long pad', !!noteId, `noteId=${noteId}`);

  // Close the float (click inside the editor) then the pad; wait for saves.
  const ebox = await page.locator('.spm-editor').boundingBox();
  await page.mouse.click(ebox.x + ebox.width / 2, ebox.y + 40);
  await page.waitForTimeout(1600);
  await page.click('#spm-close');
  await page.waitForSelector('.spm-overlay', { state: 'detached', timeout: 10000 });

  // Landing again, WITH latency so widget loads straggle during the settle.
  await page.route('**/api/**', async (route) => {
    await new Promise(r => setTimeout(r, LATENCY_MS));
    await route.continue();
  });
  await page.goto(HOME_URL);
  const card = page.locator(`.card-note[data-note-id="${noteId}"]`);
  await card.waitFor({ timeout: 10000 });
  check('note card appears on the landing page', true);

  await card.click();
  await page.waitForSelector('.spm-overlay .ProseMirror', { timeout: 15000 });

  // The settle-scroll retries while widgets load; give it the full window,
  // then require the note ref to sit INSIDE the visible editor viewport.
  const landed = await page.waitForFunction((nid) => {
    const host = document.querySelector('.spm-editor');
    const ref = document.querySelector(`.sn-note-ref[data-note-id="${nid}"]`);
    if (!host || !ref) return false;
    const h = host.getBoundingClientRect();
    const r = ref.getBoundingClientRect();
    return r.top >= h.top && r.bottom <= h.bottom;
  }, noteId, { timeout: 15000 }).then(() => true).catch(() => false);
  check('deep link scrolls TO the note (ref inside the viewport)', landed);

  // And it STAYS there: no late widget build may yank the view away.
  await page.waitForTimeout(2500);
  const stillThere = await page.evaluate((nid) => {
    const host = document.querySelector('.spm-editor');
    const ref = document.querySelector(`.sn-note-ref[data-note-id="${nid}"]`);
    if (!host || !ref) return false;
    const h = host.getBoundingClientRect();
    const r = ref.getBoundingClientRect();
    return r.top >= h.top && r.bottom <= h.bottom;
  }, noteId);
  check('view stays on the note after widgets finish loading', stillThere);

  await cleanupTestNotes();
  console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS');
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('Test crashed:', e); process.exit(1); });
