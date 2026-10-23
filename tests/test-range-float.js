// The range button stack floats (2026-10-23): one fixed column in the
// page's left gutter — ✓ / copy / sketch / trash — that holds the middle of
// the screen while the selection spans it, and pegs to the selection's top
// (scrolled above it) or bottom (scrolled below it) edge. It used to be
// pinned beside the selection's first page, so a long or low-starting
// range left most of the stack off screen ("I only see the ✓").
// SHOT_DIR=<dir> saves screenshots.
const { chromium } = require('playwright');
const { TEST_URL, loginAsTestUser, waitForPagination, cleanupTestAnnotations } = require('./test-utils');

(async () => {
  let failed = false;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed = true; };
  const shot = async (p, name) => { if (process.env.SHOT_DIR) await p.screenshot({ path: `${process.env.SHOT_DIR}/${name}.png` }); };
  await cleanupTestAnnotations();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 700 } });
    await loginAsTestUser(page);
    await page.goto(TEST_URL);
    await waitForPagination(page);
    const spans = page.locator('.pagedjs_pages p .sentence[data-sentence-id]');
    // Scroll events land on the next frame — measure after two.
    const geo = () => page.evaluate(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)))).then(() => page.evaluate(() => {
      const st = document.querySelector('.range-stack');
      if (!st) return null;
      const r = st.getBoundingClientRect();
      const sel = [...document.querySelectorAll('.sentence.range-selected')].map((e) => e.getBoundingClientRect()).filter((x) => x.height);
      const btns = [...st.querySelectorAll('.range-trash')].map((b) => {
        const q = b.getBoundingClientRect();
        const t = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2);
        return !!t && b.contains(t);
      });
      return { top: r.top, bottom: r.bottom, mid: (r.top + r.bottom) / 2, screenMid: innerHeight / 2,
        selTop: Math.min(...sel.map((x) => x.top)), selBottom: Math.max(...sel.map((x) => x.bottom)),
        allClickable: btns.length >= 3 && btns.every(Boolean), n: btns.length };
    }));
    const near = (a, b) => Math.abs(a - b) <= 2;
    const r = (g) => JSON.stringify(g && { top: Math.round(g.top), bottom: Math.round(g.bottom), sel: [Math.round(g.selTop), Math.round(g.selBottom)], n: g.n, ok: g.allClickable });

    // A long range: 6 → 40 (several screens at 700px).
    await spans.nth(6).scrollIntoViewIfNeeded();
    await spans.nth(6).click();
    await spans.nth(40).scrollIntoViewIfNeeded();
    await spans.nth(40).click({ modifiers: ['Shift'] });
    await page.waitForSelector('.range-stack');
    let g = await geo();
    check('right after the shift-click, every button is on screen and clickable', g.allClickable && g.top >= 0 && g.bottom <= 700, r(g));
    await shot(page, 'float-after-click');

    await spans.nth(22).evaluate((e) => e.scrollIntoView({ block: 'center' }));
    g = await geo();
    check('selection spans the screen → the stack holds the middle', g.selTop < g.screenMid && g.selBottom > g.screenMid && near(g.mid, g.screenMid) && g.allClickable, r(g));
    await shot(page, 'float-middle');

    await page.evaluate(() => window.scrollBy(0, -window.innerHeight * 0.9));
    await spans.nth(6).evaluate((e) => window.scrollBy(0, e.getBoundingClientRect().top - window.innerHeight * 0.75));
    g = await geo();
    check('scrolled above the selection → pegged to its top edge', g.selTop > g.screenMid && near(g.top, g.selTop), r(g));
    await shot(page, 'float-top');

    await spans.nth(40).evaluate((e) => window.scrollBy(0, e.getBoundingClientRect().bottom - window.innerHeight * 0.25));
    g = await geo();
    check('scrolled below the selection → pegged to its bottom edge', g.selBottom < g.screenMid && near(g.bottom, g.selBottom), r(g));
    await shot(page, 'float-bottom');

    // A short range: the stack stays within it (centered when shorter).
    await page.keyboard.press('Escape');
    check('Escape removes the stack', !(await page.locator('.range-stack').count()));
    await spans.nth(10).evaluate((e) => e.scrollIntoView({ block: 'center' }));
    await spans.nth(10).click();
    await spans.nth(11).click({ modifiers: ['Shift'] });
    await page.waitForSelector('.range-stack');
    g = await geo();
    const within = g.selBottom - g.selTop <= g.bottom - g.top
      ? near(g.mid, (g.selTop + g.selBottom) / 2)
      : g.top >= g.selTop - 1 && g.bottom <= g.selBottom + 1;
    check('short range: the stack stays with it', within && g.allClickable, r(g));
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.mouse.click(5, 350); // plain click elsewhere exits
    await page.evaluate(() => window.scrollBy(0, 200));
    check('exiting drops the stack and its scroll listener (no errors on scroll)', !(await page.locator('.range-stack').count()) && !errs.length, errs.join(' | '));
  } catch (e) {
    check('run', false, e.message);
  }
  await browser.close();
  console.log(failed ? '\n❌ some checks failed' : '\n✅ all passed');
  process.exit(failed ? 1 : 0);
})();
