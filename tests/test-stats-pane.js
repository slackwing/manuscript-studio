// Statistics pane (STATS_PLAN) e2e: the OUTLINE/STATISTICS tabs in the
// manuscript chrome, the stats pane's birthday/word-goal metadata (API +
// inline editors), and the progress mini-graph.
//
// Flow: reset meta → API defaults (goal 40000, birthday null) → PATCH
// validation → seed 11 days of wordcount_history → browser: switch tabs,
// set birthday via the inline date editor, graph renders with the actual
// series + 3 extrapolation hover targets, edit goal to 80000, pane choice
// survives reload, mobile second-bar placement → cleanup.
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const {
  TEST_MANUSCRIPT_ID, API_BASE_URL, TEST_URL, TEST_USERNAME, TEST_PASSWORD,
  loginAsTestUser, waitForPagination,
} = require('./test-utils');

function psql(sql) {
  const escaped = sql.replace(/"/g, '\\"');
  return execSync(
    `PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -v ON_ERROR_STOP=1 -At -c "${escaped}"`,
    { encoding: 'utf-8', stdio: 'pipe' }
  );
}

function resetMeta() {
  psql(`UPDATE manuscript SET birthday = NULL, word_goal = 40000 WHERE manuscript_id = ${TEST_MANUSCRIPT_ID}`);
  psql(`DELETE FROM wordcount_history WHERE manuscript_id = ${TEST_MANUSCRIPT_ID}`);
}

(async () => {
  console.log('=== statistics pane e2e ===\n');
  let failed = 0;
  const check = (name, ok, detail = '') => {
    console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` (${detail})` : ''}`);
    if (!ok) failed++;
  };

  resetMeta();

  // --- login (cookie + CSRF from the login response) ---
  const loginResp = await fetch(`${API_BASE_URL}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: TEST_USERNAME, password: TEST_PASSWORD }),
  });
  if (!loginResp.ok) throw new Error(`login failed: ${loginResp.status}`);
  const login = await loginResp.json();
  const cookie = (loginResp.headers.get('set-cookie') || '').split(';')[0];
  const authed = (path, opts = {}) => fetch(`${API_BASE_URL}${path}`, {
    ...opts,
    headers: {
      Cookie: cookie,
      'X-CSRF-Token': login.csrf_token,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });

  // --- API: defaults + PATCH validation ---
  let resp = await authed(`/manuscripts/${TEST_MANUSCRIPT_ID}/wordcount-history`);
  let data = await resp.json();
  check('wordcount-history carries word_goal default 40000', data.word_goal === 40000, `got ${data.word_goal}`);
  check('wordcount-history carries birthday null when unset', data.birthday === null, `got ${data.birthday}`);

  resp = await authed(`/manuscripts/${TEST_MANUSCRIPT_ID}/meta`, {
    method: 'PATCH', body: JSON.stringify({ word_goal: 0 }),
  });
  check('PATCH rejects word_goal 0', resp.status === 400, `status ${resp.status}`);
  resp = await authed(`/manuscripts/${TEST_MANUSCRIPT_ID}/meta`, {
    method: 'PATCH', body: JSON.stringify({ birthday: 'yesterday' }),
  });
  check('PATCH rejects malformed birthday', resp.status === 400, `status ${resp.status}`);
  resp = await authed(`/manuscripts/${TEST_MANUSCRIPT_ID}/meta`, {
    method: 'PATCH', body: JSON.stringify({}),
  });
  check('PATCH rejects empty body', resp.status === 400, `status ${resp.status}`);

  resp = await authed(`/manuscripts/${TEST_MANUSCRIPT_ID}/meta`, {
    method: 'PATCH', body: JSON.stringify({ word_goal: 55000 }),
  });
  data = await resp.json();
  check('PATCH word_goal alone works', resp.ok && data.word_goal === 55000, `got ${data.word_goal}`);
  check('PATCH word_goal leaves birthday unchanged', data.birthday === null, `got ${data.birthday}`);
  resp = await authed(`/manuscripts/${TEST_MANUSCRIPT_ID}/meta`, {
    method: 'PATCH', body: JSON.stringify({ word_goal: 40000 }),
  });
  check('PATCH word_goal back to 40000', resp.ok, `status ${resp.status}`);

  // --- seed 11 days of history: 1000 → 2000 words, linear ---
  for (let i = 10; i >= 0; i--) {
    const total = 1000 + (10 - i) * 100;
    psql(`INSERT INTO wordcount_history (manuscript_id, day, words_committed, words_effective, words_snippets)
          VALUES (${TEST_MANUSCRIPT_ID}, CURRENT_DATE - ${i}, ${total}, ${total}, 0)
          ON CONFLICT (manuscript_id, day) DO UPDATE SET words_committed = EXCLUDED.words_committed,
            words_effective = EXCLUDED.words_effective, words_snippets = EXCLUDED.words_snippets`);
  }

  // --- browser ---
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  await loginAsTestUser(page);
  await page.goto(TEST_URL);
  await waitForPagination(page);

  const tabCount = await page.locator('#pane-tabs .pane-tab').count();
  check('two pane tabs render', tabCount === 2, `got ${tabCount}`);
  const outlineActive = await page.locator('#pane-tabs .pane-tab[data-pane="outline"]').evaluate(el => el.classList.contains('active'));
  check('outline tab active by default', outlineActive);
  const statsHidden = await page.locator('#stats-margin').evaluate(el => getComputedStyle(el).display === 'none');
  check('stats pane hidden by default', statsHidden);

  await page.locator('#pane-tabs .pane-tab[data-pane="stats"]').click();
  await page.waitForFunction(() => {
    const el = document.getElementById('stats-margin');
    return el && getComputedStyle(el).display !== 'none';
  });
  check('clicking STATISTICS shows the stats pane', true);
  const outlineOff = await page.locator('#outline-margin').evaluate(el => getComputedStyle(el).display === 'none');
  check('outline hides while stats shown', outlineOff);

  // Birthday unset → prompt; set it through the inline date editor.
  await page.waitForSelector('#stats-birthday');
  let bdayText = await page.locator('#stats-birthday').innerText();
  check('birthday shows set-me prompt when null', /set birthday/i.test(bdayText), bdayText);
  await page.locator('#stats-birthday').click();
  await page.fill('#stats-margin .stats-edit-input', '2025-12-02');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => {
    const el = document.querySelector('#stats-birthday');
    return el && /December 2, 2025/.test(el.textContent);
  });
  check('inline editor sets birthday to Dec 2, 2025', true);

  // Graph: actual polyline + 3 extrapolation hover targets (trend/avg/need).
  await page.waitForSelector('#stats-margin .stats-graph svg');
  const hits = await page.locator('#stats-margin .stats-hit').evaluateAll(els => els.map(e => e.dataset.series).sort());
  check('graph has 3 extrapolation hover targets', hits.join(',') === 'avg,need,trend', hits.join(','));
  check('no legend — hover is the only hint', (await page.locator('#stats-margin .stats-legend').count()) === 0);
  // Hovering an extrapolation reveals its dotted finish-drop marker whose
  // caption ("May 27, 2027 @ 271 wpd") is the ENTIRE hint — no tooltips.
  check('no tooltip element — the drop marker is the whole hint', (await page.locator('#stats-tip').count()) === 0);
  await page.locator('#stats-margin .stats-hit[data-series="need"]').hover({ force: true });
  await page.waitForFunction(() => {
    const g = document.querySelector('.stats-finish-marker[data-for="need"]');
    return g && g.style.display !== 'none';
  });
  const caption = await page.locator('.stats-finish-marker[data-for="need"] text').evaluate(t => t.textContent);
  check('marker caption is "date @ rate wpd"', /[A-Z][a-z]+ \d+, \d{4} @ [\d,]+ wpd/.test(caption), caption);
  await page.mouse.move(10, 10);
  const markerAfter = await page.locator('.stats-finish-marker[data-for="need"]').evaluate(g => g.style.display !== 'none');
  check('marker hides on mouse-out', markerAfter === false);
  // Tap (mobile path): click reveals and keeps the marker; background tap hides.
  await page.locator('#stats-margin .stats-hit[data-series="avg"]').click({ force: true });
  const avgShown = await page.locator('.stats-finish-marker[data-for="avg"]').evaluate(g => g.style.display !== 'none');
  check('click/tap reveals the marker', avgShown === true);
  const avgText = await page.locator('#stats-margin .stats-pane').innerText();
  check('average words/day shown', /words\/day/.test(avgText));

  // Edit the goal inline to 80,000 — the number the user actually plans.
  await page.locator('#stats-goal').click();
  await page.fill('#stats-margin .stats-edit-input', '80000');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => {
    const el = document.querySelector('#stats-goal');
    return el && /80,000/.test(el.textContent);
  });
  check('inline editor sets word goal to 80,000', true);
  resp = await authed(`/manuscripts/${TEST_MANUSCRIPT_ID}/wordcount-history`);
  data = await resp.json();
  check('goal edit persisted', data.word_goal === 80000, `got ${data.word_goal}`);
  check('birthday edit persisted', data.birthday === '2025-12-02', `got ${data.birthday}`);

  // Pane choice survives reload.
  await page.reload();
  await waitForPagination(page);
  const statsShownAfterReload = await page.locator('#stats-margin').evaluate(el => getComputedStyle(el).display !== 'none');
  check('stats pane still active after reload', statsShownAfterReload);

  // Mobile: the pane takes the outline's second-bar slot (right 2/3).
  await page.setViewportSize({ width: 900, height: 900 });
  await page.waitForFunction(() => {
    const el = document.getElementById('stats-margin');
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return getComputedStyle(el).display !== 'none' && r.top < 100 && r.left > 200;
  });
  check('mobile: stats pane sits in the second bar', true);

  // Switching back restores the outline.
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.locator('#pane-tabs .pane-tab[data-pane="outline"]').click();
  await page.waitForFunction(() => {
    const el = document.getElementById('stats-margin');
    return el && getComputedStyle(el).display === 'none';
  });
  const outlineBack = await page.locator('#outline-margin').evaluate(el => !el.classList.contains('pane-off'));
  check('OUTLINE tab restores the outline', outlineBack);

  await browser.close();
  resetMeta();

  console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
  process.exit(failed ? 1 : 0);
})().catch(err => {
  console.error(err);
  try { resetMeta(); } catch (_) {}
  process.exit(1);
});
