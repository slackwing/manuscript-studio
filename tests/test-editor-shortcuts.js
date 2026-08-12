// Scratchpad keyboard shortcuts:
//   Alt+D   → inserts today's date as "Saturday, August 1" (prose AND variation
//             textareas via the shared edit pane);
//   Ctrl+Alt+1-4 → headings H1-H4 (plain Alt+N = Firefox tab switching);
//   Ctrl+Shift+8/7/9 → bullet / numbered / blockquote (9 toggles: unquotes
//   when already inside a quote instead of nesting);
//   toolbar hints advertise the shortcuts.
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
  const wantDate = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  await loginAsTestUser(page);
  await page.goto(HOME_URL);
  await page.waitForSelector('#home-new-pad'); await page.click('#home-new-pad');
  await page.waitForSelector('.spm-overlay .ProseMirror');
  const pm = page.locator('.spm-editor .ProseMirror');
  await pm.click();

  // Alt+D in prose.
  await page.keyboard.press('Alt+KeyD');
  const text1 = await page.evaluate(() => window.WriteSysScratchpad.view.state.doc.textContent);
  check(`Alt+D types "${wantDate}" in prose`, text1.includes(wantDate), JSON.stringify(text1));

  // Ctrl+Alt+2 → H2 on the current block (plain Alt+N is Firefox's tab
  // switcher, so headers are Ctrl+Alt only).
  await page.keyboard.press('Control+Alt+2');
  let types = await page.evaluate(() => window.WriteSysScratchpad.view.state.doc.firstChild.type.name + ':' + (window.WriteSysScratchpad.view.state.doc.firstChild.attrs.level || ''));
  check('Ctrl+Alt+2 turns the block into H2', types === 'heading:2', types);
  await page.keyboard.press('Control+Alt+3');
  types = await page.evaluate(() => window.WriteSysScratchpad.view.state.doc.firstChild.type.name + ':' + (window.WriteSysScratchpad.view.state.doc.firstChild.attrs.level || ''));
  check('Ctrl+Alt+3 → H3', types === 'heading:3', types);

  // Lists / quote on a fresh paragraph.
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('items');
  await page.keyboard.press('Control+Shift+8');
  const hasUl = await page.evaluate(() => window.WriteSysScratchpad.view.state.doc.toString().includes('bullet_list'));
  check('Ctrl+Shift+8 wraps in a bullet list', hasUl);

  // Blockquote toggles: wrap once, then unquote — never quote-in-quote.
  // Enter twice exits the bullet list (second Enter lifts the empty item).
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('quoted');
  const quoteDepth = () => page.evaluate(() =>
    (window.WriteSysScratchpad.view.state.doc.toString().match(/blockquote\(/g) || []).length);
  await page.keyboard.press('Control+Shift+9');
  check('Ctrl+Shift+9 wraps in a blockquote', (await quoteDepth()) === 1, String(await quoteDepth()));
  await page.keyboard.press('Control+Shift+9');
  check('Ctrl+Shift+9 in a quote unquotes (no nesting)', (await quoteDepth()) === 0, String(await quoteDepth()));
  // The toolbar runs commands on mousedown (preventDefault keeps focus in
  // the editor), so the test fires mousedown rather than click.
  const quoteBtnToggles = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('#spm-toolbar button')].find(x => x.textContent.trim() === '❝');
    const depth = () => (window.WriteSysScratchpad.view.state.doc.toString().match(/blockquote\(/g) || []).length;
    const press = () => btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    press();
    const wrapped = depth();
    press();
    return { wrapped, after: depth() };
  });
  check('toolbar ❝ wraps then unquotes', quoteBtnToggles.wrapped === 1 && quoteBtnToggles.after === 0, JSON.stringify(quoteBtnToggles));

  // Alt+D inside a variation textarea (shared edit pane).
  await page.evaluate(async () => {
    const view = window.WriteSysScratchpad.view;
    const Sel = view.state.selection.constructor;
    const sc = view.state.schema;
    view.dispatch(view.state.tr.insert(view.state.doc.content.size, sc.nodes.paragraph.create()));
    view.dispatch(view.state.tr.setSelection(Sel.near(view.state.doc.resolve(view.state.doc.content.size), -1)));
    view.focus();
    await window.WriteSysScratchpad.insertSketch();
  });
  await page.waitForSelector('.sn-widget .sn-render');
  await page.waitForTimeout(300);
  await page.locator('.sn-widget .sn-render').last().click();
  await page.waitForSelector('.sn-widget textarea');
  await page.keyboard.type('date: ');
  await page.keyboard.press('Alt+KeyD');
  const taVal = await page.locator('.sn-widget textarea').inputValue();
  check(`Alt+D types the date in a variation textarea`, taVal === 'date: ' + wantDate, JSON.stringify(taVal));

  // Toolbar hints advertise shortcuts.
  const hints = await page.evaluate(() => {
    const t = (sel) => { const b = [...document.querySelectorAll('#spm-toolbar button')].find(x => x.textContent.trim() === sel); return b && b.title; };
    return { h2: t('H2'), undo: t('↶') };
  });
  check('H2 hint shows Ctrl+Alt+2', /Ctrl\+Alt\+2/.test(hints.h2), hints.h2);
  check('Undo hint shows Ctrl+Z', /Ctrl\+Z/.test(hints.undo), hints.undo);

  console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS');
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('Test crashed:', e); process.exit(1); });
