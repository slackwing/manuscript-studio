// Footnotes e2e (FOOTNOTES_PLAN.md): real pagination through Paged.js's
// footnote module. Injects committed sentences with footnotes into the
// renderer's local state (renderManuscript re-paginates; the after-render
// hook relabels), then checks: bodies land in the page's footnote area as
// fragments of their host sentence, calls sit in the host's span, the
// numbering policies (chapter / never / page, numbers / symbols), the
// footnote-is-its-sentence selection + edit-modal caret, a suggested edit's
// diff inside a note, and the attention harvest ignoring note bodies.
const { chromium } = require('playwright');
const { TEST_URL, loginAsTestUser, waitForPagination } = require('./test-utils');

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail !== '' ? ` (${detail})` : ''}`);
  if (!ok) failed++;
};

(async () => {
  console.log('=== footnotes e2e ===\n');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  await loginAsTestUser(page);
  await page.goto(TEST_URL);
  await waitForPagination(page);

  const prose = 'The evening settled over the valley like a long held breath. ';
  // Four notes across a few pages; a chapter heading before the third.
  const build = async (sug) => page.evaluate(async ({ prose, sug }) => {
    const R = window.WriteSysRenderer;
    const S = window.WriteSysSuggestions;
    const before = document.body.dataset.paginated;
    const sentences = [];
    const push = (id, text) => sentences.push({ id, sentence_id: id, text });
    push('fn-ch1', '&chapter#one{One}');
    for (let i = 0; i < 40; i++) {
      if (i === 20) push('fn-ch2', '&chapter#two{Two}');
      let text = prose + `Sentence number ${i} carries the paragraph onward.`;
      if (i === 2) text += '&footnote{First note, page one. *Italic* inside.}';
      if (i === 5) text += '&footnote{Second note.}';
      if (i === 22) text += '&footnote{Third note, after the chapter break.}';
      if (i === 35) text += '&footnote{Fourth note.}';
      push(`fn-${i}`, text + ' ');
    }
    R.currentSentences = sentences;
    R.sentenceMap = Object.fromEntries(sentences.map((s) => [s.id, s.text]));
    if (S) { S.viewer = 'test'; S.rows = sug || []; S.rebuildMaps(); }
    await R.renderManuscript();
    await new Promise((res) => {
      const tick = () => (document.body.dataset.paginated !== before ? res() : setTimeout(tick, 50));
      tick();
    });
  }, { prose, sug });
  await build();

  const info = await page.evaluate(() => {
    const bodies = [...document.querySelectorAll('.pagedjs_pages .pagedjs_footnote_area .fn-body')];
    const calls = [...document.querySelectorAll('.pagedjs_pages [data-footnote-call]')];
    return {
      bodies: bodies.map((b) => [b.dataset.sentenceId, b.classList.contains('sentence'), b.hasAttribute('data-footnote-marker'), b.textContent.slice(0, 12)]),
      italic: !!document.querySelector('.pagedjs_footnote_area .fn-body em'),
      calls: calls.map((c) => c.dataset.sentenceId), // stamped by footnotes.js from the body
      callFrag: calls.every((c) => c.classList.contains('sentence') && c.classList.contains('fn-call') && !c.classList.contains('fn-body')
        && c.parentElement.closest('.sentence').dataset.sentenceId === c.dataset.sentenceId),
      marks: calls.map((c) => c.getAttribute('data-fn-mark')),
      painted: calls.map((c) => getComputedStyle(c, '::after').content),
      inHost: bodies.every((b) => !b.closest('.sentence:not(.fn-body)')), // moved OUT of the host span by Paged
      pages: document.querySelectorAll('.pagedjs_pages .pagedjs_page').length,
      // The footnote area must sit INSIDE the page's content region — a
      // flat page-content height once pushed it into the bottom margin.
      areaInside: [...document.querySelectorAll('.pagedjs_pages .pagedjs_page')].every((pg) => {
        const area = pg.querySelector('.pagedjs_footnote_area');
        if (!area || !area.querySelector('.fn-body')) return true;
        const a = area.getBoundingClientRect();
        const c = pg.querySelector('.pagedjs_area').getBoundingClientRect();
        const last = [...area.querySelectorAll('.fn-body')].pop().getBoundingClientRect();
        return a.bottom <= c.bottom + 1 && last.bottom <= a.bottom + 1;
      }),
    };
  });
  check('footnote areas sit inside the content region (no note in the margin)', info.areaInside);
  check('four bodies land in footnote areas as fragments of their hosts',
    info.bodies.length === 4 && JSON.stringify(info.bodies.map((b) => b[0])) === '["fn-2","fn-5","fn-22","fn-35"]'
    && info.bodies.every((b) => b[1] && b[2]), JSON.stringify(info.bodies));
  check('italics render inside a note', info.italic);
  check('each call sits inside its host span and is itself a fragment of the host (id stamped, fn-call)',
    JSON.stringify(info.calls) === '["fn-2","fn-5","fn-22","fn-35"]' && info.callFrag, JSON.stringify(info.calls));
  check('default numbering restarts at the chapter heading (1 2 · 1 2)',
    JSON.stringify(info.marks) === '["1","2","1","2"]', JSON.stringify(info.marks));
  check('the relabelled mark is what the call paints (beats Paged\'s counter)',
    JSON.stringify(info.painted) === '["\\"1\\"","\\"2\\"","\\"1\\"","\\"2\\""]', JSON.stringify(info.painted));
  check('spans more than one page', info.pages >= 2, String(info.pages));

  // Policies re-number in place — no re-pagination (data-paginated unchanged).
  const pol = await page.evaluate(() => {
    const R = window.WriteSysRenderer;
    const before = document.body.dataset.paginated;
    const marks = () => [...document.querySelectorAll('.pagedjs_pages [data-footnote-call]')].map((c) => c.getAttribute('data-fn-mark'));
    const perPage = () => {
      const seen = new Map();
      return [...document.querySelectorAll('.pagedjs_pages [data-footnote-call]')].map((c) => {
        const pg = c.closest('.pagedjs_page');
        seen.set(pg, (seen.get(pg) || 0) + 1);
        return seen.get(pg);
      });
    };
    R.applySettings({ 'footnote-reset': 'never' }); const never = marks();
    R.applySettings({ 'footnote-reset': 'page' }); const perPageMarks = marks(); const expectPage = perPage().map(String);
    R.applySettings({ 'footnote-marks': 'symbols' }); const symbols = marks();
    const expectSym = perPage().map((n) => window.WriteSysFootnotes.symbolFor(n));
    const bodyMark = document.querySelector('.pagedjs_footnote_area [data-footnote-marker]').getAttribute('data-fn-mark');
    const markerPainted = getComputedStyle(document.querySelector('.pagedjs_footnote_area [data-footnote-marker]'), '::before').content;
    R.applySettings({});
    return { never, perPageMarks, expectPage, symbols, expectSym, bodyMark, markerPainted, same: document.body.dataset.paginated === before };
  });
  check('never → continuous 1 2 3 4', JSON.stringify(pol.never) === '["1","2","3","4"]', JSON.stringify(pol.never));
  check('page → restarts on every page', JSON.stringify(pol.perPageMarks) === JSON.stringify(pol.expectPage), `${pol.perPageMarks} vs ${pol.expectPage}`);
  check('symbols → Chicago sequence per page', JSON.stringify(pol.symbols) === JSON.stringify(pol.expectSym), `${pol.symbols} vs ${pol.expectSym}`);
  check('the body\'s marker carries the same mark and paints it',
    pol.bodyMark === pol.symbols[0] && pol.markerPainted.startsWith(`"${pol.symbols[0]} `), `${pol.bodyMark} ${pol.markerPainted}`);
  check('renumbering never re-paginates', pol.same);

  // ---- a footnote IS its host sentence ---------------------------------
  const bodySel = '.pagedjs_pages .pagedjs_footnote_area .fn-body[data-sentence-id="fn-2"]';
  await page.click(bodySel);
  const sel = await page.evaluate(() => ({
    current: window.WriteSysRenderer.currentSelectedSentenceId,
    hostSelected: !!document.querySelector('.pagedjs_pages .sentence[data-sentence-id="fn-2"]:not(.fn-body).selected'),
    bodySelected: !!document.querySelector('.pagedjs_pages .fn-body[data-sentence-id="fn-2"].selected'),
  }));
  check('clicking a footnote body selects the HOST sentence (both highlighted)',
    sel.current === 'fn-2' && sel.hostSelected && sel.bodySelected, JSON.stringify(sel));
  await page.click(bodySel); // second click → the host's edit modal
  await page.waitForSelector('#suggestion-modal .suggestion-modal-textarea', { timeout: 10000 });
  const caret = await page.waitForFunction(() => {
    const ta = document.querySelector('#suggestion-modal .suggestion-modal-textarea');
    if (!ta || document.activeElement !== ta) return null;
    const want = ta.value.indexOf('&footnote{') + '&footnote{'.length;
    return { at: ta.selectionStart, want, ok: ta.selectionStart === want && ta.selectionStart > 0 };
  }, null, { timeout: 5000 }).then((h) => h.jsonValue()).catch(() => ({ ok: false, at: -1, want: -1 }));
  check('second click opens the host\'s modal with the caret just inside &footnote{', caret.ok, JSON.stringify(caret));
  await page.keyboard.press('Escape');
  await page.evaluate(() => { const m = document.getElementById('suggestion-modal'); if (m) m.remove(); });

  // ---- suggested edit inside a note → diff inside the body ---------------
  await build([{ sentence_id: 'fn-5', user_id: 'alice',
    text: prose + 'Sentence number 5 carries the paragraph onward.&footnote{Second *revised* remark.} ' }]);
  const diff = await page.evaluate(() => {
    const b = document.querySelector('.pagedjs_pages .pagedjs_footnote_area .fn-body[data-sentence-id="fn-5"]');
    return b ? { del: b.querySelector('del') && b.querySelector('del').textContent, ins: b.querySelector('strong') && b.querySelector('strong').textContent,
      em: !!b.querySelector('em'), text: b.textContent } : null;
  });
  check('a suggestion changing note text diffs green/red INSIDE the footnote area body',
    !!diff && diff.del === 'note.' && !!diff.ins && diff.ins.includes('remark.') && diff.em && diff.text.startsWith('Second '), JSON.stringify(diff));
  await build([{ sentence_id: 'fn-5', user_id: 'alice',
    text: prose + 'Sentence number 5 carries the paragraph onward. ' }]);
  const removed = await page.evaluate(() => {
    const b = document.querySelector('.pagedjs_pages .pagedjs_footnote_area .fn-body[data-sentence-id="fn-5"]');
    return b ? { removed: b.classList.contains('fn-removed'), struck: !!b.querySelector('del') } : null;
  });
  check('a suggestion removing the note shows it red-struck in the footnote area',
    !!removed && removed.removed && removed.struck, JSON.stringify(removed));
  // ---- a note ADDED by a suggestion: body in the footnote area on the
  // page (icon hidden); in the modal's diff pane the added-command icon
  // stands in for the note (body hidden), its text on hover.
  await build([{ sentence_id: 'fn-3', user_id: 'alice',
    text: prose + 'Sentence number 3 carries the paragraph onward.&footnote{Added note.} ' }]);
  const addedPage = await page.evaluate(() => {
    const b = document.querySelector('.pagedjs_pages .pagedjs_footnote_area .fn-body.fn-added[data-sentence-id="fn-3"]');
    const icons = [...document.querySelectorAll('.pagedjs_pages .fn-diamond')];
    return { body: !!b && !!b.querySelector('strong') && getComputedStyle(b).display !== 'none',
      iconsHidden: icons.length > 0 && icons.every((i) => getComputedStyle(i).display === 'none') };
  });
  check('page: an added note shows its green body in the footnote area, no icon', addedPage.body && addedPage.iconsHidden, JSON.stringify(addedPage));
  const hostSel = '.pagedjs_pages .sentence[data-sentence-id="fn-3"]:not(.fn-body):not(.fn-call)';
  await page.click(hostSel);
  await page.click(hostSel);
  await page.waitForSelector('#suggestion-modal .sgm-fmt-left', { timeout: 10000 });
  const addedModal = await page.waitForFunction(() => {
    // The formatted pane renders into a SHADOW tree (scratch-render.js).
    const host = document.querySelector('#suggestion-modal .sgm-fmt-left');
    const pane = host && host.shadowRoot;
    const icon = pane && pane.querySelector('.fn-diamond.cmd-diamond-added');
    const body = pane && pane.querySelector('.fn-body.fn-added');
    if (!icon || !body) return null;
    return { icon: getComputedStyle(icon).display !== 'none', body: getComputedStyle(body).display === 'none',
      // innerText honours display:none (textContent would count the hidden body).
      title: icon.getAttribute('title'), textInline: pane.querySelector('.scratch-book').innerText.includes('Added note.') };
  }, null, { timeout: 8000 }).then((h) => h.jsonValue()).catch(() => null);
  check('modal diff pane: the added note is an added-command icon (note on hover), not inline text',
    !!addedModal && addedModal.icon && addedModal.body && addedModal.title === '&footnote{Added note.}' && !addedModal.textInline,
    JSON.stringify(addedModal));
  await page.keyboard.press('Escape');
  await page.evaluate(() => { const m = document.getElementById('suggestion-modal'); if (m) m.remove(); });
  await build(); // committed again

  // ---- attention harvest ignores note bodies -----------------------------
  const harvest = await page.evaluate(() => {
    const A = window.WriteSysAttention;
    if (!A || !A._harvest) return null;
    const words = (el) => (el.textContent.trim().match(/\S+/g) || []).length;
    const expect = [...document.querySelectorAll('.pagedjs_pages .sentence:not(.fn-body)')].reduce((n, el) => n + words(el), 0);
    const noteWords = [...document.querySelectorAll('.pagedjs_pages .fn-body')].reduce((n, el) => n + words(el), 0);
    const got = A._harvest().lines.reduce((n, l) => n + l.words, 0);
    return { expect, got: Math.round(got), noteWords };
  });
  check('attention harvest counts prose words only (note bodies excluded)',
    !!harvest && harvest.noteWords > 0 && harvest.got === harvest.expect, JSON.stringify(harvest));

  await browser.close();
  console.log('');
  if (failed) { console.log(`❌ ${failed} check(s) failed`); process.exit(1); }
  console.log('✅ footnotes e2e: all checks pass');
})().catch((e) => { console.error(e); process.exit(1); });
