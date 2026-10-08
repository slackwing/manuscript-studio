// Stats-pane view toggles e2e: markers · attention · footnotes in one
// wrapping row. Markers and footnotes start ON; released, they hide their
// layer on the SETTLED pages without re-pagination (book.css
// html.<kind>-hidden + .pagedjs_pages[data-settled]). A hidden marker
// still feeds the attention harvest, and a re-render while hidden paginates
// exactly as if shown (Paged.js lays out before the pages settle).
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

  // Inject a manuscript with valued markers and footnotes, markers on.
  const render = () => page.evaluate(async () => {
    const before = document.body.dataset.paginated;
    await window.WriteSysRenderer.renderManuscript();
    await new Promise((res) => {
      const tick = () => (document.body.dataset.paginated !== before ? res() : setTimeout(tick, 50));
      tick();
    });
  });
  await page.evaluate(() => {
    window.WriteSysMarkerSymbols.display = true;
    window.WriteSysMarkerSymbols.map = {
      vivid: { symbol: 'diamond', attention: 10 },
      digression: { symbol: 'circle', attention: -15 },
    };
    const prose = 'The evening settled over the valley like a long held breath. ';
    const sentences = [];
    for (let i = 0; i < 40; i++) {
      let text = prose + `Sentence number ${i} carries the paragraph onward.`;
      // Dense markers: hidden glyphs during pagination would shorten
      // enough lines to move a page break (the re-render check below).
      text = `It was &marker#vivid tonight, said &marker#vivid number ${i}. ` + text;
      if (i % 3 === 0) text += ' Then &marker#digression it &marker#vivid wandered.';
      if (i % 9 === 2) text += `&footnote{Note on sentence ${i}.}`;
      sentences.push({ id: `vt-${i}`, sentence_id: `vt-${i}`, text: text + ' ' });
    }
    const R = window.WriteSysRenderer;
    R.currentSentences = sentences;
    R.sentenceMap = Object.fromEntries(sentences.map((s) => [s.id, s.text]));
  });
  await render();
  await page.evaluate(() => window.WriteSysStats.setPane('stats'));
  await page.waitForSelector('#stats-footnotes', { timeout: 8000 });

  const state = () => page.evaluate(() => {
    const glyph = document.querySelector('.pagedjs_pages .cmd-diamond-marker');
    const svg = glyph && glyph.querySelector('svg');
    const gr = glyph ? glyph.getBoundingClientRect() : null;
    const call = document.querySelector('.pagedjs_pages [data-footnote-call]');
    const area = document.querySelector('.pagedjs_pages .pagedjs_footnote_area .fn-body')
      .closest('.pagedjs_footnote_area');
    const pages = [...document.querySelectorAll('.pagedjs_pages .pagedjs_page')];
    const pressed = (id) => { const b = document.getElementById(id); return b && b.getAttribute('aria-pressed'); };
    return {
      order: [...document.querySelectorAll('.stats-toggles .stats-toggle')].map((b) => b.id),
      wrap: getComputedStyle(document.querySelector('.stats-toggles')).flexWrap,
      markersPressed: pressed('stats-markers'),
      footnotesPressed: pressed('stats-footnotes'),
      svgShown: !!svg && getComputedStyle(svg).display !== 'none',
      glyphW: gr ? gr.width : -1,
      glyphH: gr ? gr.height : -1,
      callShown: getComputedStyle(call).display !== 'none',
      areaShown: getComputedStyle(area).visibility === 'visible',
      paginated: document.body.dataset.paginated,
      // Where each page breaks, to the character: a break that moves by a
      // word changes the page's text length.
      layout: pages.map((p) => {
        const c = p.querySelector('.pagedjs_page_content');
        return c ? c.textContent.length : 0;
      }).join(' | '),
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
  check('on: marker glyphs, footnote calls and the note area show',
    on.svgShown && on.glyphW > 0 && on.callShown && on.areaShown, JSON.stringify(on));
  check('markers feed the attention harvest', on.harvested > 0, String(on.harvested));

  // Release markers.
  await page.click('#stats-markers');
  const mk = await state();
  check('markers released: button unpressed, glyphs hidden',
    mk.markersPressed === 'false' && !mk.svgShown, JSON.stringify(mk));
  check('a hidden marker collapses to zero width but keeps a positioned rect',
    mk.glyphW === 0 && mk.glyphH > 0, `w=${mk.glyphW} h=${mk.glyphH}`);
  check('no re-pagination on toggle', mk.paginated === on.paginated);
  check('hidden markers still shape the envelope (same harvest, overlays rebuilt)',
    mk.harvested === on.harvested && mk.overlays > 0, `${mk.harvested} vs ${on.harvested}`);
  check('footnotes untouched by the markers toggle', mk.callShown && mk.areaShown);

  // Release footnotes.
  await page.click('#stats-footnotes');
  const fn = await state();
  check('footnotes released: calls and note area hidden',
    fn.footnotesPressed === 'false' && !fn.callShown && !fn.areaShown, JSON.stringify(fn));
  check('no re-pagination on footnote toggle', fn.paginated === on.paginated);

  // Re-render while both are hidden: pagination matches the shown state,
  // and the fresh pages come out hidden.
  await render();
  const re = await state();
  check('re-render while hidden paginates exactly as when shown',
    re.layout === on.layout, re.layout === on.layout ? '' : `\n  shown:  ${on.layout}\n  hidden: ${re.layout}`);
  check('fresh pages stay hidden; buttons stay released',
    !re.svgShown && !re.callShown && !re.areaShown
    && re.markersPressed === 'false' && re.footnotesPressed === 'false', JSON.stringify(re));

  // Press both back on.
  await page.click('#stats-markers');
  await page.click('#stats-footnotes');
  const back = await state();
  check('pressed again: everything shows',
    back.svgShown && back.glyphW > 0 && back.callShown && back.areaShown
    && back.markersPressed === 'true' && back.footnotesPressed === 'true', JSON.stringify(back));

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
