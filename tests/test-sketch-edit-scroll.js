// REGRESSION (the long-standing "one of the clicks sends me back to the top"):
// with ProseMirror's selection far away — at doc START, as after opening a pad
// and wheel-scrolling down without clicking prose — clicking a sketch preview
// to edit must NOT scroll the pad. Firefox restores/reveals PM's faraway DOM
// selection on the focus churn; the fix parks the PM selection beside the
// widget on renderEdit. Run with BROWSER=firefox to exercise the real engine
// (Chromium never exhibited the jump).
const pw = require('playwright');
const engine = pw[process.env.BROWSER || 'chromium'];
const { TEST_URL, loginAsTestUser } = require('./test-utils');
const HOME_URL = new URL('home.html', TEST_URL).href;

(async () => {
  const browser = await engine.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('dialog', d => d.accept());
  let failed = false;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed = true; };
  // Event-driven "scroll settled": no active scroll hold on the pad (the
  // flight recorder — scroll.mjs — exposes them via msScrollDiag.state())
  // AND scrollTop unchanged across 3 consecutive raf polls. (No Promise
  // predicates: waitForFunction treats a returned Promise object as truthy.)
  const scrollSettled = () => page.waitForFunction(() => {
    const h = document.querySelector('.spm-editor');
    const d = window.msScrollDiag;
    const held = !!(d && d.state().holds);
    const w = window.__settleProbe || (window.__settleProbe = { last: NaN, n: 0 });
    if (!h || held || h.scrollTop !== w.last) {
      w.last = h ? h.scrollTop : NaN;
      w.n = 0;
      return false;
    }
    if (++w.n >= 3) { window.__settleProbe = null; return true; }
    return false;
  }, null, { timeout: 15000, polling: 'raf' });

  await loginAsTestUser(page);
  await page.goto(HOME_URL);
  await page.waitForSelector('.card-ghost[data-ghost="scratchpad"]'); await page.click('.card-ghost[data-ghost="scratchpad"]');
  await page.waitForSelector('.spm-overlay .ProseMirror');
  await page.locator('.spm-editor .ProseMirror').click();

  await page.evaluate(async () => {
    const ed = window.WriteSysScratchpad;
    const view = ed.view; const sc = ed.schema;
    let tr = view.state.tr;
    for (let i = 0; i < 40; i++) tr = tr.insert(tr.doc.content.size, sc.nodes.paragraph.create(null, sc.text(`Paragraph ${i}: filler filler filler filler filler filler filler filler.`)));
    view.dispatch(tr);
    const Sel = view.state.selection.constructor;
    view.dispatch(view.state.tr.setSelection(Sel.near(view.state.doc.resolve(view.state.doc.content.size), -1)));
    await ed.insertSketch();
  });
  await page.waitForSelector('.sn-widget .sn-render'); // widget ctx loaded, preview up
  // Give the variation text THROUGH THE UI so the widget's ctx has it.
  await page.locator('.sn-widget .sn-render').last().click();
  await page.waitForSelector('.sn-widget textarea');
  // Registered BEFORE typing: the text lands via a PUT api/variations/<id>
  // (debounced autosave, or the blur-flush below) — wait on that response.
  const savePut = page.waitForResponse((r) => r.request().method() === 'PUT'
    && /\/api\/variations\/\d+$/.test(r.url()) && r.ok(), { timeout: 15000 });
  await page.keyboard.type('bottom sketch text for editing here and more words to fill');
  // Blur WITHOUT giving ProseMirror focus (click the widget's own header) —
  // the jump only reproduces when PM is unfocused while its selection sits
  // far away, so the DOM-selection reveal happens later, on entering edit.
  await page.locator('.sn-widget .sn-header').last().click({ position: { x: 40, y: 8 } });
  // The blur-flush save must LAND before the freeze cycle below (its
  // refresh re-fetches the ctx from the server), and the widget must be
  // back in preview.
  await savePut;
  await page.waitForSelector('.sn-widget .sn-render');
  // A freeze toggle cycle rebuilds the widget with focus on its button
  // (matches the reproduction sequence).
  // (The status reads just "Sketch X" now — state shows via the pressed
  // freeze button, so wait on that.)
  await page.locator('.sn-widget .sn-freeze').last().click();
  await page.waitForFunction(() => {
    const b = [...document.querySelectorAll('.sn-widget .sn-freeze')].pop();
    return b && b.classList.contains('pw-on');
  }, null, { timeout: 10000 });
  await page.locator('.sn-widget .sn-freeze').last().click();
  await page.waitForFunction(() => {
    const b = [...document.querySelectorAll('.sn-widget .sn-freeze')].pop();
    return b && !b.classList.contains('pw-on');
  }, null, { timeout: 10000 });
  await scrollSettled(); // rebuild's scroll hold expired

  // PM selection at DOC START; reader scrolled to the bottom by wheel.
  await page.evaluate(() => {
    const view = window.WriteSysScratchpad.view;
    const Sel = view.state.selection.constructor;
    view.dispatch(view.state.tr.setSelection(Sel.near(view.state.doc.resolve(0), 1)));
  });
  // Set-and-verify: put the scroll at the TRUE bottom and require it to
  // STAY there for 3 consecutive raf polls (an active hold or a pending
  // scroll-anchoring adjustment would move it — re-set and retry until it
  // sticks).
  await page.waitForFunction(() => {
    const h = document.querySelector('.spm-editor');
    const want = h.scrollHeight - h.clientHeight;
    const w = window.__pinProbe || (window.__pinProbe = { n: 0 });
    if (Math.abs(h.scrollTop - want) > 1) {
      h.scrollTop = h.scrollHeight;
      w.n = 0;
      return false;
    }
    if (++w.n >= 3) { window.__pinProbe = null; return true; }
    return false;
  }, null, { timeout: 15000, polling: 'raf' });
  const before = await page.evaluate(() => document.querySelector('.spm-editor').scrollTop);

  await page.locator('.sn-widget .sn-render').last().click(); // → edit
  await scrollSettled(); // well past any scroll pin (hold expired, position stable)
  const after = await page.evaluate(() => document.querySelector('.spm-editor').scrollTop);
  check('entering edit does NOT scroll the pad (selection was at doc top)',
    after > before - 300, `before=${before} after=${after}`);
  // (When the jump bug fires, the click lands mid-scroll and edit mode may
  // never open — assert it did.)
  check('the click actually entered edit mode',
    await page.locator('.sn-widget textarea').count() === 1);

  // Clicks inside the textarea keep the view put too.
  if (await page.locator('.sn-widget textarea').count() === 0) {
    console.log('\nRESULT: FAIL');
    await browser.close();
    process.exit(1);
  }
  const box = await page.locator('.sn-widget textarea').boundingBox();
  await page.mouse.click(box.x + 80, box.y + 15);
  await scrollSettled();
  await page.mouse.click(box.x + 150, box.y + 15);
  await scrollSettled();
  const after2 = await page.evaluate(() => document.querySelector('.spm-editor').scrollTop);
  check('caret clicks in the textarea do not scroll the pad',
    after2 > before - 300, `top=${after2}`);
  const sel = await page.evaluate(() => document.querySelector('.sn-widget textarea').selectionStart);
  check('and the caret actually moved', sel > 0 && sel < 59, `sel=${sel}`);

  // REGRESSION ("typing yanks the scroll up"): scrolled to the pad BOTTOM,
  // every keystroke ran autoGrow's height='auto' collapse, momentarily
  // shrinking the pad and CLAMPING scrollTop up. Type at the end of the
  // textarea while pinned to the bottom — the scroll must not move.
  await page.evaluate(() => {
    const ta = document.querySelector('.sn-widget textarea');
    // TALL sketch: the collapse-to-'auto' only shrinks past the rows-attr
    // floor, so the bug needs real height to give up.
    ta.value += '\n' + Array.from({ length: 50 }, (_, i) => `sketch line ${i}`).join('\n');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
  // Let the ~900px growth settle (scroll anchoring compensates for it on the
  // next layout — pinning the bottom in the SAME breath as the growth left
  // that compensation pending, and the first keystroke would fire it,
  // yanking the pad up by exactly the growth)...
  await scrollSettled();
  // ...then, on clean layout, put the caret at the end and pin the pad to
  // the TRUE bottom (want computed independently of the set — a pending
  // scroll-anchoring adjustment can apply inside the assignment itself and
  // bless a short landing). Re-set and retry until it holds 3 raf polls.
  await page.waitForFunction(() => {
    const h = document.querySelector('.spm-editor');
    const ta = document.querySelector('.sn-widget textarea');
    const want = h.scrollHeight - h.clientHeight;
    const w = window.__pinProbe || (window.__pinProbe = { n: 0 });
    if (Math.abs(h.scrollTop - want) > 1) {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      h.scrollTop = h.scrollHeight;
      w.n = 0;
      return false;
    }
    if (++w.n >= 3) { window.__pinProbe = null; return true; }
    return false;
  }, null, { timeout: 15000, polling: 'raf' });
  const bottomBefore = await page.evaluate(() => document.querySelector('.spm-editor').scrollTop);
  for (const ch of 'typing at the bottom') {
    await page.keyboard.type(ch);
    await page.waitForTimeout(15);
  }
  const bottomAfter = await page.evaluate(() => document.querySelector('.spm-editor').scrollTop);
  check('typing at the pad bottom does not move the scroll',
    Math.abs(bottomAfter - bottomBefore) <= 4, `before=${bottomBefore} after=${bottomAfter}`);

  console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS');
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('Test crashed:', e); process.exit(1); });
