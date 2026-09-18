// Suggested-edit modal: inline commands in the FORMATTED panes (2026-09-18).
// Both panes open formatted and drop to monospace on click; a committed
// &marker must wear its symbol there — exactly as the page shows it — and
// the literal "&marker#picture" belongs to the mono (raw) view only. The
// bug: with nothing to diff (the right pane's committed version; the left
// pane before you type) the panes escaped the raw text and printed the
// command as prose. The history dialog's panes had the same gap, and its
// diff pane never rendered commands at all.
const { chromium } = require('playwright');
const { TEST_URL, loginAsTestUser, waitForPagination } = require('./test-utils');

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail !== '' ? ` (${detail})` : ''}`);
  if (!ok) failed++;
};

(async () => {
  console.log('=== suggest-edit modal: commands in the formatted panes ===\n');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  await loginAsTestUser(page);
  await page.goto(TEST_URL);
  await waitForPagination(page);

  const TEXT = 'It rained all night. &marker#picture The river rose by morning. ';
  const HOST = '.pagedjs_pages .sentence[data-sentence-id="mkf-2"]';

  // Committed sentences injected into the renderer's local state (the
  // test-footnotes idiom). No suggestions: the modal opens on the committed
  // text with nothing to diff. The test user is author+editor (see-markers);
  // the display toggle is flipped per build.
  const build = (display) => page.evaluate(async ({ TEXT, display }) => {
    const R = window.WriteSysRenderer;
    const S = window.WriteSysSuggestions;
    window.WriteSysMarkerSymbols.display = display;
    const before = document.body.dataset.paginated;
    const sentences = [];
    const push = (id, text) => sentences.push({ id, sentence_id: id, text });
    push('mkf-ch', '&chapter#one{One}');
    for (let i = 0; i < 6; i++) push(`mkf-${i}`, i === 2 ? TEXT : `Sentence number ${i} carries the paragraph onward. `);
    R.currentSentences = sentences;
    R.sentenceMap = Object.fromEntries(sentences.map((s) => [s.id, s.text]));
    if (S) { S.rows = []; S.rebuildMaps(); }
    await R.renderManuscript();
    await new Promise((res) => {
      const tick = () => (document.body.dataset.paginated !== before ? res() : setTimeout(tick, 50));
      tick();
    });
  }, { TEXT, display });

  // What a formatted pane (a shadow tree — scratch-render.js) shows.
  const readPane = (sel) => page.evaluate((sel) => {
    const host = document.querySelector(sel);
    const book = host && host.shadowRoot && host.shadowRoot.querySelector('.scratch-book');
    if (!host || !book) return null;
    const glyph = book.querySelector('.cmd-diamond-marker[data-slug="picture"]');
    return {
      shown: !host.hidden,
      glyph: !!glyph && !!glyph.querySelector('svg') && glyph.getAttribute('title') === '&marker#picture',
      hiddenSpan: !!book.querySelector('.inline-cmd[data-kind="marker"][data-slug="picture"]'),
      literal: book.innerText.includes('&marker'),
      ins: !!book.querySelector('strong'),
      text: book.innerText.replace(/\s+/g, ' ').trim(),
    };
  }, sel);
  const paneUntil = async (sel, pred, ms = 6000) => {
    const t0 = Date.now();
    let p = null;
    while (Date.now() - t0 < ms) {
      p = await readPane(sel);
      if (p && p.shown && pred(p)) return p;
      await page.waitForTimeout(100);
    }
    return p;
  };
  const LEFT = '#suggestion-modal .sgm-fmt-left';
  const RIGHT = '#suggestion-modal .sgm-fmt-right';
  const symbol = (p) => p.glyph && !p.literal;

  // First click selects, second opens — unless the sentence is still
  // selected from the previous round, when the first click opens.
  const openModal = async () => {
    await page.click(HOST);
    const opened = await page.waitForSelector(LEFT, { timeout: 1500 }).catch(() => null);
    if (!opened) await page.click(HOST);
    await page.waitForSelector(LEFT, { timeout: 10000 });
  };
  const closeModal = async () => {
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      for (const id of ['suggestion-modal', 'suggestion-modal-overlay']) {
        const el = document.getElementById(id);
        if (el) el.remove();
      }
    });
  };

  // ---- display on: the symbol at rest, the literal only in mono ----------
  await build(true);
  const onPage = await page.evaluate((HOST) => {
    const s = document.querySelector(HOST);
    return !!s && !!s.querySelector('.cmd-diamond-marker[data-slug="picture"]') && !s.innerText.includes('&marker');
  }, HOST);
  check('page: the committed marker wears its symbol (precondition)', onPage);

  await openModal();
  let left = await paneUntil(LEFT, symbol);
  check('left pane (committed text, nothing to diff) shows the marker symbol, never the literal',
    !!left && symbol(left), JSON.stringify(left));
  let right = await paneUntil(RIGHT, symbol);
  check('right pane (the committed version) shows the symbol too', !!right && symbol(right), JSON.stringify(right));

  await page.click(LEFT);
  await page.waitForSelector('#suggestion-modal .suggestion-modal-textarea', { state: 'visible', timeout: 8000 });
  const raw = await page.inputValue('#suggestion-modal .suggestion-modal-textarea');
  check('click in → the mono editor holds the literal command', raw.includes('&marker#picture'), raw);
  await page.evaluate(() => document.querySelector('#suggestion-modal .suggestion-modal-textarea').blur());
  left = await paneUntil(LEFT, symbol);
  check('blur → formatted again, symbol back', !!left && symbol(left), JSON.stringify(left));

  await page.click(RIGHT);
  await page.waitForSelector('#suggestion-modal .sgm-version-text', { state: 'visible', timeout: 8000 });
  check('right pane click → the raw committed text, literal command',
    (await page.inputValue('#suggestion-modal .sgm-version-text')).includes('&marker#picture'));
  await page.evaluate(() => document.querySelector('#suggestion-modal .sgm-version-text').blur());
  right = await paneUntil(RIGHT, symbol);
  check('right pane blur → symbol back', !!right && symbol(right), JSON.stringify(right));
  await closeModal();

  // ---- display off: the pane hides the marker like the page does ---------
  await build(false);
  await openModal();
  left = await paneUntil(LEFT, (p) => !p.literal && !p.glyph);
  check('display toggle off → neither literal nor symbol, just the data span (as on the page)',
    !!left && !left.literal && !left.glyph && left.hiddenSpan, JSON.stringify(left));
  await closeModal();

  // ---- history dialog (settings audit table): same panes, same rule -------
  await page.evaluate(() => { window.WriteSysMarkerSymbols.display = true; });
  const openHistory = (suggested) => page.evaluate(({ TEXT, suggested }) => {
    window.WriteSysSuggestions.openHistoryDialog({
      status: 'accepted', owner_id: 'alice', reviewer_id: 'bob',
      committed_text: TEXT, suggested_text: suggested,
    });
  }, { TEXT, suggested });
  await openHistory(TEXT);
  await page.waitForSelector(LEFT, { timeout: 8000 });
  left = await paneUntil(LEFT, symbol);
  right = await paneUntil(RIGHT, symbol);
  check('history dialog, identical texts: both panes show the symbol',
    !!left && symbol(left) && !!right && symbol(right), JSON.stringify({ left, right }));
  await closeModal();
  await openHistory(TEXT + 'Added words.');
  await page.waitForSelector(LEFT, { timeout: 8000 });
  left = await paneUntil(LEFT, (p) => symbol(p) && p.ins);
  check('history dialog, word diff: the symbol survives beside the green words',
    !!left && symbol(left) && left.ins && left.text.includes('Added words.'), JSON.stringify(left));
  await closeModal();

  await browser.close();
  console.log(`\n${failed ? `${failed} check(s) failed` : 'all checks passed'}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
