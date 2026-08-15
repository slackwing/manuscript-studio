// REGRESSION ("click-to-edit loses my place on a long sketch"): the serif
// preview and the mono editor lay the same text out at very different
// heights, so pinning scrollTop alone let the clicked word drift ~1900px on
// a 6KB sketch. Entering edit must keep the CLICKED WORD at the same
// viewport y (paragraph+fraction anchor, restored via the metrics-identical
// overlay) and put the caret on it.
const { chromium } = require('playwright');
const { TEST_URL, loginAsTestUser } = require('./test-utils');
const HOME_URL = new URL('home.html', TEST_URL).href;
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('dialog', d => d.accept());
  await loginAsTestUser(page);
  await page.goto(HOME_URL);
  await page.waitForSelector('#home-new-pad'); await page.click('#home-new-pad');
  await page.waitForSelector('.spm-overlay .ProseMirror');
  await page.locator('.spm-editor .ProseMirror').click();
  // LONG sketch (~6KB like the real one), ZEBRAMARK at ~75%
  await page.evaluate(async () => {
    const ed = window.WriteSysScratchpad;
    const c = await ed.insertSketch();
    const lines = [];
    const sent = 'The journal entry continues with long flowing prose that wraps across many lines when rendered, ';
    for (let i = 0; i < 24; i++) lines.push(i === 20
      ? sent.repeat(3) + 'and here sits the ZEBRAMARK word the reader clicked on, ' + sent.repeat(2)
      : sent.repeat(5) + `(paragraph ${i}).`);
    await ed.variationApi.saveText(c.variation.variation_id, lines.join('\n\n'));
  });
  await page.waitForTimeout(2200); // save settles
  // Reopen the pad so the widget loads the API-saved text fresh.
  const padId = await page.evaluate(() => window.WriteSysScratchpad.scratchpadId);
  await page.click('#spm-close');
  await page.waitForSelector('.spm-overlay', { state: 'detached', timeout: 10000 });
  await page.evaluate((id) => window.WriteSysScratchpadModal.open(id), padId);
  await page.waitForSelector('.spm-overlay .ProseMirror', { timeout: 10000 });
  await page.waitForFunction(() => {
    const r = document.querySelector('.sn-widget .sn-render');
    return r && r.shadowRoot && r.shadowRoot.querySelector('.scratch-book') &&
      r.shadowRoot.textContent.includes('ZEBRAMARK');
  }, null, { timeout: 10000 });
  await page.waitForTimeout(800);
  // find ZEBRAMARK in the shadow render, scroll it to mid-viewport
  const before = await page.evaluate(() => {
    const host = document.querySelector('.spm-editor');
    const render = document.querySelector('.sn-widget .sn-render');
    const book = render.shadowRoot.querySelector('.scratch-book');
    const walker = document.createTreeWalker(book, NodeFilter.SHOW_TEXT);
    let node; let range = null;
    while ((node = walker.nextNode())) {
      const i = node.textContent.indexOf('ZEBRAMARK');
      if (i >= 0) { range = document.createRange(); range.setStart(node, i); range.setEnd(node, i + 9); break; }
    }
    const r = range.getBoundingClientRect();
    host.scrollTop += r.top - host.getBoundingClientRect().top - 400; // put it ~mid
    const r2 = range.getBoundingClientRect();
    return { x: r2.left + 20, y: r2.top + 6, scrollTop: Math.round(host.scrollTop) };
  });
  await page.waitForTimeout(900); // let any holds expire
  await page.mouse.click(before.x, before.y);
  await page.waitForSelector('.sn-widget textarea.sn-text', { timeout: 8000 });
  await page.waitForTimeout(900); // autoGrow + holds settle
  const after = await page.evaluate(() => {
    const host = document.querySelector('.spm-editor');
    const ov = document.querySelector('.sn-widget .sn-text-overlay');
    // overlay mirrors the textarea text with IDENTICAL metrics
    const walker = document.createTreeWalker(ov, NodeFilter.SHOW_TEXT);
    let node; let range = null;
    while ((node = walker.nextNode())) {
      const i = node.textContent.indexOf('ZEBRAMARK');
      if (i >= 0) { range = document.createRange(); range.setStart(node, i); range.setEnd(node, i + 9); break; }
    }
    const r = range ? range.getBoundingClientRect() : null;
    return { y: r && Math.round(r.top), scrollTop: Math.round(host.scrollTop),
      inView: r && r.top > 0 && r.top < 900 };
  });
  const shift = after.y - Math.round(before.y);
  let failed = false;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed = true; };
  check('clicked word stays at the same viewport height (±40px)', Math.abs(shift) <= 40, `shift=${shift}px`);
  check('clicked word still in view', !!after.inView);
  const caretNear = await page.evaluate(() => {
    const ta = document.querySelector('.sn-widget textarea.sn-text');
    const i = ta.value.indexOf('ZEBRAMARK');
    return { caret: ta.selectionStart, mark: i, within: Math.abs(ta.selectionStart - i) < 400 };
  });
  check('caret lands near the clicked word (same paragraph)', caretNear.within, JSON.stringify(caretNear));
  await page.evaluate(async () => {
    const id = window.WriteSysScratchpad && window.WriteSysScratchpad.scratchpadId;
    if (id) await fetch('api/scratchpads/' + id, { method: 'DELETE', credentials: 'same-origin',
      headers: { 'X-CSRF-Token': localStorage.getItem('csrf_token') } });
  });
  console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS');
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('Test crashed:', e); process.exit(1); });
