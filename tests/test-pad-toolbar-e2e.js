// Pad toolbar / menus e2e (CODE_REVIEW_AUG_2026 Area 1, "Toolbar / menus" —
// the 9 E rows): table-picker-grid, table-ops-visibility, tab-in-table-vs-list
// (three contexts: table cell / list sink / literal \t in the sketch
// textarea), heading-toggle-revert, sketch-menu-clipboard-valid,
// sketch-menu-clipboard-fallback, sketch-menu-picker-search,
// image-upload-flow, open-time-trailing-normalize.
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const { TEST_URL, BASE_URL, cleanupTestNotes, loginAsTestUser } = require('./test-utils');
const HOME_URL = new URL('home.html', TEST_URL).href;
function psql(sql) {
  return execSync(
    `PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8' }).trim();
}
// Tiny valid 1×1 PNG.
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

(async () => {
  console.log('=== pad toolbar / menus e2e ===\n');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE_URL });
  const page = await context.newPage();
  const dialogs = [];
  page.on('dialog', d => { dialogs.push(d.message()); d.accept().catch(() => {}); });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  let failed = 0;
  const check = (n, ok, extra) => {
    console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`);
    if (!ok) failed++;
  };
  const tbBtn = (t) => page.locator(`#spm-toolbar button[title^="${t}"]`);

  await cleanupTestNotes();
  await loginAsTestUser(page);
  await page.goto(HOME_URL);
  await page.waitForSelector('.card-ghost[data-ghost="scratchpad"]');
  await page.click('.card-ghost[data-ghost="scratchpad"]');
  await page.waitForSelector('.spm-overlay .ProseMirror');

  try {
    const pm = page.locator('.spm-editor .ProseMirror');
    await pm.click();
    await page.keyboard.type('A paragraph to head.');

    // ---- heading-toggle-revert -------------------------------------------
    await tbBtn('Heading 2').click();
    await page.waitForSelector('.ProseMirror h2');
    check('H2 button sets the heading', (await pm.locator('h2').textContent()) === 'A paragraph to head.');
    await page.waitForFunction(() =>
      document.querySelector('#spm-toolbar button[title^="Heading 2"]').classList.contains('active'));
    check('active H2 button lights up', true);
    await tbBtn('Heading 2').click();
    await page.waitForFunction(() => !document.querySelector('.spm-editor .ProseMirror h2'));
    check('clicking the ACTIVE H2 reverts to a paragraph (no "can\'t unselect" trap)', true);

    // ---- table-picker-grid ------------------------------------------------
    await page.locator('#spm-toolbar button', { hasText: 'Table ▾' }).click();
    await page.waitForSelector('.tb-grid:not([hidden])');
    await page.hover('.tb-grid-cell[data-r="2"][data-c="3"]');
    await page.waitForFunction(() => document.querySelectorAll('.tb-grid-cell.on').length === 6);
    check('hovering 3×2 lights exactly the 2×3 block', true);
    check('grid label reads the hovered size', (await page.textContent('.tb-grid-label')) === '3 × 2');
    await page.locator('.tb-grid-cell[data-r="2"][data-c="3"]').dispatchEvent('mousedown', { bubbles: true });
    await page.waitForSelector('.ProseMirror table');
    const shape = await page.evaluate(() => {
      const t = document.querySelector('.spm-editor .ProseMirror table');
      return { rows: t.querySelectorAll('tr').length, cols: t.querySelector('tr').children.length };
    });
    check('mousedown inserts EXACTLY the hovered table (2 rows × 3 cols)',
      shape.rows === 2 && shape.cols === 3, JSON.stringify(shape));
    check('picker closes after insert', await page.locator('.tb-grid').evaluate(el => el.hidden));
    await page.locator('#spm-toolbar button', { hasText: 'Table ▾' }).click();
    await page.waitForSelector('.tb-grid:not([hidden])');
    await page.locator('#spm-title').dispatchEvent('mousedown', { bubbles: true });
    await page.waitForFunction(() => document.querySelector('.tb-grid').hidden);
    check('outside mousedown closes the picker', true);

    // ---- tab-in-table (context 1) ----------------------------------------
    await pm.locator('td').first().click();
    await page.keyboard.type('x');
    await page.keyboard.press('Tab');
    await page.keyboard.type('y');
    const cells = await page.evaluate(() =>
      [...document.querySelectorAll('.spm-editor .ProseMirror tr:first-child td')].map(td => td.textContent));
    check('Tab in a table moves to the NEXT CELL', cells[0] === 'x' && cells[1] === 'y', JSON.stringify(cells));

    // ---- table-ops-visibility --------------------------------------------
    check('table ops visible while the caret is in the table',
      !(await tbBtn('Add row below').evaluate(el => el.classList.contains('tb-hidden'))));
    await tbBtn('Add row below').click();
    await page.waitForFunction(() => document.querySelectorAll('.spm-editor .ProseMirror tr').length === 3);
    check('+ Row adds a row (3 rows)', true);
    await tbBtn('Delete column').click();
    await page.waitForFunction(() => document.querySelector('.spm-editor .ProseMirror tr').children.length === 2);
    check('− Col removes a column (2 cols)', true);
    await tbBtn('Delete row').click();
    await page.waitForFunction(() => document.querySelectorAll('.spm-editor .ProseMirror tr').length === 2);
    check('− Row removes a row (back to 2)', true);
    await tbBtn('Delete table').click();
    await page.waitForFunction(() => !document.querySelector('.spm-editor .ProseMirror table'));
    check('✕ Table deletes the table', true);
    await page.waitForFunction(() =>
      document.querySelector('#spm-toolbar button[title^="Add row below"]').classList.contains('tb-hidden'));
    check('table ops hide once the caret leaves any table', true);

    // ---- tab-in-list (context 2) -----------------------------------------
    await pm.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('one');
    await tbBtn('Bullet list').click();
    await page.waitForSelector('.ProseMirror ul li');
    await page.keyboard.press('Enter');
    await page.keyboard.type('two');
    await page.keyboard.press('Tab');
    await page.waitForSelector('.ProseMirror ul li ul li');
    check('Tab in a list SINKS the item (nested bullet)', true);
    check('sunk item keeps its text', /two/.test(await pm.locator('ul li ul li').textContent()));

    // ---- image-upload-flow -----------------------------------------------
    await page.setInputFiles('#spm-image-input', { name: 'dot.png', mimeType: 'image/png', buffer: PNG_1PX });
    await page.waitForSelector('.ProseMirror img.scratch-image');
    check('image file → POST → image block in the doc', true);
    const imgOk = await page.evaluate(async () => {
      const img = document.querySelector('.ProseMirror img.scratch-image');
      const r = await fetch(img.getAttribute('src'));
      return r.ok && (r.headers.get('content-type') || '').startsWith('image/');
    });
    check('uploaded image is served back', imgOk === true);
    {
      let block = true;
      await page.route('**/api/scratchpad-images', (route) => {
        if (block && route.request().method() === 'POST') return route.fulfill({ status: 500, body: 'disk full' });
        return route.continue();
      });
      dialogs.length = 0;
      await page.setInputFiles('#spm-image-input', { name: 'dot2.png', mimeType: 'image/png', buffer: PNG_1PX });
      let alerted = false;
      for (let i = 0; i < 30 && !alerted; i++) {
        alerted = dialogs.some(m => /Image upload failed/.test(m));
        if (!alerted) await page.waitForTimeout(100);
      }
      check('upload failure alerts', alerted, dialogs.join('; ').slice(0, 80));
      check('…and inserts NO image node', (await pm.locator('img.scratch-image').count()) === 1);
      block = false;
      await page.unroute('**/api/scratchpad-images');
    }

    // ---- sketch widget + literal-\t Tab (context 3) ----------------------
    const ctxA = await page.evaluate(() => window.WriteSysScratchpad.insertSketch());
    const varA = ctxA.variation.variation_id;
    await page.waitForSelector('.sn-widget .sn-render');
    await page.locator('.sn-widget .sn-render').click();
    await page.waitForSelector('.sn-widget textarea.sn-text');
    await page.locator('.sn-widget textarea.sn-text').fill('zebra crossing sketch text');
    await page.locator('.sn-widget textarea.sn-text').press('End');
    await page.keyboard.press('Tab');
    const tabState = await page.evaluate(() => ({
      hasTab: document.querySelector('.sn-widget textarea.sn-text').value.includes('\t'),
      stillFocused: document.activeElement === document.querySelector('.sn-widget textarea.sn-text'),
    }));
    check('Tab in the sketch textarea types a LITERAL \\t and keeps focus',
      tabState.hasTab && tabState.stillFocused, JSON.stringify(tabState));
    await page.keyboard.press('Escape'); // exit edit (blur flushes the save)
    await page.waitForSelector('.sn-widget .sn-render');
    let zebraSaved = false;
    for (let i = 0; i < 40; i++) {
      if (/^zebra crossing/.test(psql(`SELECT text FROM variation WHERE variation_id=${varA}`))) { zebraSaved = true; break; }
      await new Promise(r => setTimeout(r, 150));
    }
    check('sketch text persisted before the menu checks', zebraSaved);

    // ---- sketch-menu-clipboard-valid -------------------------------------
    await page.locator('.sn-widget .sn-copyref').click();
    await page.waitForSelector('.sn-widget .sn-copyref.sn-copied');
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    check('copy button writes ms-variation:N to the clipboard', clip === `ms-variation:${varA}`, clip);
    await page.locator('#spm-toolbar button', { hasText: '⧉ Sketch ▾' }).click();
    await page.waitForSelector('.sn-insertpop:not([hidden])');
    await page.waitForSelector('.sn-insertpop .sn-ins-clip:not([disabled])', { timeout: 8000 });
    const clipTitle = await page.getAttribute('.sn-ins-clip', 'title');
    check('valid clipboard ref enables "From clipboard" with a preview',
      /related to the copied one.*zebra crossing/.test(clipTitle), clipTitle);
    const widgetsBefore = await page.locator('.sn-widget').count();
    await page.locator('.sn-ins-clip').click();
    await page.waitForFunction((n) => document.querySelectorAll('.sn-widget').length === n + 1, widgetsBefore);
    check('clicking it inserts a new related variation widget', true);
    check('the new variation is a sibling (next letter, text copied)',
      psql(`SELECT count(*) FROM variation WHERE sketch_id='${ctxA.sketch.sketch_id}' AND ordinal=2 AND text LIKE 'zebra%'`) === '1');

    // ---- sketch-menu-clipboard-fallback ----------------------------------
    // (insertVariation above CLOSED the menu — each block below opens fresh.)
    const openMenu = async () => {
      await page.locator('#spm-toolbar button', { hasText: '⧉ Sketch ▾' }).click();
      await page.waitForFunction(() => {
        const p = document.querySelector('.sn-insertpop');
        return p && !p.hidden;
      });
    };
    const closeMenu = async () => {
      await page.locator('#spm-toolbar button', { hasText: '⧉ Sketch ▾' }).click();
      await page.waitForFunction(() => document.querySelector('.sn-insertpop').hidden);
    };
    // 2026-08-23: the menu NEVER calls clipboard.readText() — Firefox
    // answers it with a paste PROMPT that stole the menu's first click.
    // The in-app record (ms_last_variation_ref) is the sole source; a
    // hanging or foreign clipboard is irrelevant either way.
    await page.evaluate(() => { navigator.clipboard.readText = () => { throw new Error('readText must not be called'); }; });
    await openMenu();
    await page.waitForSelector('.sn-insertpop .sn-ins-clip:not([disabled])', { timeout: 8000 });
    check('in-app copy record enables the button — clipboard never read', true);
    await closeMenu();
    await page.evaluate(() => { localStorage.removeItem('ms_last_variation_ref'); });
    await openMenu();
    for (let i = 0; i < 3; i++) await page.waitForTimeout(300);
    check('no in-app record → stays disabled',
      await page.locator('.sn-ins-clip').evaluate(el => el.disabled));
    await page.evaluate((v) => { localStorage.setItem('ms_last_variation_ref', v); },
      await page.evaluate(() => document.querySelector('.sn-widget').dataset.variationId));

    // ---- sketch-menu-picker-search ---------------------------------------
    await page.locator('.sn-insertpop .sn-ins-based').click();
    await page.waitForSelector('.sn-insertpop .sn-ins-q');
    await page.waitForSelector('.sn-ins-list button[data-vid]');
    await page.locator('.sn-ins-q').fill('zebra');
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll('.sn-ins-list button[data-vid]')];
      return rows.length >= 1 && rows.every(r => /zebra/.test(r.textContent));
    }, null, { timeout: 8000 });
    check('picker search filters (debounced) to matching variations', true);
    await page.locator('.sn-ins-q').fill('no-such-variation-text-xyzzy');
    await page.waitForFunction(() =>
      /No variations yet/.test((document.querySelector('.sn-ins-list') || {}).textContent || ''), null, { timeout: 8000 });
    check('no matches renders the empty message', true);
    {
      let block = true;
      await page.route('**/api/variations?q=*', (route) => block ? route.fulfill({ status: 500, body: 'oops' }) : route.continue());
      await page.locator('.sn-ins-q').fill('anything');
      await page.waitForFunction(() =>
        /Could not load variations/.test((document.querySelector('.sn-ins-list') || {}).textContent || ''), null, { timeout: 8000 });
      check('picker load error renders "Could not load variations"', true);
      block = false;
      await page.unroute('**/api/variations?q=*');
    }
    await page.locator('.sn-ins-q').press('Escape');
    await page.waitForFunction(() => {
      const p = document.querySelector('.sn-insertpop');
      return !p || p.hidden;
    });
    check('Escape closes the picker popover', true);
    // Fixed 2C-1: the picker's Escape now stopPropagation()s, so the modal's
    // document-level Escape no longer closes the whole pad with the popover.
    check('Escape in the picker leaves the pad OPEN (popover only)',
      (await page.locator('.spm-overlay').count()) === 1);

    // ---- open-time-trailing-normalize ------------------------------------
    if (await page.locator('.spm-overlay').count()) {
      await page.waitForFunction(() => document.querySelector('#spm-status').textContent === 'Saved');
      await page.click('#spm-close');
      await page.waitForSelector('.spm-overlay', { state: 'detached' });
    }
    const seedPad = async (docContent) => page.evaluate(async (docContent) => {
      const csrf = (localStorage.getItem('csrf_token') || sessionStorage.getItem('csrf_token')) || '';
      const mk = await fetch('api/scratchpads', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ title: 'seeded' }),
      });
      const id = (await mk.json()).scratchpad_id;
      const put = await fetch(`api/scratchpads/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ title: 'seeded', doc: { type: 'doc', content: docContent } }),
      });
      return put.ok ? id : -put.status;
    }, docContent);
    // (a) doc ENDING with a sketch widget.
    const sk = await page.evaluate(async () => {
      const csrf = (localStorage.getItem('csrf_token') || sessionStorage.getItem('csrf_token')) || '';
      const r = await fetch('api/sketches', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ mode: 'new' }),
      });
      return (await r.json()).variation.variation_id;
    });
    const padSnip = await seedPad([
      { type: 'paragraph', content: [{ type: 'text', text: 'before the widget' }] },
      { type: 'sketch', attrs: { variationId: sk } },
    ]);
    check('trailing-sketch pad seeded via API', padSnip > 0, `pad=${padSnip}`);
    await page.evaluate((id) => window.WriteSysScratchpadModal.open(id), padSnip);
    await page.waitForSelector('.spm-overlay .sn-widget');
    const shapeSnip = await page.evaluate(() => {
      const d = window.WriteSysScratchpad.view.state.doc;
      return { count: d.childCount, last: d.lastChild.type.name };
    });
    check('open-time pass appends a paragraph after a trailing sketch',
      shapeSnip.count === 3 && shapeSnip.last === 'paragraph', JSON.stringify(shapeSnip));
    await page.click('#spm-close');
    await page.waitForSelector('.spm-overlay', { state: 'detached' });
    // (b) doc ENDING with a table.
    const padTable = await seedPad([
      { type: 'paragraph', content: [{ type: 'text', text: 'before the table' }] },
      { type: 'table', content: [{ type: 'table_row', content: [{ type: 'table_cell', content: [{ type: 'paragraph' }] }] }] },
    ]);
    check('trailing-table pad seeded via API', padTable > 0, `pad=${padTable}`);
    await page.evaluate((id) => window.WriteSysScratchpadModal.open(id), padTable);
    await page.waitForSelector('.spm-overlay .ProseMirror table');
    const shapeTable = await page.evaluate(() => {
      const d = window.WriteSysScratchpad.view.state.doc;
      return { count: d.childCount, last: d.lastChild.type.name };
    });
    check('open-time pass appends a paragraph after a trailing table',
      shapeTable.count === 3 && shapeTable.last === 'paragraph', JSON.stringify(shapeTable));
    await page.click('#spm-close');
    await page.waitForSelector('.spm-overlay', { state: 'detached' });

    check('no page errors', errs.length === 0, errs.slice(0, 3).join('; '));
  } finally {
    await cleanupTestNotes();
    await browser.close();
  }

  console.log(failed === 0 ? '\n✅ Test passed' : `\n❌ ${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('Test crashed:', e); process.exit(1); });
