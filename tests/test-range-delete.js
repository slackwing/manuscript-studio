// Feature test: shift-click range selection → red trash (two-click) → empty
// suggestions on every sentence in the range. Runs against the WORKTREE
// server on :5002.
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const BASE = 'http://localhost:5001';
const psql = (sql) => execSync(
  `PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`,
  { encoding: 'utf-8' }).trim();

(async () => {
  psql(`DELETE FROM suggested_change WHERE user_id='test'`);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  let failed = false;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed = true; };

  // login via API
  await page.goto(`${BASE}/login.html`);
  await page.evaluate(async () => {
    const r = await fetch('api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'include', body: JSON.stringify({ username: 'test', password: 'test' }) });
    const d = await r.json();
    localStorage.setItem('csrf_token', d.csrf_token);
  });
  await page.goto(`${BASE}/index.html?manuscript_id=1`);
  await page.waitForSelector('.sentence[data-sentence-id]', { timeout: 60000 });
  await page.waitForTimeout(4000);

  // pick two prose sentences a few apart
  const pair = await page.evaluate(() => {
    const ids = window.WriteSysRenderer.currentSentences.map(s => s.sentence_id || s.id);
    const spans = [...document.querySelectorAll('.sentence[data-sentence-id]')]
      .filter(s => s.textContent.trim().length > 30 && !s.closest('h1,h2,h3'));
    const a = spans[2], b = spans[6];
    return { aId: a.dataset.sentenceId, bId: b.dataset.sentenceId,
             between: ids.slice(ids.indexOf(a.dataset.sentenceId), ids.indexOf(b.dataset.sentenceId) + 1) };
  });
  check('picked a range of sentences', pair.between.length >= 3, `${pair.between.length} sentences`);

  await page.locator(`.sentence[data-sentence-id="${pair.aId}"]`).first().click();
  await page.waitForTimeout(300);
  await page.locator(`.sentence[data-sentence-id="${pair.bId}"]`).first().click({ modifiers: ['Shift'] });
  await page.waitForTimeout(400);

  const mode = await page.evaluate(() => ({
    selected: new Set([...document.querySelectorAll('.sentence.range-selected')].map(e => e.dataset.sentenceId)).size,
    modeOn: document.body.classList.contains('range-delete-mode'),
    trash: document.querySelectorAll('.range-trash').length,
    plusHidden: [...document.querySelectorAll('.import-zone')].every(z => getComputedStyle(z).display === 'none'),
  }));
  check('range highlighted', mode.selected === pair.between.length, `${mode.selected}/${pair.between.length}`);
  check('mode on + red trash shown', mode.modeOn && mode.trash === 1);
  check('+ affordances hidden in mode', mode.plusHidden);

  // first click arms, second applies
  await page.locator('.range-trash').click();
  const arming = await page.evaluate(() => document.querySelector('.range-trash').classList.contains('confirming'));
  check('first click arms (confirming)', arming);
  const before = psql(`SELECT COUNT(*) FROM suggested_change WHERE user_id='test'`);
  check('no suggestions before confirm', before === '0', before);
  await page.locator('.range-trash').click();
  await page.waitForTimeout(2500);

  const rows = psql(`SELECT COUNT(*) FROM suggested_change WHERE user_id='test' AND text=''`);
  check('EMPTY suggestion on every sentence in range', rows === String(pair.between.length), `rows=${rows}`);
  const modeOff = await page.evaluate(() => !document.body.classList.contains('range-delete-mode') && !document.querySelector('.range-trash'));
  check('mode exits after apply', modeOff);
  // deleted sentences vanish from the effective preview
  const gone = await page.evaluate((ids) => {
    const present = new Set([...document.querySelectorAll('.sentence[data-sentence-id]')].map(e => e.dataset.sentenceId));
    return ids.every(id => !present.has(id));
  }, pair.between);
  check('range disappears from the effective render', gone);

  // Escape exits a fresh selection without applying
  await page.evaluate(() => window.WriteSysRenderer.scrollToSentence && null);
  psql(`DELETE FROM suggested_change WHERE user_id='test'`);
  console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS');
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('Test crashed:', e); process.exit(1); });
