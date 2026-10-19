/**
 * The landing card's ⚙ / daily-tasks buttons are the book chrome's: same
 * icons (WriteSysIcons — one definition), same .mc-btn look, daily blue in
 * both places. Plus the section head: "See all →" follows the count.
 */
const { chromium } = require('playwright');
const { TEST_URL, TEST_MANUSCRIPT_ID, loginAsTestUser, waitForPagination } = require('./test-utils');
const HOME = new URL('home.html', TEST_URL).href;

(async () => {
  console.log('=== Shared gear / daily icons ===\n');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  let failed = 0;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed++; };
  const read = (sel) => page.evaluate((s) => {
    const e = document.querySelector(s);
    if (!e) return null;
    const cs = getComputedStyle(e);
    return { svg: e.innerHTML.trim(), cls: e.className, color: cs.color, h: e.getBoundingClientRect().height, border: cs.borderTopWidth };
  }, sel);
  try {
    await loginAsTestUser(page);
    await page.goto(HOME);
    await page.waitForSelector(`.ms-daily-link[data-daily="${TEST_MANUSCRIPT_ID}"]`);
    const cardGear = await read(`.ms-gear[data-settings="${TEST_MANUSCRIPT_ID}"]`);
    const cardDaily = await read(`.ms-daily-link[data-daily="${TEST_MANUSCRIPT_ID}"]`);
    const expect = await page.evaluate(() => {
      const ser = (html) => { const d = document.createElement('div'); d.innerHTML = html; return d.innerHTML.trim(); };
      return { gear: ser(window.WriteSysIcons.gear(13)), daily: ser(window.WriteSysIcons.dailyTasks(13)) };
    });
    check('card gear draws WriteSysIcons.gear', cardGear && cardGear.svg === expect.gear);
    check('card daily draws WriteSysIcons.dailyTasks', cardDaily && cardDaily.svg === expect.daily);
    check('card buttons are .mc-btn', /mc-btn/.test(cardGear.cls) && /mc-btn/.test(cardDaily.cls));
    check('card daily is blue', cardDaily.color === 'rgb(42, 111, 176)', cardDaily.color);
    // "Scratchpads  16  See all →": the link follows the count, not the
    // far right edge.
    const heads = await page.evaluate(() => [...document.querySelectorAll('.home-section-head')]
      .filter(h => h.querySelector('.home-seeall'))
      .map(h => {
        const c = h.querySelector('.home-count').getBoundingClientRect();
        const a = h.querySelector('.home-seeall').getBoundingClientRect();
        return { gap: Math.round(a.left - c.right), sameLine: Math.abs(a.bottom - c.bottom) < 4 };
      }));
    check('"See all →" sits right after the count', heads.length > 0 && heads.every(h => h.gap >= 8 && h.gap <= 20 && h.sameLine), JSON.stringify(heads));
    check('no "daily tasks" text left on the card', !(await page.locator('.card-manuscript', { hasText: 'daily tasks' }).count()));

    await page.goto(TEST_URL);
    await waitForPagination(page);
    const bookGear = await read('#mc-settings');
    const bookDaily = await read('#mc-daily');
    check('book gear = card gear (markup)', bookGear.svg === cardGear.svg);
    check('book daily = card daily (markup)', bookDaily.svg === cardDaily.svg);
    check('book daily is blue', bookDaily.color === 'rgb(42, 111, 176)', bookDaily.color);
    check('same button box in both views', bookGear.h === cardGear.h && bookGear.border === cardGear.border, `${bookGear.h}/${cardGear.h}`);
  } catch (e) {
    check('run', false, e.message);
  }
  await browser.close();
  console.log(failed ? `\n❌ ${failed} failed` : '\n✅ all passed');
  process.exit(failed ? 1 : 0);
})();
