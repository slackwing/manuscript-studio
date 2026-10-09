// Copy from selection e2e (copy-selection.js): shift-click a range, the
// gutter's top button copies the sentences with every suggestion APPLIED
// (winner text in, delete proposals out), marker syntax only while the
// stats-pane markers toggle is on, single-spaced between sentences, the
// manuscript's own \n\t paragraph breaks kept. Reads the real clipboard.
const { chromium } = require('playwright');
const { TEST_URL, loginAsTestUser, waitForPagination } = require('./test-utils');

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail !== '' ? ` (${detail})` : ''}`);
  if (!ok) failed++;
};

(async () => {
  console.log('=== copy from selection e2e ===\n');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1400, height: 1000 },
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await context.newPage();
  await loginAsTestUser(page);
  await page.goto(TEST_URL);
  await waitForPagination(page);

  const SENTENCES = [
    ['cp-0', 'It was &marker#vivid tonight, said one. '],
    ['cp-1', 'A dull line &marker#weird. '],                         // suggested ↓
    ['cp-2', '\n\tNew paragraph begins &marker#twist{strong} here. '],
    ['cp-3', 'This one gets deleted. '],                             // delete proposal
    ['cp-4', 'Pulp&footnote{A note.}&marker#picture, because, why not? '],
    ['cp-5', '&marker#aside Leading marker sentence. '],
    ['cp-6', 'Ends with marker. &marker#beacon'],
  ];
  const render = () => page.evaluate(async (SENTENCES) => {
    const R = window.WriteSysRenderer;
    const S = window.WriteSysSuggestions;
    const sentences = SENTENCES.map(([id, text]) => ({ id, sentence_id: id, text }));
    R.currentSentences = sentences;
    R.sentenceMap = Object.fromEntries(sentences.map((s) => [s.id, s.text]));
    S.viewer = 'test';
    S.rows = [
      { sentence_id: 'cp-1', user_id: 'test', text: 'A brighter  line &marker#weird.' },
      { sentence_id: 'cp-3', user_id: 'test', text: '' },
    ];
    S.rebuildMaps();
    const before = document.body.dataset.paginated;
    await R.renderManuscript();
    await new Promise((res) => {
      const tick = () => (document.body.dataset.paginated !== before ? res() : setTimeout(tick, 50));
      tick();
    });
  }, SENTENCES);
  await render();

  const clickSentence = async (id, modifiers) => {
    if (!modifiers) {
      await page.evaluate(() => {
        window.WriteSysRenderer.currentSelectedSentenceId = null;
        document.querySelectorAll('.sentence.selected').forEach((el) => el.classList.remove('selected'));
      });
    }
    await page.locator(`.pagedjs_pages .sentence[data-sentence-id="${id}"]`).first()
      .click(modifiers ? { modifiers } : {});
  };
  const selectAll = async () => {
    await clickSentence('cp-0');
    await clickSentence('cp-6', ['Shift']);
    await page.waitForSelector('.range-copy');
  };
  const copyNow = async () => {
    await page.evaluate(() => navigator.clipboard.writeText('(stale)'));
    await page.click('.range-copy');
    await page.waitForFunction(() => document.querySelector('.range-copy.copied'));
    return page.evaluate(() => navigator.clipboard.readText());
  };

  // ---- the gutter stack: copy on top of sketch on top of trash ----------
  await selectAll();
  const stack = await page.evaluate(() => {
    const top = (sel) => document.querySelector(sel).getBoundingClientRect().top;
    const trash = document.querySelector('.range-trash:not(.range-sketch):not(.range-copy)');
    return {
      order: top('.range-copy') < top('.range-sketch') && top('.range-sketch') < trash.getBoundingClientRect().top,
      title: document.querySelector('.range-copy').title,
      firstIsTrash: document.querySelector('.range-trash') === trash,
    };
  });
  check('copy sits on top of sketch, sketch on top of trash', stack.order);
  check('copy tooltip counts the selection', stack.title === 'Copy 7 sentences', stack.title);
  check('.range-trash still finds the trash first', stack.firstIsTrash);

  // ---- markers OFF (the default): no marker syntax, tidy spacing --------
  const off = await copyNow();
  const EXPECT_OFF = 'It was tonight, said one. A brighter line.'
    + '\n\tNew paragraph begins here. Pulp&footnote{A note.}, because, why not?'
    + ' Leading marker sentence. Ends with marker.';
  check('markers off: suggestions applied, deletion dropped, markers stripped, single-spaced',
    off === EXPECT_OFF, `\n  got:    ${JSON.stringify(off)}\n  expect: ${JSON.stringify(EXPECT_OFF)}`);
  check('no double spaces, no space before punctuation',
    !/ {2}/.test(off) && !/ [.,;:!?]/.test(off), JSON.stringify(off));
  check('the button acknowledges the copy', await page.evaluate(() =>
    document.querySelector('.range-copy').title === 'Copied'));
  check('copying keeps the selection', await page.evaluate(() =>
    document.body.classList.contains('range-delete-mode')
    && document.querySelectorAll('.sentence.range-selected').length > 0));

  // ---- markers ON: the marker syntax rides along -------------------------
  await page.evaluate(() => window.WriteSysRenderer.setLayerHidden('markers', false));
  await waitForPagination(page);
  await selectAll();
  const on = await copyNow();
  const EXPECT_ON = 'It was &marker#vivid tonight, said one. A brighter line &marker#weird.'
    + '\n\tNew paragraph begins &marker#twist{strong} here. Pulp&footnote{A note.}&marker#picture, because, why not?'
    + ' &marker#aside Leading marker sentence. Ends with marker. &marker#beacon';
  check('markers on: marker syntax included, still single-spaced',
    on === EXPECT_ON, `\n  got:    ${JSON.stringify(on)}\n  expect: ${JSON.stringify(EXPECT_ON)}`);

  // ---- a partial range: just the two middle sentences ------------------
  await clickSentence('cp-2');
  await clickSentence('cp-4', ['Shift']);
  await page.waitForSelector('.range-copy');
  const part = await copyNow();
  check('a range starting a paragraph drops the leading break',
    part === 'New paragraph begins &marker#twist{strong} here. Pulp&footnote{A note.}&marker#picture, because, why not?',
    JSON.stringify(part));

  // ---- marker stripping edge cases (unit) ------------------------------
  const edges = await page.evaluate(() => {
    const C = window.WriteSysCopySelection;
    return [
      ['word &marker#x.', C.stripMarkers('word &marker#x.')],
      ['&marker#x word', C.stripMarkers('&marker#x word')],
      ['a &marker#x &mark#y{weak} b', C.tidy(C.stripMarkers('a &marker#x &mark#y{weak} b'))],
      ['tight&marker#x, then', C.stripMarkers('tight&marker#x, then')],
      ['no markers & ampersands', C.stripMarkers('no markers & ampersands')],
    ];
  });
  const want = ['word.', 'word', 'a b', 'tight, then', 'no markers & ampersands'];
  edges.forEach(([input, got], i) => check(`strip: ${JSON.stringify(input)} → ${JSON.stringify(want[i])}`,
    got === want[i], JSON.stringify(got)));

  // Restore the load default for whatever runs next on this worker.
  await page.evaluate(() => { window.WriteSysRenderer.hiddenLayers.markers = true; });
  await browser.close();
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
