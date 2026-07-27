/**
 * Responsive layout regression test (AGENTS N12).
 *
 * Guards the top bar + manuscript-chrome (info) + outline layout at three
 * viewport widths. These regressed once when the mobile @media block sat above
 * the base desktop rules in book.css and lost the equal-specificity source-order
 * tie: on desktop the outline vanished; at narrow widths the 290px desktop info
 * chrome overlapped the outline. This test asserts the geometry that was broken.
 *
 * The shared test manuscript has no &part/&chapter command structure, so it
 * renders no outline on its own — we inject a synthetic outline via
 * WriteSysOutline.render() to exercise the .has-outline layout deterministically.
 */
const { chromium, devices } = require('playwright');
const { TEST_URL, loginAsTestUser, waitForPagination } = require('./test-utils');

const SYNTH_OUTLINE = {
  title: { name: 'Test Book', slug: 'test-book', sentence_id: 1 },
  parts: [{
    label: 'Part One', description: '', slug: 'p1', sentence_id: 2,
    chapters: [
      { label: 'I', description: 'First', slug: 'c1', sentence_id: 3, anchors: [] },
      { label: 'II', description: 'Second', slug: 'c2', sentence_id: 4, anchors: [] },
    ],
    anchors: [],
  }],
  top_chapters: [], top_anchors: [],
};

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  ✓ ${name}`); }
  else { console.log(`  ✗ ${name} — ${detail}`); failures++; }
}

async function measure(page, width, height) {
  await page.setViewportSize({ width, height });
  // Force the outline to exist (the test manuscript has no command structure),
  // then fire resize so annotations.js positionGutters recomputes the mirrored
  // left/right offsets for the new viewport width.
  await page.evaluate((o) => window.WriteSysOutline.render(o), SYNTH_OUTLINE);
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  await page.waitForTimeout(150);
  return page.evaluate(() => {
    const q = s => document.querySelector(s);
    const rect = s => { const e = q(s); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, right: b.right, bottom: b.bottom }; };
    const outline = q('#outline-margin');
    return {
      controls: rect('#controls'),
      chrome: rect('#manuscript-chrome'),
      outline: rect('#outline-margin'),
      annotation: rect('#annotation-margin'),
      page: rect('.pagedjs_page'),
      outlineDisplay: outline ? getComputedStyle(outline).display : 'MISSING',
      outlineHasClass: outline ? outline.classList.contains('has-outline') : false,
      brandLines: (() => {
        const b = q('#brand'); if (!b) return 0;
        const lh = parseFloat(getComputedStyle(b).lineHeight) || 20;
        return Math.round(b.getBoundingClientRect().height / lh);
      })(),
      docWidth: document.documentElement.scrollWidth,
      winWidth: window.innerWidth,
    };
  });
}

function overlaps(a, b) {
  if (!a || !b) return false;
  return a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom;
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  await loginAsTestUser(page);
  await page.goto(TEST_URL);
  await waitForPagination(page);
  await page.waitForFunction(() => !!window.WriteSysOutline, null, { timeout: 10000 });

  // ---- Desktop (1400): outline in the left gutter, ANCHORED to the page edge,
  //      mirroring the sticky-note gutter on the right (the design rule). ----
  console.log('\n[desktop 1400×1000]');
  {
    const m = await measure(page, 1400, 1000);
    const GAP = 32, BAND = 300;
    check('outline has-outline class', m.outlineHasClass, 'missing');
    check('outline visible', m.outlineDisplay !== 'none', `display=${m.outlineDisplay}`);
    check('outline below the chrome (stacked, not side-by-side)',
      m.outline && m.chrome && m.outline.y >= m.chrome.y, JSON.stringify({ outlineY: m.outline && m.outline.y, chromeY: m.chrome && m.chrome.y }));
    check('chrome shares the outline\'s left (same band)',
      m.outline && m.chrome && Math.abs(m.outline.x - m.chrome.x) <= 1, JSON.stringify({ outlineX: m.outline && m.outline.x, chromeX: m.chrome && m.chrome.x }));
    // The mirror: outline right edge sits GAP px left of the page's left edge.
    check(`outline anchored ${GAP}px left of the page edge (not viewport-pinned)`,
      m.page && m.outline && Math.abs((m.page.x - m.outline.right) - GAP) <= 2,
      JSON.stringify({ pageLeft: m.page && m.page.x, outlineRight: m.outline && m.outline.right }));
    check('outline band is the shared 300px width',
      m.outline && Math.abs(m.outline.w - BAND) <= 1, `w=${m.outline && m.outline.w}`);
    check('no horizontal overflow', m.docWidth <= m.winWidth + 1, `doc=${m.docWidth} win=${m.winWidth}`);
  }

  // ---- Just below the 1240px breakpoint: must already be the second bar
  //      (the outline band no longer fits beside the page — the design rule). ----
  console.log('\n[below breakpoint 1200×1000]');
  {
    const m = await measure(page, 1200, 1000);
    check('second bar engaged (chrome not full desktop band)',
      m.chrome && m.chrome.w < m.winWidth * 0.45, `chromeW=${m.chrome && m.chrome.w}`);
    check('chrome + outline no overlap', !overlaps(m.chrome, m.outline),
      JSON.stringify({ chrome: m.chrome, outline: m.outline }));
    check('no horizontal overflow', m.docWidth <= m.winWidth + 1, `doc=${m.docWidth} win=${m.winWidth}`);
    // In this wide-mobile range the (unscaled) page must be CENTERED, not glued
    // to the left with a big empty area on the right.
    if (m.page) {
      const leftMargin = m.page.x;
      const rightMargin = m.winWidth - m.page.right;
      check('page is centered (even margins), not left-glued',
        Math.abs(leftMargin - rightMargin) <= 4 && leftMargin > 20,
        JSON.stringify({ leftMargin: Math.round(leftMargin), rightMargin: Math.round(rightMargin) }));
    }
  }

  // ---- Tablet (900): second-bar layout. ----
  console.log('\n[tablet 900×1000]');
  {
    const m = await measure(page, 900, 1000);
    check('outline visible', m.outlineDisplay !== 'none', `display=${m.outlineDisplay}`);
    check('chrome + outline side-by-side, no overlap', !overlaps(m.chrome, m.outline),
      JSON.stringify({ chrome: m.chrome, outline: m.outline }));
    check('chrome is the left ~third (not full desktop band)',
      m.chrome && m.chrome.w < m.winWidth * 0.45, `chromeW=${m.chrome && m.chrome.w}`);
    check('outline starts right of the chrome', m.outline && m.chrome && m.outline.x >= m.chrome.right - 2,
      JSON.stringify({ outlineX: m.outline && m.outline.x, chromeRight: m.chrome && m.chrome.right }));
    check('no horizontal overflow', m.docWidth <= m.winWidth + 1, `doc=${m.docWidth} win=${m.winWidth}`);
  }

  // ---- Mobile (390): compact bar, one-line wordmark. ----
  console.log('\n[mobile 390×844]');
  {
    const m = await measure(page, 390, 844);
    check('outline visible', m.outlineDisplay !== 'none', `display=${m.outlineDisplay}`);
    check('chrome + outline no overlap', !overlaps(m.chrome, m.outline),
      JSON.stringify({ chrome: m.chrome, outline: m.outline }));
    check('top bar is short (≤52px)', m.controls && m.controls.h <= 52, `h=${m.controls && m.controls.h}`);
    check('wordmark on one line', m.brandLines <= 1, `lines=${m.brandLines}`);
    check('no horizontal overflow', m.docWidth <= m.winWidth + 1, `doc=${m.docWidth} win=${m.winWidth}`);
  }

  await browser.close();

  // ---- Real mobile device (Pixel 7: DPR 2.6, mobile UA). This is the case a
  //      plain small window MISSES: transform: scale() leaves the un-scaled page
  //      width in the layout, so the document was wider than the viewport and
  //      the device zoomed out to fit ("starts zoomed in, scrolls right, gap on
  //      the right"). Assert the document is exactly viewport-width. ----
  console.log('\n[device Pixel 7]');
  {
    const dev = await chromium.launch();
    const ctx = await dev.newContext({ ...devices['Pixel 7'] });
    const dpage = await ctx.newPage();
    await loginAsTestUser(dpage);
    await dpage.goto(TEST_URL);
    await waitForPagination(dpage);
    await dpage.evaluate((o) => window.WriteSysOutline.render(o), SYNTH_OUTLINE);
    await dpage.waitForTimeout(400);
    const d = await dpage.evaluate(() => ({
      vw: document.documentElement.clientWidth,
      docScrollW: document.documentElement.scrollWidth,
      bodyScrollW: document.body.scrollWidth,
      winInner: window.innerWidth,
      scale: window.visualViewport ? window.visualViewport.scale : 1,
    }));
    // ≤2px slop for sub-pixel rounding at DPR 2.6.
    check('document is not wider than the viewport (no zoom-out / right-scroll)',
      d.docScrollW <= d.vw + 2 && d.bodyScrollW <= d.vw + 2 && d.winInner <= d.vw + 2,
      JSON.stringify(d));
    check('loads at 1:1 (visualViewport scale ~1)', Math.abs(d.scale - 1) < 0.02, `scale=${d.scale}`);
    await dev.close();
  }

  if (failures) { console.log(`\n❌ ${failures} layout check(s) failed`); process.exit(1); }
  console.log('\n✅ responsive layout OK at desktop / tablet / mobile / device');
})().catch(e => { console.error(e); process.exit(1); });
