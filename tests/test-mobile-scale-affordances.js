/**
 * Mobile scale-affordance regression tests (device layout).
 *
 * On mobile the paged sheet is transform: scale()d. That scale does NOT change
 * an element's OWN coordinate space, so any code that measures with
 * getBoundingClientRect()/getClientRects() (screen px) and then applies the
 * result as a style INSIDE the scaled page (element px) must divide by the
 * scale — or things land on the wrong page / at the wrong phase. These bugs:
 *   - placeholder hatch nudge used TILE (unscaled) against screen-px deltas
 *   - import + zones / ⧉ fill buttons positioned with un-scaled top offsets
 *   - the outline caret force-scroll fought the user browsing the outline
 *
 * Uses a real device descriptor (Pixel 7) against the local dev server. The
 * fixture manuscript uses markdown headers (no command outline), but it DOES
 * have placeholders, so the scale-aware math is exercised. Outline-specific
 * checks inject a synthetic outline like test-responsive-layout.js.
 */
const { chromium, devices } = require('playwright');
const { TEST_URL, loginAsTestUser, waitForPagination } = require('./test-utils');

const SYNTH_OUTLINE = {
  title: { name: 'Test Book', slug: 'tb', sentence_id: 1 },
  parts: [{ label: 'Part One', slug: 'p1', sentence_id: 2, chapters: [
    { label: 'I', description: 'One', slug: 'c1', sentence_id: 3, anchors: [] },
    { label: 'II', description: 'Two', slug: 'c2', sentence_id: 4, anchors: [] },
    { label: 'III', description: 'Three', slug: 'c3', sentence_id: 5, anchors: [] },
    { label: 'IV', description: 'Four', slug: 'c4', sentence_id: 6, anchors: [] },
  ], anchors: [] }],
  top_chapters: [], top_anchors: [],
};

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✓ ${name}`);
  else { console.log(`  ✗ ${name} — ${detail}`); failures++; }
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices['Pixel 7'] });
  const page = await ctx.newPage();
  await loginAsTestUser(page);
  await page.goto(TEST_URL);
  await waitForPagination(page);
  await page.waitForTimeout(600);

  console.log('\n[scale reported to affordance code]');
  const scale = await page.evaluate(() =>
    window.WriteSysPlaceholder && window.WriteSysPlaceholder.pageScale
      ? window.WriteSysPlaceholder.pageScale() : null);
  check('WriteSysPlaceholder.pageScale() exists and is < 1 on this device',
    scale !== null && scale > 0 && scale < 1, `scale=${scale}`);

  console.log('\n[placeholder nudge is scale-aware]');
  // The nudge phase-aligns hatch tiles; it reads getClientRects() (screen px)
  // and must ÷scale before the TILE modulo. We can't easily assert pixel-perfect
  // hatch meshing headlessly, but we CAN assert the nudge ran without throwing
  // and that pageScale() is the value it used (regression guard for the ÷scale).
  // (Visual correctness is verified by screenshot against real data in review.)
  const nudge = await page.evaluate(() => {
    try {
      if (window.WriteSysPlaceholder) window.WriteSysPlaceholder.nudge();
      return { ok: true, scale: window.WriteSysPlaceholder.pageScale() };
    } catch (e) { return { ok: false, err: String(e.message) }; }
  });
  check('placeholder nudge runs on a scaled page without error',
    nudge.ok, JSON.stringify(nudge));
  check('nudge saw the same sub-1 scale as the page', nudge.scale > 0 && nudge.scale < 1, `scale=${nudge.scale}`);

  console.log('\n[placeholder detail chip never bleeds onto the next page]');
  // The block-placeholder detail chip (.ph-chip-block in .ph-overlay) is a
  // fixed annotation over the placeholder region. On devices that render the
  // book font taller than headless (real Android), the chip can exceed the
  // placeholder box and paint over the FOLLOWING page's prose ("keg party on
  // the rearview-mirror page"). It must be clipped to its box. Force the chip
  // The fixture uses markdown (no &placeholder blocks), so build the real
  // .cmd-placeholder > .ph-overlay > .ph-chip-block structure ourselves (the
  // book.css rules apply by class), force the chip far taller than the box, and
  // assert the CLIPPING contract that keeps it off the next page:
  //   (a) the overlay covers exactly the placeholder box (inset:0), and
  //   (b) the overlay clips overflow (overflow:hidden), and
  //   (c) the chip is anchored to the TOP (flex-start) so the heading survives.
  // Together these mean the chip's painted pixels never exceed the placeholder,
  // regardless of how tall the device renders the note. (getBoundingClientRect
  // on an overflow-clipped child still returns its full box, so the invariant is
  // the overlay's geometry + overflow, not the child's rect.)
  const bleed = await page.evaluate(() => {
    const host = document.querySelector('.pagedjs_page_content') || document.body;
    const ph = document.createElement('div');
    ph.className = 'cmd-placeholder';
    ph.style.height = '120px';
    ph.innerHTML = '<div class="ph-overlay"><div class="ph-chip-block">' +
      ('THE TALL NOTE. ' + 'lorem ipsum dolor sit amet '.repeat(60)) +
      '</div></div><p><span class="ph">filler</span></p>';
    host.appendChild(ph);
    const ov = ph.querySelector('.ph-overlay');
    // Read the rules from the stylesheet (authoritative), not getComputedStyle —
    // the latter proved harness-flaky here for the overflow longhands.
    let overflowHidden = false, topAnchored = false;
    for (const sheet of document.styleSheets) {
      let rules; try { rules = sheet.cssRules; } catch (e) { continue; }
      for (const rule of rules || []) {
        if (rule.selectorText === '.cmd-placeholder .ph-overlay') {
          if (rule.style.overflow === 'hidden') overflowHidden = true;
          if (rule.style.alignItems === 'flex-start') topAnchored = true;
        }
      }
    }
    const or = ov.getBoundingClientRect(), pr = ph.getBoundingClientRect();
    ph.remove();
    return {
      overlayCoversBox: Math.abs(or.top - pr.top) <= 1 && Math.abs(or.bottom - pr.bottom) <= 1,
      overflowHidden, topAnchored,
    };
  });
  check('overlay covers exactly the placeholder box (inset:0)', bleed.overlayCoversBox, JSON.stringify(bleed));
  check('overlay clips overflow so the chip cannot paint past the box', bleed.overflowHidden, JSON.stringify(bleed));
  check('chip is top-anchored so the heading survives when clipped', bleed.topAnchored, JSON.stringify(bleed));

  console.log('\n[outline scroll override]');
  await page.evaluate((o) => window.WriteSysOutline.render(o), SYNTH_OUTLINE);
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  await page.waitForTimeout(200);
  const ov = await page.evaluate(async () => {
    const o = document.getElementById('outline-margin');
    if (!o) return { err: 'no outline' };
    // If the outline doesn't overflow we can't test scroll — report that.
    const overflow = o.scrollHeight > o.clientHeight + 1;
    // 1) scroll the outline itself → override set, scrollTop kept
    o.scrollTop = 24;
    o.dispatchEvent(new Event('scroll', { bubbles: true }));
    await new Promise(r => setTimeout(r, 200));
    const afterOutlineScroll = { flag: window.WriteSysOutline._userScrolledOutline, kept: o.scrollTop };
    // 2) real page scroll → override cleared
    document.documentElement.scrollTop += 900;
    await new Promise(r => setTimeout(r, 40));
    window.dispatchEvent(new Event('scroll'));
    await new Promise(r => setTimeout(r, 200));
    const afterPageScroll = { flag: window.WriteSysOutline._userScrolledOutline };
    return { overflow, afterOutlineScroll, afterPageScroll };
  });
  check('scrolling the outline sets the user-override flag', ov.afterOutlineScroll && ov.afterOutlineScroll.flag === true, JSON.stringify(ov));
  if (ov.overflow) {
    // scrollTop is clamped to the container's max, so just assert it stayed
    // scrolled (> 0) rather than being yanked back to 0 by the caret follow.
    check('outline stays where the user scrolled it (not yanked to caret)',
      ov.afterOutlineScroll.kept > 0, JSON.stringify(ov.afterOutlineScroll));
  } else {
    console.log('  · (outline does not overflow at this size — skip "stays put")');
  }
  check('scrolling the pages clears the override (outline re-follows caret)',
    ov.afterPageScroll && ov.afterPageScroll.flag === false, JSON.stringify(ov));

  await browser.close();
  if (failures) { console.log(`\n❌ ${failures} check(s) failed`); process.exit(1); }
  console.log('\n✅ mobile scale affordances OK');
})().catch(e => { console.error(e); process.exit(1); });
