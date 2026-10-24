// Note defaults (052): a note whose own text is blank shows a DEFAULT —
// every {fill-in} of its sentence (as its owner sees it: their suggested
// edit counts), else the first three words + "..." — as the placeholder of
// its text box, and quietly on read-only cards. Never written into the
// note's text. SHOT_DIR=<dir> saves screenshots.
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const { TEST_URL, TEST_USERNAME, loginAsTestUser, waitForPagination, cleanupTestAnnotations } = require('./test-utils');
const psql = (sql) => execSync(`PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`, { encoding: 'utf8' }).trim();

(async () => {
  let failed = false;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed = true; };
  const shot = async (p, name) => { if (process.env.SHOT_DIR) await p.screenshot({ path: `${process.env.SHOT_DIR}/${name}.png` }); };
  await cleanupTestAnnotations();
  const browser = await chromium.launch({ headless: true });
  let noteId = null;
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    await loginAsTestUser(page);
    await page.goto(TEST_URL);
    await waitForPagination(page);
    // S: a long prose sentence; T: another, with no notes.
    const pick = await page.evaluate(() => {
      const R = window.WriteSysRenderer;
      const ids = [...new Set([...document.querySelectorAll('.pagedjs_pages p .sentence[data-sentence-id]')].map((e) => e.dataset.sentenceId))];
      const prose = ids.filter((id) => (R.sentenceMap[id] || '').trim().split(/\s+/).length > 6 && !/[{&]/.test(R.sentenceMap[id]));
      return { s: prose[1], t: prose[2], sText: R.sentenceMap[prose[1]], tText: R.sentenceMap[prose[2]] };
    });
    const want = (txt) => page.evaluate((t) => window.WriteSysNoteDefault.noteDefault(t), txt);
    const sDefault = await want(pick.sText);
    check('fixture: a prose sentence and its three-word default', /\.\.\.$/.test(sDefault), `${pick.sText.trim().slice(0, 50)} → ${sDefault}`);

    // A blank note through the real API: the server derives its default.
    const csrf = await page.evaluate(() => localStorage.getItem('csrf_token') || sessionStorage.getItem('csrf_token') || '');
    noteId = await page.evaluate(async ({ sid, csrf }) => (await (await fetch('api/notes', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({ sentence_id: sid, color: 'yellow', body: null, priority: 'none' }),
    })).json()).note_id, { sid: pick.s, csrf });
    const row = () => psql(`SELECT coalesce(default_body,'(null)') || '|' || coalesce(body,'(null)') FROM note WHERE note_id=${noteId}`);
    check('server: the new blank note gets its default (text stays empty)', row() === `${sDefault}|(null)`, row());

    const openSentence = async (id) => {
      await page.evaluate(() => { window.WriteSysRenderer.currentSelectedSentenceId = null; });
      await page.locator(`.pagedjs_pages .sentence[data-sentence-id="${id}"]`).first().click();
    };
    await page.reload();
    await waitForPagination(page);
    await openSentence(pick.s);
    const noteSel = `#sticky-notes-container .sticky-note[data-annotation-id="${noteId}"] .note-input`;
    await page.waitForSelector(noteSel);
    const box = () => page.evaluate((s) => { const t = document.querySelector(s); return `${t.value}|${t.placeholder}`; }, noteSel);
    check('margin: the blank note shows its default as the placeholder', (await box()) === `|${sDefault}`, await box());
    await shot(page, 'default-margin');

    // The grey create card previews a fresh sentence's default.
    await openSentence(pick.t);
    await page.waitForSelector('#sticky-notes-container .first-uncreated .note-input');
    const createPh = await page.evaluate(() => document.querySelector('#sticky-notes-container .first-uncreated .note-input').placeholder);
    check('the create card previews the default', createPh === (await want(pick.tText)), createPh);

    // Your suggested edit with {fill-ins} → the default follows, live.
    const edit = pick.sText.replace(/\S+(\s+\S+)?/, '{adjective} {something here}');
    await page.evaluate(async ({ id, text }) => {
      const S = window.WriteSysSuggestions, R = window.WriteSysRenderer;
      await S.putSuggestion(id, text);
      await S.loadForMigration(R.currentMigrationID);
      await R.renderManuscript();
    }, { id: pick.s, text: edit });
    await waitForPagination(page);
    check('server: the suggestion refreshed the default', row() === '{adjective} {something here}|(null)', row());
    await openSentence(pick.s);
    await page.waitForSelector(noteSel);
    check('margin: the placeholder follows your suggested edit', (await box()) === '|{adjective} {something here}', await box());
    await shot(page, 'default-fillins');

    // Typing replaces it; the default stays out of the note's text.
    await page.locator(noteSel).fill('My own words');
    await page.locator(noteSel).dispatchEvent('blur');
    for (let i = 0; i < 20 && !row().endsWith('|My own words'); i++) await page.waitForTimeout(150);
    check('typed text is the note\'s own; the default is untouched', row() === '{adjective} {something here}|My own words', row());
    await page.locator(noteSel).fill('');
    await page.locator(noteSel).dispatchEvent('blur');
    for (let i = 0; i < 20 && !row().endsWith('|(null)'); i++) await page.waitForTimeout(150);
    check('cleared → blank again, the default shows', row() === '{adjective} {something here}|(null)' && (await box()) === '|{adjective} {something here}', `${row()} / ${await box()}`);

    // Landing card: the default, quietly.
    await page.goto(new URL('home.html', TEST_URL).href);
    const card = page.locator(`.card-note:has(.sticky-note[data-note-id="${noteId}"]) .note-readonly-body`);
    await card.waitFor();
    const c = await card.evaluate((e) => ({ text: e.textContent, quiet: e.classList.contains('note-default-text'), color: getComputedStyle(e).color }));
    check('landing card shows the default, styled as one', c.text === '{adjective} {something here}' && c.quiet, JSON.stringify(c));
    await shot(page, 'default-landing');
    await page.close();

    // Phone: the stack's note too.
    const m = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await loginAsTestUser(m);
    await m.goto(TEST_URL);
    await waitForPagination(m);
    await m.evaluate(() => { window.WriteSysRenderer.currentSelectedSentenceId = null; });
    const span = m.locator(`.pagedjs_pages .sentence[data-sentence-id="${pick.s}"]`).first();
    await span.click(); await m.waitForTimeout(300); await span.click();
    const pSel = `#sgm-notes-stack .sticky-note[data-annotation-id="${noteId}"] .note-input`;
    await m.waitForSelector(pSel);
    const ph = await m.evaluate((s) => document.querySelector(s).placeholder, pSel);
    check('phone: the stack note shows the default', ph === '{adjective} {something here}', ph);
    await shot(m, 'default-phone');
    await m.close();
  } catch (e) {
    check('run', false, e.message);
  } finally {
    if (noteId) psql(`DELETE FROM note WHERE note_id=${noteId}`);
    psql(`DELETE FROM suggested_change WHERE user_id='${TEST_USERNAME}'`);
  }
  await browser.close();
  console.log(failed ? '\n❌ some checks failed' : '\n✅ all passed');
  process.exit(failed ? 1 : 0);
})();
