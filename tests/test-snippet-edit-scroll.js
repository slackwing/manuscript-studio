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

  await loginAsTestUser(page);
  await page.goto(HOME_URL);
  await page.waitForSelector('#home-new-pad'); await page.click('#home-new-pad');
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
  await page.waitForTimeout(600);
  // Give the variation text THROUGH THE UI so the widget's ctx has it.
  await page.locator('.sn-widget .sn-render').last().click();
  await page.waitForSelector('.sn-widget textarea');
  await page.keyboard.type('bottom sketch text for editing here and more words to fill');
  // Blur WITHOUT giving ProseMirror focus (click the widget's own header) —
  // the jump only reproduces when PM is unfocused while its selection sits
  // far away, so the DOM-selection reveal happens later, on entering edit.
  await page.locator('.sn-widget .sn-header').last().click({ position: { x: 40, y: 8 } });
  await page.waitForTimeout(1200);
  // A freeze toggle cycle rebuilds the widget with focus on its button
  // (matches the reproduction sequence).
  // (The status reads just "Sketch X" now — state shows via the pressed
  // freeze button, so wait on that.)
  await page.locator('.sn-widget [data-act="freeze"]').last().click();
  await page.waitForFunction(() => {
    const b = [...document.querySelectorAll('.sn-widget [data-act="freeze"]')].pop();
    return b && b.classList.contains('pressed');
  }, null, { timeout: 10000 });
  await page.locator('.sn-widget [data-act="freeze"]').last().click();
  await page.waitForFunction(() => {
    const b = [...document.querySelectorAll('.sn-widget [data-act="freeze"]')].pop();
    return b && !b.classList.contains('pressed');
  }, null, { timeout: 10000 });
  await page.waitForTimeout(400);

  // PM selection at DOC START; reader scrolled to the bottom by wheel.
  await page.evaluate(() => {
    const view = window.WriteSysScratchpad.view;
    const Sel = view.state.selection.constructor;
    view.dispatch(view.state.tr.setSelection(Sel.near(view.state.doc.resolve(0), 1)));
  });
  await page.evaluate(() => { const h = document.querySelector('.spm-editor'); h.scrollTop = h.scrollHeight; });
  await page.waitForTimeout(400);
  const before = await page.evaluate(() => document.querySelector('.spm-editor').scrollTop);

  await page.locator('.sn-widget .sn-render').last().click(); // → edit
  await page.waitForTimeout(1400); // well past any scroll pin
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
  await page.waitForTimeout(700);
  await page.mouse.click(box.x + 150, box.y + 15);
  await page.waitForTimeout(700);
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
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    const h = document.querySelector('.spm-editor');
    h.scrollTop = h.scrollHeight;
  });
  await page.waitForTimeout(900); // past any scroll hold from the clicks above
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
