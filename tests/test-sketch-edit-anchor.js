// REGRESSION ("click-to-edit loses my place on a long sketch"): the serif
// preview and the mono editor lay the same text out at very different
// heights, so pinning scrollTop alone let the clicked word drift ~1900px on
// a 6KB sketch. Entering edit must keep the CLICKED WORD at the same
// viewport y (paragraph+fraction anchor, restored via the metrics-identical
// overlay) and put the caret on it.
const { chromium } = require('playwright');
const { TEST_URL, loginAsTestUser } = require('./test-utils');
const HOME_URL = new URL('home.html', TEST_URL).href;
const JOINER = process.argv[2] === 'nn' ? '\n\n' : '\n\t';
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('dialog', d => d.accept());
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
  await page.evaluate((j) => { window.__joiner = j; }, JOINER);
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
    // BOTH paragraph styles must anchor: the-wildfire's indented \n\t (which
    // broke a paragraph-index mapping) and plain \n\n. The joiner comes from
    // the test harness via window.__joiner.
    await ed.variationApi.saveText(c.variation.variation_id, lines.join(window.__joiner || '\n\t'));
  });
  // (saveText is awaited inside the evaluate — the PUT has already landed;
  // the close below flushes the pad doc itself.)
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
  await scrollSettled(); // widget-mount holds expired
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
  await scrollSettled(); // let any holds expire; the scroll-set above stuck
  await page.mouse.click(before.x, before.y);
  await page.waitForSelector('.sn-widget textarea.sn-text', { timeout: 8000 });
  // autoGrow + holds settle: overlay mirrors the text, then the edit-entry
  // scroll hold expires and the position is stable.
  await page.waitForFunction(() => {
    const ov = document.querySelector('.sn-widget .sn-text-overlay');
    return ov && ov.textContent.includes('ZEBRAMARK');
  }, null, { timeout: 10000 });
  await scrollSettled();
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
