// MOBILE notes (the margin is hidden ≤1239px): double-tapping a sentence
// opens the suggest-edit modal pinned to the TOP, with the sentence's notes
// floating BELOW it as cards on the same dark backdrop (#sgm-notes-stack).
// Clicking the backdrop closes modal + stack together. Desktop is untouched
// (the stack is never built above the breakpoint).
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const { TEST_URL, TEST_USERNAME, loginAsTestUser, waitForPagination, seedNote } = require('./test-utils');
const { suggestEditor } = require('./test-utils');
const psql = (sql) => execSync(
  `PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`,
  { encoding: 'utf-8' }).trim();
const BODY = `Mobile stack note (${TEST_USERNAME})`;
// Long enough to overflow .note-input's 80px min-height at 390px width —
// the stack autosizes while DETACHED (scrollHeight 0), so without the
// post-attach re-pass this note renders clipped.
const LONG_BODY = 'Long mobile note. '.repeat(30) + `(${TEST_USERNAME})`;

(async () => {
  const browser = await chromium.launch();
  let failed = false;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed = true; };

  psql(`DELETE FROM note WHERE user_id='${TEST_USERNAME}' AND (body='${BODY}' OR body='${LONG_BODY}')`);

  // ---- phone viewport: modal at top, notes float below ----
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await loginAsTestUser(page);
  await page.goto(TEST_URL);
  await waitForPagination(page);
  const sid = await page.evaluate(() => document.querySelectorAll('.sentence[data-sentence-id]')[2].dataset.sentenceId);
  seedNote({ sentence_id: sid, color: 'yellow', body: BODY, position: 'a0' });
  seedNote({ sentence_id: sid, color: 'green', body: LONG_BODY, position: 'a1' });
  await page.reload();
  await waitForPagination(page);
  // notes preload with the manuscript — wait until the cache has ours
  await page.waitForFunction((b) =>
    (window.WriteSysRenderer && window.WriteSysRenderer.currentNotes || []).some(n => n.body === b),
    BODY, { timeout: 15000 });

  await page.locator(`.sentence[data-sentence-id="${sid}"]`).first().dblclick();
  await page.waitForSelector('#suggestion-modal', { timeout: 8000 });
  await page.waitForSelector('#sgm-notes-stack .sticky-note', { timeout: 8000 });
  const geo = await page.evaluate((b) => {
    const m = document.getElementById('suggestion-modal').getBoundingClientRect();
    const s = document.getElementById('sgm-notes-stack');
    const sr = s.getBoundingClientRect();
    const note = s.querySelector('.sticky-note');
    return {
      modalTop: m.top, gap: sr.top - m.bottom,
      noteShown: !!note && ((note.querySelector('.note-input') || {}).value || note.textContent).includes(b),
      closeBtn: !!document.querySelector('.sgm-close'),
      overlayDark: getComputedStyle(document.getElementById('suggestion-modal-overlay')).backgroundColor,
    };
  }, BODY);
  check('modal pinned near the top on mobile', geo.modalTop <= 20, `top=${geo.modalTop}`);
  check('note card floats BELOW the modal (dark gap between)', geo.gap >= 6, `gap=${geo.gap}`);
  check('the card is the sentence note', geo.noteShown);
  check('no × close button', !geo.closeBtn);
  check('dark backdrop present', /0\.35|0, 0, 0/.test(geo.overlayDark), geo.overlayDark);

  // ---- long note autosizes to FIT on first open (no clipped text) ----
  const fit = await page.evaluate((b) => {
    const t = [...document.querySelectorAll('#sgm-notes-stack .note-input')].find(x => x.value === b);
    return t ? { client: t.clientHeight, scroll: t.scrollHeight } : null;
  }, LONG_BODY);
  check('long note fits its text on first open (autosized after attach)',
    !!fit && fit.scroll <= fit.client + 2, JSON.stringify(fit));

  // Backdrop click closes BOTH — aim at the dark gap between modal and
  // stack (a fixed bottom point lands on note cards once notes get tall).
  const gapY = await page.evaluate(() => {
    const m = document.getElementById('suggestion-modal').getBoundingClientRect();
    const s = document.getElementById('sgm-notes-stack').getBoundingClientRect();
    return (m.bottom + s.top) / 2;
  });
  await page.mouse.click(195, gapY);
  await page.waitForSelector('#suggestion-modal', { state: 'detached', timeout: 8000 });
  check('backdrop click closes modal + stack',
    (await page.locator('#sgm-notes-stack').count()) === 0);

  // ---- a rainbow bar tap on mobile opens the suggest-edit view for its
  // sentence and puts the caret in THAT note (2026-11-25) ----
  const tapped = await page.evaluate((sid) => {
    const bar = document.querySelector(`.rainbow-bar[data-sentence-id="${sid}"][data-color="green"]`);
    if (!bar) return { bar: false };
    bar.click();
    return { bar: true };
  }, sid);
  check('the sentence has a green rainbow bar to tap', tapped.bar === true);
  await page.waitForSelector('#suggestion-modal', { timeout: 8000 });
  await page.waitForSelector('#sgm-notes-stack .sticky-note', { timeout: 8000 });
  await page.waitForFunction((b) => document.activeElement && document.activeElement.classList.contains('note-input') && document.activeElement.value === b, LONG_BODY, { timeout: 5000 }).catch(() => {});
  const focused = await page.evaluate(() => ({ cls: document.activeElement && document.activeElement.className, val: document.activeElement && document.activeElement.value }));
  check('tapping the green bar opens the view for its sentence with the GREEN note focused', !!focused.cls && /note-input/.test(focused.cls) && focused.val === LONG_BODY, JSON.stringify({ cls: focused.cls, val: (focused.val || '').slice(0, 30) }));
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
  await page.evaluate(() => document.getElementById('suggestion-modal-overlay').click());
  await page.waitForSelector('#suggestion-modal', { state: 'detached', timeout: 8000 });

  // ---- create affordance: a NOTE-LESS sentence still offers the same
  // grey first-note card the desktop margin shows; typing births a real
  // note and the gradient + card takes its place below. ----
  const bare = await page.evaluate(() => {
    const R = window.WriteSysRenderer;
    const noted = new Set((R.currentNotes || []).map(n => n.sentence_id));
    const s = R.currentSentences.find(x => !/[&#\n]/.test(x.text) && x.text.length > 60 && !noted.has(x.id));
    window.WriteSysSuggestions.openModal(s.id);
    return s.id;
  });
  await page.waitForSelector('#suggestion-modal', { timeout: 8000 });
  check('note-less sentence: stack shows the first-note create card',
    (await page.locator('#sgm-notes-stack .sticky-note.first-uncreated .note-input').count()) === 1);
  // The grey card's ↗ picker opens ON SCREEN in the phone view (the body is
  // pinned there; document coordinates used to put it a screenful up).
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator('#sgm-notes-stack .sticky-note.first-uncreated .attach-chip').click();
  await page.waitForSelector('.note-linkpop.note-pick button[data-nid]', { timeout: 8000 });
  const pick = await page.evaluate(() => {
    const p = document.querySelector('.note-linkpop.note-pick').getBoundingClientRect();
    const chip = document.querySelector('#sgm-notes-stack .attach-chip').getBoundingClientRect();
    return { onScreen: p.top >= 0 && p.left >= 0 && p.bottom <= window.innerHeight + 1 && p.right <= window.innerWidth + 1, nearChip: Math.abs(p.top - chip.bottom) < 80 || p.top < chip.top, rows: document.querySelectorAll('.note-linkpop.note-pick button[data-nid]').length };
  });
  check('the ↗ picker opens on screen in the phone suggest-edit view, with notes to pick', pick.onScreen && pick.rows > 0, JSON.stringify(pick));
  if (process.env.SHOT2) await page.screenshot({ path: process.env.SHOT2 });
  await page.keyboard.press('Escape');
  await page.waitForSelector('.note-linkpop.note-pick', { state: 'detached', timeout: 5000 }).catch(() => {});
  await page.locator('#sgm-notes-stack .note-input').first().click();
  await page.keyboard.type('Stack-born note');
  await page.waitForFunction(() =>
    document.querySelectorAll('#sgm-notes-stack .sticky-note:not(.uncreated-note)').length === 1,
    null, { timeout: 10000 });
  check('typing in the create card births a real note in the stack', true);
  check('…and the gradient + card follows it', await page.evaluate(() =>
    !!document.querySelector('#sgm-notes-stack .sticky-note.uncreated-note:not(.first-uncreated)')));
  // The type chip's menu (and every widget popover) must open ON SCREEN in
  // the pinned phone view too — it opened a screenful up, so the type could
  // not be set from a phone (2026-11-25, "the n/a button is broken").
  await page.click('#sgm-notes-stack .sticky-note:not(.uncreated-note) .dim-type');
  await page.waitForSelector('.dim-pop button[data-v]', { timeout: 8000 });
  const typeMenu = await page.evaluate(() => {
    const p = document.querySelector('.dim-pop').getBoundingClientRect();
    const chip = document.querySelector('#sgm-notes-stack .sticky-note:not(.uncreated-note) .dim-type').getBoundingClientRect();
    return { onScreen: p.top >= 0 && p.left >= 0 && p.bottom <= innerHeight + 1 && p.right <= innerWidth + 1, nearChip: Math.abs(p.top - chip.bottom) < 60 || Math.abs(p.bottom - chip.top) < 60, options: document.querySelectorAll('.dim-pop button[data-v]').length };
  });
  check('phone: the type chip\'s menu opens on screen by the chip, with options', typeMenu.onScreen && typeMenu.nearChip && typeMenu.options > 1, JSON.stringify(typeMenu));
  await page.click('.dim-pop button[data-v="reminder"]');
  await page.waitForFunction(() => (document.querySelector('#sgm-notes-stack .sticky-note:not(.uncreated-note) .dim-type .dim-label') || {}).textContent === 'reminder', null, { timeout: 8000 }).catch(() => {});
  const bornId = await page.evaluate(() => document.querySelector('#sgm-notes-stack .sticky-note:not(.uncreated-note)').dataset.noteId);
  let typed = '';
  for (let i = 0; i < 30 && typed !== 'reminder'; i++) { await page.waitForTimeout(150); typed = psql(`SELECT coalesce(task_type,'') FROM note WHERE note_id=${bornId}`); }
  check('phone: picking a type sets the note\'s chip (and lands in the DB)', (await page.locator('#sgm-notes-stack .sticky-note:not(.uncreated-note) .dim-type .dim-label').textContent()) === 'reminder' && typed === 'reminder', typed);
  await page.evaluate(() => {
    const n = (window.WriteSysNotes.notes || []).find(x => (x.body || '').startsWith('Stack-born'));
    if (n) return fetch(`api/notes/${n.note_id}`, { method: 'DELETE', headers: { 'X-CSRF-Token': localStorage.getItem('csrf_token') || sessionStorage.getItem('csrf_token') || '' }, credentials: 'same-origin' });
  });
  // A tap on the stack's EMPTY space (a grid cell with no card) exits the
  // view like the backdrop does (2026-11-25).
  await page.evaluate(() => { const ta = document.activeElement; if (ta && ta.blur) ta.blur(); });
  const emptyCell = await page.evaluate(() => {
    const s = document.getElementById('sgm-notes-stack');
    const r = s.getBoundingClientRect();
    const cards = [...s.querySelectorAll('.sticky-note')].map((c) => c.getBoundingClientRect());
    // Probe a grid of points inside the stack for one that no card covers.
    for (let y = r.top + 4; y < r.bottom - 4; y += 6) for (let x = r.left + 4; x < r.right - 4; x += 6) {
      if (y < 0 || y > innerHeight) continue;
      if (!cards.some((c) => x >= c.left && x <= c.right && y >= c.top && y <= c.bottom)) {
        const hit = document.elementFromPoint(x, y);
        if (hit === s) return { x, y };
      }
    }
    return null;
  });
  check('the stack has empty space beside its cards', !!emptyCell, JSON.stringify(emptyCell));
  if (emptyCell) {
    await page.mouse.click(emptyCell.x, emptyCell.y);
    await page.waitForSelector('#suggestion-modal', { state: 'detached', timeout: 8000 }).catch(() => {});
    check('tapping the stack\'s empty space exits the view', (await page.locator('#suggestion-modal').count()) === 0);
  } else {
    await page.keyboard.press('Escape');
  }
  await page.waitForSelector('#suggestion-modal', { state: 'detached', timeout: 8000 });
  await page.close();


  // ---- desktop viewport: no stack, margin untouched ----
  const desk = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await loginAsTestUser(desk);
  await desk.goto(TEST_URL);
  await waitForPagination(desk);
  await desk.waitForFunction((b) =>
    (window.WriteSysRenderer && window.WriteSysRenderer.currentNotes || []).some(n => n.body === b),
    BODY, { timeout: 15000 });
  await desk.locator(`.sentence[data-sentence-id="${sid}"]`).first().dblclick();
  await desk.waitForSelector('#suggestion-modal', { timeout: 8000 });
  check('desktop: NO floating stack (margin owns notes)',
    (await desk.locator('#sgm-notes-stack').count()) === 0);
  await desk.keyboard.press('Escape');
  await desk.waitForSelector('#suggestion-modal', { state: 'detached', timeout: 8000 });

  psql(`DELETE FROM note WHERE user_id='${TEST_USERNAME}' AND (body='${BODY}' OR body='${LONG_BODY}')`);
  console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS');
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('Test crashed:', e); process.exit(1); });
