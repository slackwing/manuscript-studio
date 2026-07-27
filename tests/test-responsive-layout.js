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
const { chromium } = require('playwright');
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
  // Force the outline to exist (the test manuscript has no command structure).
  await page.evaluate((o) => window.WriteSysOutline.render(o), SYNTH_OUTLINE);
  await page.waitForTimeout(150);
  return page.evaluate(() => {
    const q = s => document.querySelector(s);
    const rect = s => { const e = q(s); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, right: b.right, bottom: b.bottom }; };
    const outline = q('#outline-margin');
    return {
      controls: rect('#controls'),
      chrome: rect('#manuscript-chrome'),
      outline: rect('#outline-margin'),
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

  // ---- Desktop (1280): outline shows in the left gutter, no second bar. ----
  console.log('\n[desktop 1280×1000]');
  {
    const m = await measure(page, 1280, 1000);
    check('outline has-outline class', m.outlineHasClass, 'missing');
    check('outline visible', m.outlineDisplay !== 'none', `display=${m.outlineDisplay}`);
    check('outline in left gutter (x≈0)', m.outline && m.outline.x < 20, JSON.stringify(m.outline));
    check('outline below the chrome (stacked, not side-by-side)',
      m.outline && m.chrome && m.outline.y >= m.chrome.y, JSON.stringify({ outlineY: m.outline && m.outline.y, chromeY: m.chrome && m.chrome.y }));
    check('no horizontal overflow', m.docWidth <= m.winWidth + 1, `doc=${m.docWidth} win=${m.winWidth}`);
  }

  // ---- Tablet (900): second-bar layout must engage (was the 641–1100 dead zone). ----
  console.log('\n[tablet 900×1000]');
  {
    const m = await measure(page, 900, 1000);
    check('outline visible (NOT hidden in the 641–1100 zone)', m.outlineDisplay !== 'none', `display=${m.outlineDisplay}`);
    check('chrome + outline side-by-side, no overlap', !overlaps(m.chrome, m.outline),
      JSON.stringify({ chrome: m.chrome, outline: m.outline }));
    check('chrome is the left ~third (not full 290px desktop width)',
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
  if (failures) { console.log(`\n❌ ${failures} layout check(s) failed`); process.exit(1); }
  console.log('\n✅ responsive layout OK at desktop / tablet / mobile');
})().catch(e => { console.error(e); process.exit(1); });
