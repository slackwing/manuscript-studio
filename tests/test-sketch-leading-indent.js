// A sketch whose variation text STARTS with a Tab renders its first paragraph
// indented (class "indented") — a sketch is often a mid-chapter excerpt, so
// a leading indent is meaningful. Without the leading Tab, the first paragraph
// stays flush (book convention). Display-only: the stored text keeps the \t.
const { chromium } = require('playwright');
const { TEST_URL, loginAsTestUser } = require('./test-utils');
const HOME_URL = new URL('home.html', TEST_URL).href;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  page.on('dialog', d => d.accept());
  let failed = false;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed = true; };

  await loginAsTestUser(page);
  await page.goto(HOME_URL);
  await page.waitForSelector('.card-ghost[data-ghost="scratchpad"]'); await page.click('.card-ghost[data-ghost="scratchpad"]');
  await page.waitForSelector('.spm-overlay .ProseMirror');
  await page.locator('.spm-editor .ProseMirror').click();

  await page.evaluate(() => window.WriteSysScratchpad.insertSketch());
  await page.waitForSelector('.spm-editor .sn-widget .sn-render');

  // Enter edit and type: Tab first (the editor's Tab handler inserts a real
  // \t), then two paragraphs separated by a \n\t break.
  await page.locator('.sn-widget .sn-render').click();
  const ta = page.locator('.sn-widget textarea');
  await ta.waitFor();
  await page.keyboard.press('Tab');
  await page.keyboard.type('First paragraph, mid-chapter, so it is indented.');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await page.keyboard.type('Second paragraph, indented as usual.');
  // Leave edit → preview renders (Escape exits the edit only).
  await page.keyboard.press('Escape');
  await page.waitForSelector('.sn-widget .sn-render');
  // Save + preview settle, event-driven: the preview shows the FULL typed
  // text only after the blur-flush PUT resolves (onSaved updates the ctx and
  // re-renders) — so this condition also guarantees the server has the text
  // for the stored-text check below.
  await page.waitForFunction(() => {
    const r = document.querySelector('.sn-widget .sn-render');
    return r && r.shadowRoot
      && r.shadowRoot.querySelectorAll('.scratch-book p').length === 2
      && r.shadowRoot.textContent.includes('Second paragraph, indented as usual.');
  }, null, { timeout: 15000 });

  const withTab = await page.evaluate(() => {
    const host = document.querySelector('.sn-widget .sn-render');
    const ps = host.shadowRoot.querySelectorAll('.scratch-book p');
    return { n: ps.length, classes: [...ps].map(p => p.className) };
  });
  check('both paragraphs render', withTab.n === 2, JSON.stringify(withTab));
  check('leading-Tab first paragraph is indented', withTab.classes[0] === 'indented', JSON.stringify(withTab.classes));
  check('second paragraph indented as usual', withTab.classes[1] === 'indented', JSON.stringify(withTab.classes));

  // Stored text keeps the literal leading \t (display-only transform).
  const stored = await page.evaluate(async () => {
    const ed = window.WriteSysScratchpad;
    const vid = parseInt(document.querySelector('.sn-widget').dataset.variationId, 10);
    const ctx = await ed.variationApi.context(vid);
    return ctx.variation.text;
  });
  check('stored variation text keeps the leading tab', stored.startsWith('\t'), JSON.stringify(stored.slice(0, 12)));

  // Control: a sketch WITHOUT a leading Tab stays flush.
  await page.evaluate(() => {
    const view = window.WriteSysScratchpad.view;
    const Sel = view.state.selection.constructor;
    const sc = view.state.schema;
    view.dispatch(view.state.tr.insert(view.state.doc.content.size, sc.nodes.paragraph.create()));
    view.dispatch(view.state.tr.setSelection(Sel.near(view.state.doc.resolve(view.state.doc.content.size), -1)));
    view.focus();
  });
  await page.evaluate(() => window.WriteSysScratchpad.insertSketch());
  await page.waitForFunction(() =>
    document.querySelectorAll('.spm-editor .sn-widget .sn-render').length === 2,
  null, { timeout: 15000 }); // second widget's ctx loaded, preview up
  const w2 = page.locator('.spm-editor .sn-widget').last();
  await w2.locator('.sn-render').click();
  await w2.locator('textarea').waitFor();
  await page.keyboard.type('Opening paragraph, flush left.');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await page.keyboard.type('Second paragraph, indented.');
  await page.keyboard.press('Escape');
  // Same event-driven settle as above, on the SECOND widget's preview.
  await page.waitForFunction(() => {
    const hosts = document.querySelectorAll('.spm-editor .sn-widget .sn-render');
    const h = hosts[hosts.length - 1];
    return hosts.length === 2 && h.shadowRoot
      && h.shadowRoot.textContent.includes('Second paragraph, indented.');
  }, null, { timeout: 15000 });

  const noTab = await page.evaluate(() => {
    const hosts = document.querySelectorAll('.sn-widget .sn-render');
    const host = hosts[hosts.length - 1];
    const ps = host.shadowRoot.querySelectorAll('.scratch-book p');
    return [...ps].map(p => p.className);
  });
  check('no leading Tab → first paragraph flush', noTab[0] === '', JSON.stringify(noTab));

  console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS');
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('Test crashed:', e); process.exit(1); });
