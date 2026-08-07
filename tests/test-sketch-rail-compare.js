// The snippet widget's RIGHT RAIL (replaced the tab bar + ▾ overflow):
//  - self letter on top, every sibling below it — ALL of them, no overflow;
//  - clicking a sibling opens a SPLIT compare (left self/editable, right the
//    sibling read-only); same letter closes it, another letter swaps it;
//  - sibling letters color-code state (frozen bluish, superseded reddish);
//  - superseded variations are EXCLUDED from the wordcount representative
//    ("canonized wins, then most recent non-superseded").
const { chromium } = require('playwright');
const { TEST_URL, TEST_MANUSCRIPT_ID, loginAsTestUser, cleanupTestNotes } = require('./test-utils');
const HOME_URL = new URL('home.html', TEST_URL).href;
const SYSTEM_TOKEN = 'dev-system-token-not-for-production';
const API = TEST_URL.replace(/\/$/, '') + '/api';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('dialog', d => d.accept());
  let failed = false;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed = true; };

  await cleanupTestNotes(); // stray linked snippets skew the wordcount check
  await loginAsTestUser(page);
  await page.goto(HOME_URL);
  await page.waitForSelector('#home-new-pad'); await page.click('#home-new-pad');
  await page.waitForSelector('.spm-overlay .ProseMirror');
  await page.locator('.spm-editor .ProseMirror').click();

  // Snippet with 9 extra variations → 10 letters total.
  const ids = await page.evaluate(async () => {
    const ed = window.WriteSysScratchpad;
    const a = await ed.insertSnippet();
    await ed.variationApi.saveText(a.variation.variation_id, 'alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha'); // 10 words
    const sibs = [];
    for (let i = 0; i < 9; i++) sibs.push((await ed.variationApi.createFrom(a.variation.variation_id)).variation.variation_id);
    return { a: a.variation.variation_id, sibs, snippet: a.snippet.snippet_id };
  });
  const padId = await page.evaluate(() => window.WriteSysScratchpad.scratchpadId);
  await page.click('#spm-close');
  await page.waitForSelector('.spm-overlay', { state: 'detached' });
  await page.evaluate((id) => window.WriteSysScratchpadModal.open(id), padId);
  await page.waitForSelector('.spm-editor .sn-widget .sn-rail');
  await page.waitForTimeout(600);

  const rail = await page.evaluate(() => {
    const w = document.querySelector('.sn-widget');
    return {
      letters: [...w.querySelectorAll('.sn-rail-btn')].map(b => b.textContent.trim()),
      selfTop: w.querySelector('.sn-rail-btn').classList.contains('sn-rail-self'),
      overflow: !!w.querySelector('.sn-more-btn'),
      firstTitle: w.querySelectorAll('.sn-rail-peer')[0].title,
    };
  });
  check('rail lists ALL 10 letters, self on top, no overflow',
    rail.letters.length === 10 && rail.selfTop && !rail.overflow, JSON.stringify(rail.letters));
  check('sibling tooltip says "Compare to variation …"', /^Compare to variation [A-Z]\./.test(rail.firstTitle), rail.firstTitle);

  // Open compare with B, swap to C, close on second click.
  const w = page.locator('.sn-widget').first();
  await w.locator('.sn-rail-peer', { hasText: 'B' }).click();
  await page.waitForTimeout(700);
  check('split opens (left+right panes)', await w.locator('.sn-split-left').count() === 1 && await w.locator('.sn-split-right').count() === 1);
  const rightB = await w.locator('.sn-split-right .sn-note').textContent();
  check('right pane is B, read-only', /B\s*· read-only/.test(rightB), JSON.stringify(rightB));
  await w.locator('.sn-rail-peer', { hasText: 'C' }).click();
  await page.waitForTimeout(700);
  const rightC = await w.locator('.sn-split-right .sn-note').textContent();
  check('clicking C swaps the right pane', /C\s*· read-only/.test(rightC), JSON.stringify(rightC));
  await w.locator('.sn-rail-peer', { hasText: 'C' }).click();
  await page.waitForTimeout(500);
  check('clicking C again closes the split', await w.locator('.sn-split-left').count() === 0);

  // Left pane stays editable while split.
  await w.locator('.sn-rail-peer', { hasText: 'B' }).click();
  await page.waitForTimeout(700);
  await w.locator('.sn-split-left .sn-render').click();
  check('left half is the editable self pane', await w.locator('.sn-split-left textarea').count() === 1);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);

  // State colors in the rail: supersede B, freeze C (via API + widget refresh).
  const csrf = await page.evaluate(() => sessionStorage.getItem('csrf_token'));
  const bId = ids.sibs[0], cId = ids.sibs[1];
  const put = (id, state) => page.evaluate(async ({ id, state, csrf }) => {
    const r = await fetch(`api/variations/${id}/state`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({ state }),
    });
    return r.status;
  }, { id, state, csrf });
  check('supersede B via API', (await put(bId, 'superseded')) === 204);
  check('freeze C via API', (await put(cId, 'frozen')) === 204);
  // Reopen the pad so widget A re-reads sibling states.
  await page.click('#spm-close');
  await page.waitForSelector('.spm-overlay', { state: 'detached' });
  await page.evaluate((id) => window.WriteSysScratchpadModal.open(id), padId);
  await page.waitForSelector('.spm-editor .sn-widget .sn-rail');
  await page.waitForTimeout(600);
  const colors = await page.evaluate(() => {
    const w = document.querySelector('.sn-widget');
    const byLetter = {};
    w.querySelectorAll('.sn-rail-peer').forEach(b => { byLetter[b.textContent.trim()] = b.className; });
    return byLetter;
  });
  check('B rail letter reddish (superseded)', /st-superseded/.test(colors.B), colors.B);
  check('C rail letter bluish (frozen)', /st-frozen/.test(colors.C), colors.C);

  // The Related/Based-on picker EXCLUDES superseded variations (frozen stay).
  const picker = await page.evaluate(async () => {
    const r = await fetch('api/variations?q=');
    return (await r.json()).variations.map((x) => x.variation_id);
  });
  check('picker excludes superseded B', !picker.includes(bId), JSON.stringify(picker.slice(0, 8)));
  check('picker still includes frozen C', picker.includes(cId));

  // Wordcount: link the snippet to the test manuscript, make B the MOST RECENT
  // (but superseded) — the representative must skip it.
  await page.evaluate(async ({ snippet, bId, csrf, mid }) => {
    await fetch(`api/snippets/${snippet}/link`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({ manuscript_id: mid }),
    });
  }, { snippet: ids.snippet, bId, csrf, mid: TEST_MANUSCRIPT_ID });
  // B superseded → can't save text; flip to draft, give it 3 words (most
  // recent now), then supersede again.
  await put(bId, 'draft');
  await page.evaluate(async ({ bId, csrf }) => {
    await fetch(`api/variations/${bId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({ text: 'beta beta beta' }),
    });
  }, { bId, csrf });
  await put(bId, 'superseded');
  const wc = await page.evaluate(async ({ tok, mid }) => {
    await fetch('api/admin/wordcount-compute', { method: 'POST', headers: { Authorization: 'Bearer ' + tok } });
    const r = await fetch(`api/manuscripts/${mid}/wordcount-history`);
    const rows = (await r.json()).rows || [];
    return rows.length ? rows[rows.length - 1] : null;
  }, { tok: SYSTEM_TOKEN, mid: TEST_MANUSCRIPT_ID });
  check('wordcount computed', !!wc, JSON.stringify(wc));
  // A (10 words) represents the group — NOT superseded B (3 words, most recent).
  check('representative skips superseded B (10 words, not 3)',
    wc && wc.words_snippets === 10, `words_snippets=${wc && wc.words_snippets}`);

  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('Test crashed:', e); process.exit(1); });
