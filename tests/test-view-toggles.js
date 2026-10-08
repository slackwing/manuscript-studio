// Stats-pane view toggles e2e: markers · attention · footnotes in one
// wrapping row. Markers and footnotes start ON; released, the renderer
// strips that layer from the page HTML and Paged.js re-paginates without
// it (renderer.setLayerHidden) — notes give their space back to the body,
// lines close up where the glyphs were. A hidden marker still feeds the
// attention harvest; pressing a toggle again restores the layout exactly;
// the re-render holds the reader's place.
const { chromium } = require('playwright');
const { TEST_URL, loginAsTestUser, waitForPagination } = require('./test-utils');

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail !== '' ? ` (${detail})` : ''}`);
  if (!ok) failed++;
};

(async () => {
  console.log('=== stats-pane view toggles e2e ===\n');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  await loginAsTestUser(page);
  await page.goto(TEST_URL);
  await waitForPagination(page);

  // Inject a manuscript with dense valued markers and a few footnotes.
  await page.evaluate(async () => {
    window.WriteSysMarkerSymbols.display = true;
    window.WriteSysMarkerSymbols.map = {
      vivid: { symbol: 'diamond', attention: 10 },
      digression: { symbol: 'circle', attention: -15 },
    };
    const prose = 'The evening settled over the valley like a long held breath. ';
    const sentences = [];
    for (let i = 0; i < 40; i++) {
      let text = `It was &marker#vivid tonight, said &marker#vivid number ${i}. `
        + prose + `Sentence number ${i} carries the paragraph onward.`;
      if (i % 3 === 0) text += ' Then &marker#digression it &marker#vivid wandered.';
      if (i % 9 === 2) text += `&footnote{Note on sentence ${i}.}`;
      sentences.push({ id: `vt-${i}`, sentence_id: `vt-${i}`, text: text + ' ' });
    }
    const R = window.WriteSysRenderer;
    R.currentSentences = sentences;
    R.sentenceMap = Object.fromEntries(sentences.map((s) => [s.id, s.text]));
    const before = document.body.dataset.paginated;
    await R.renderManuscript();
    await new Promise((res) => {
      const tick = () => (document.body.dataset.paginated !== before ? res() : setTimeout(tick, 50));
      tick();
    });
    window.WriteSysStats.setPane('stats');
  });
  await page.waitForSelector('#stats-footnotes', { timeout: 8000 });

  // Click a toggle and wait for the re-pagination it triggers.
  const toggle = async (id) => {
    const before = await page.evaluate(() => document.body.dataset.paginated);
    await page.click(id);
    await page.waitForFunction((b) => document.body.dataset.paginated !== b
      && !window.WriteSysRenderer._renderInFlight, before, { timeout: 30000 });
  };

  const state = () => page.evaluate(() => {
    const pages = [...document.querySelectorAll('.pagedjs_pages .pagedjs_page')];
    const pressed = (id) => { const b = document.getElementById(id); return b && b.getAttribute('aria-pressed'); };
    return {
      order: [...document.querySelectorAll('.stats-toggles .stats-toggle')].map((b) => b.id),
      wrap: getComputedStyle(document.querySelector('.stats-toggles')).flexWrap,
      markersPressed: pressed('stats-markers'),
      footnotesPressed: pressed('stats-footnotes'),
      glyphs: document.querySelectorAll('.pagedjs_pages .cmd-diamond[data-kind="marker"]').length,
      dataSpans: document.querySelectorAll('.pagedjs_pages .inline-cmd[data-kind="marker"]').length,
      calls: document.querySelectorAll('.pagedjs_pages [data-footnote-call]').length,
      bodies: document.querySelectorAll('.pagedjs_pages .fn-body').length,
      // Where each page breaks, to the character.
      layout: pages.map((p) => {
        const c = p.querySelector('.pagedjs_page_content');
        return c ? c.textContent.length : 0;
      }),
      contentH: Math.round(pages[0].querySelector('.pagedjs_page_content').getBoundingClientRect().height),
      harvested: window.WriteSysAttention._harvest().markers.length,
      overlays: document.querySelectorAll('.attention-overlay').length,
    };
  });

  const on = await state();
  check('three toggles in order: markers · attention · footnotes',
    JSON.stringify(on.order) === JSON.stringify(['stats-markers', 'stats-attention', 'stats-footnotes']),
    JSON.stringify(on.order));
  check('the toggle row wraps', on.wrap === 'wrap', on.wrap);
  check('markers and footnotes start pressed', on.markersPressed === 'true' && on.footnotesPressed === 'true');
  check('on: marker glyphs and footnotes render', on.glyphs > 0 && on.calls > 0 && on.bodies > 0,
    `glyphs=${on.glyphs} calls=${on.calls} bodies=${on.bodies}`);
  check('markers feed the attention harvest', on.harvested > 0, String(on.harvested));

  // Release markers → re-paginated without glyphs.
  await toggle('#stats-markers');
  const mk = await state();
  check('markers released: button unpressed, no glyphs on the page',
    mk.markersPressed === 'false' && mk.glyphs === 0, `glyphs=${mk.glyphs}`);
  check('every hidden marker keeps its invisible data span',
    mk.dataSpans === on.glyphs + on.dataSpans, `${mk.dataSpans} vs ${on.glyphs + on.dataSpans}`);
  check('hidden markers still shape the envelope',
    mk.harvested === on.harvested && mk.overlays > 0, `${mk.harvested} vs ${on.harvested}`);
  check('the text reflows: closed-up lines pull more onto page 1',
    mk.layout[0] > on.layout[0], `${on.layout[0]} → ${mk.layout[0]}`);
  check('footnotes untouched by the markers toggle', mk.calls === on.calls && mk.bodies === on.bodies);

  // Release footnotes → notes gone, the body takes the whole page.
  await toggle('#stats-footnotes');
  const fn = await state();
  check('footnotes released: no calls, no note bodies',
    fn.footnotesPressed === 'false' && fn.calls === 0 && fn.bodies === 0, `calls=${fn.calls} bodies=${fn.bodies}`);
  check('the note area is given back: page 1 content is full height and holds more text',
    fn.contentH > on.contentH && fn.layout[0] > mk.layout[0],
    `h ${on.contentH} → ${fn.contentH}, chars ${mk.layout[0]} → ${fn.layout[0]}`);

  // An ordinary re-render keeps the hidden layers out.
  await page.evaluate(async () => {
    const before = document.body.dataset.paginated;
    await window.WriteSysRenderer.renderManuscript();
    await new Promise((res) => {
      const tick = () => (document.body.dataset.paginated !== before ? res() : setTimeout(tick, 50));
      tick();
    });
  });
  const re = await state();
  check('a later re-render stays hidden; buttons stay released',
    re.glyphs === 0 && re.calls === 0 && re.bodies === 0
    && re.markersPressed === 'false' && re.footnotesPressed === 'false'
    && JSON.stringify(re.layout) === JSON.stringify(fn.layout));

  // The re-render holds the reader's place: the top sentence on screen
  // keeps its viewport offset.
  const anchor = await page.evaluate(() => {
    window.scrollTo(0, 1400);
    const id = window.WriteSysRenderer.topVisibleSentenceId();
    const el = document.querySelector(`.pagedjs_pages .sentence[data-sentence-id="${id}"]`);
    return { id, top: el.getBoundingClientRect().top };
  });
  await toggle('#stats-footnotes');
  const after = await page.evaluate((id) =>
    document.querySelector(`.pagedjs_pages .sentence[data-sentence-id="${id}"]`).getBoundingClientRect().top, anchor.id);
  check('toggling keeps the top sentence where it was on screen',
    Math.abs(after - anchor.top) < 2, `${anchor.id}: ${anchor.top.toFixed(1)} → ${after.toFixed(1)}`);

  // Press markers back on → the original layout, exactly.
  await toggle('#stats-markers');
  const back = await state();
  check('both pressed again: glyphs and notes back, layout identical to the start',
    back.glyphs === on.glyphs && back.calls === on.calls && back.bodies === on.bodies
    && JSON.stringify(back.layout) === JSON.stringify(on.layout)
    && back.markersPressed === 'true' && back.footnotesPressed === 'true',
    JSON.stringify(back.layout) === JSON.stringify(on.layout) ? '' : `${on.layout} vs ${back.layout}`);

  // Gate: no marker eyes → no markers toggle; footnotes stay for everyone.
  const gated = await page.evaluate(() => {
    const saved = window.currentSession;
    window.currentSession = { accessible_manuscripts: [] };
    window.WriteSysStats.render();
    const r = { markers: !!document.getElementById('stats-markers'),
      footnotes: !!document.getElementById('stats-footnotes') };
    window.currentSession = saved;
    window.WriteSysStats.render();
    return r;
  });
  check('without see-markers/manage-suggestions → no markers toggle, footnotes remain',
    !gated.markers && gated.footnotes, JSON.stringify(gated));

  await browser.close();
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
