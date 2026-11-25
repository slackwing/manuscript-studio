// The syntax cheatsheet is a TAB (2026-11-25): the ⓘ between the gear and
// Logout opens it in the shell; the page is a terse list of command shapes.
const { chromium } = require('playwright');
const { TEST_URL, loginAsTestUser } = require('./test-utils');
const HOME_URL = new URL('home.html', TEST_URL).href;

(async () => {
  console.log('=== syntax cheatsheet tab ===\n');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  let failed = 0;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed++; };
  await loginAsTestUser(page);

  for (const [label, url] of [['shell', HOME_URL], ['book page', TEST_URL]]) {
    await page.goto(url);
    await page.waitForSelector('#cheatsheet-link', { timeout: 20000 });
    const order = await page.evaluate(() => [...document.querySelectorAll('#controls .control-group-right > *')].map((e) => e.id));
    check(`${label}: the ⓘ sits between the gear and Logout`, JSON.stringify(order) === JSON.stringify(['settings-link', 'cheatsheet-link', 'logout-btn']), JSON.stringify(order));
  }

  await page.goto(HOME_URL);
  await page.waitForSelector('#cheatsheet-link');
  await page.click('#cheatsheet-link');
  await page.waitForSelector('#ms-tabs .ms-tab-cheatsheet.active', { timeout: 10000 });
  await page.waitForSelector('#ms-tab-panels iframe[src*="cheatsheet.html"].active', { timeout: 10000 });
  check('clicking ⓘ opens the cheatsheet as an active icon tab with its own panel',
    await page.evaluate(() => !!document.querySelector('#ms-tabs .ms-tab-cheatsheet.active svg') && location.hash === '#tab=c1'));
  const frame = page.frames().find((f) => f.url().includes('cheatsheet.html'));
  await frame.waitForSelector('.cheatsheet-code', { timeout: 10000 });
  const content = await frame.evaluate(() => ({
    rows: [...document.querySelectorAll('.cheatsheet-code')].map((c) => c.textContent),
    descs: document.querySelectorAll('.cheatsheet-desc').length,
    sections: [...document.querySelectorAll('.cheatsheet-h')].map((h) => h.textContent),
    longest: Math.max(...[...document.querySelectorAll('.cheatsheet-code')].map((c) => c.textContent.length)),
    embedded: document.documentElement.classList.contains('embedded'),
  }));
  const has = (s) => content.rows.some((r) => r.includes(s));
  check('the sheet lists the command shapes, parameters NAMED (<title>, not …), optionals in [ ]',
    has('&title{<title>}') && has('&chapter#<slug>{<number>}[{<title>}]') && has('&placeholder[#<slug>]{sentences|paragraphs}[{xs|s|m|l|xl|xxl|xxxl}][{<label>}]')
    && has('&footnote{<text>}') && has('&marker#<slug>{[weak|strong]}') && has('&meta{font}{<family>}') && has('&anchor#<slug>{[<label>]}')
    && !content.rows.some((r) => r.includes('…') && !r.includes('&end')), content.rows.slice(0, 5).join(' | '));
  check('it is terse: shapes only, no descriptions, short section names', content.descs === 0 && content.sections.every((s) => s.split(/\s+/).length <= 4) && content.longest < 80, JSON.stringify({ descs: content.descs, sections: content.sections, longest: content.longest }));
  check('the panel page hides its own chrome (embedded)', content.embedded === true);
  // Second click: no second tab.
  await page.click('#cheatsheet-link');
  await page.waitForTimeout(300);
  check('one cheatsheet tab, ever', (await page.locator('#ms-tabs .ms-tab-cheatsheet').count()) === 1);
  await page.evaluate(() => { localStorage.removeItem('ms_pinned_tabs'); localStorage.removeItem('ms_split'); sessionStorage.removeItem('ms_split_session'); });
  await browser.close();
  console.log(failed ? `\n❌ ${failed} check(s) failed` : '\n✅ Test passed');
  process.exit(failed ? 1 : 0);
})();
