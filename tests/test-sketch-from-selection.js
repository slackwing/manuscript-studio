// Sketch from selection (placement rethink phase 3): shift-select a range →
// the gutter sketch icon → dialog (label + pad choice) → group with
// A = frozen original + B = editable copy, placed from birth (canon
// snapshot = A, last-placed = A, wordcount via manuscript only), the
// selection wrapped in &sketch#id{label} … &end#id as suggestions, and the
// widgets appended to the chosen pad. The placed region's margin glyph is
// the sketch icon; clicking it deep-links to the widget.
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const { TEST_URL, TEST_USERNAME, TEST_PASSWORD } = require('./test-utils');
const BASE = 'http://localhost:5001';
const psql = (sql) => execSync(
  `PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`,
  { encoding: 'utf-8' }).trim();

(async () => {
  psql(`DELETE FROM suggested_change WHERE user_id='${TEST_USERNAME}'`);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('dialog', async d => { try { await d.accept(); } catch (e) {} });
  let failed = false;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed = true; };

  await page.goto(`${BASE}/login.html`);
  await page.evaluate(async ([u, p]) => {
    const r = await fetch('api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'include', body: JSON.stringify({ username: u, password: p }) });
    const d = await r.json();
    localStorage.setItem('csrf_token', d.csrf_token);
  }, [TEST_USERNAME, TEST_PASSWORD]);
  await page.goto(TEST_URL);
  await page.waitForSelector('.sentence[data-sentence-id]', { timeout: 60000 });
  await page.waitForTimeout(4000);

  const pair = await page.evaluate(() => {
    const spans = [...document.querySelectorAll('.sentence[data-sentence-id]')]
      .filter(s => s.textContent.trim().length > 30 && !s.closest('h1,h2,h3'));
    const a = spans[2], b = spans[4];
    return { aId: a.dataset.sentenceId, bId: b.dataset.sentenceId, aText: a.textContent.trim().slice(0, 20) };
  });
  await page.evaluate((id) => { window.__ssFirst = id; }, pair.aId);
  await page.locator(`.sentence[data-sentence-id="${pair.aId}"]`).first().click();
  await page.waitForTimeout(300);
  await page.locator(`.sentence[data-sentence-id="${pair.bId}"]`).first().click({ modifiers: ['Shift'] });
  await page.waitForSelector('.range-trash.range-sketch', { timeout: 5000 });
  check('sketch button rides the gutter beside the trash', true);

  await page.locator('.range-trash.range-sketch').click();
  await page.waitForSelector('#sketch-sel-modal', { timeout: 5000 });
  const label = await page.inputValue('#ssm-label');
  check('label prefilled from the selection', label.length > 0, label);
  await page.fill('#ssm-label', 'Reworked passage');
  await page.locator('#ssm-go').click();
  await page.waitForSelector('#sketch-sel-modal', { state: 'detached', timeout: 20000 });

  // --- Group facts ---
  const slug = psql(`SELECT s.sketch_id FROM sketch s JOIN variation v ON v.sketch_id = s.sketch_id
    WHERE s.user_id='${TEST_USERNAME}' AND v.ordinal = 1 ORDER BY v.created_at DESC LIMIT 1`);
  check('group minted', /^[a-z0-9]{6,}$/.test(slug), slug);
  const rows = psql(`SELECT COALESCE(ordinal::text,'-') || '/' || state FROM variation WHERE sketch_id='${slug}' ORDER BY COALESCE(ordinal, 99)`).split('\n');
  check('A frozen, B draft, snapshot frozen', rows.join(',') === '1/frozen,2/draft,-/frozen', rows.join(','));
  const facts = psql(`SELECT (canon_variation_id IS NOT NULL) || '/' ||
    (placed_from_variation_id = (SELECT variation_id FROM variation WHERE sketch_id='${slug}' AND ordinal=1)) || '/' ||
    (linked_manuscript_id IS NOT NULL) FROM sketch WHERE sketch_id='${slug}'`);
  check('placed from birth, last-placed = A, linked', facts === 'true/true/true', facts);
  const aMatch = psql(`SELECT position('${pair.aText.replace(/'/g, "''")}' in text) > 0 FROM variation WHERE sketch_id='${slug}' AND ordinal=1`);
  check('A carries the selected text', aMatch === 't', aMatch);
  const pad = psql(`SELECT scratchpad_id FROM variation WHERE sketch_id='${slug}' AND ordinal=1`);
  const nodes = psql(`SELECT (LENGTH(doc::text) - LENGTH(REPLACE(doc::text, '"snippet"', ''))) / LENGTH('"snippet"') FROM scratchpad WHERE scratchpad_id=${pad}`);
  check('both widgets appended to the pad doc', nodes === '2', nodes);
  const sugAnchors = psql(`SELECT count(*) FROM suggested_change WHERE user_id='${TEST_USERNAME}' AND (text LIKE '%&sketch#${slug}%' OR text LIKE '%&end#${slug}%')`);
  check('selection wrapped in &sketch anchors (2 suggestions)', sugAnchors === '2', sugAnchors);

  // --- Book: margin glyph is the sketch icon; click navigates ---
  await page.waitForSelector(`.cmd-sketch-glyph[data-slug="${slug}"]`, { timeout: 20000 });
  check('placed region wears the sketch glyph in the margin', true);
  check('glyph is an svg (not the ⚓)', await page.locator(`.cmd-sketch-glyph[data-slug="${slug}"] svg`).count() === 1);
  await page.locator(`.cmd-sketch-glyph[data-slug="${slug}"]`).first().click();
  await page.waitForSelector('.spm-overlay .ProseMirror', { timeout: 15000 });
  check('glyph click opens the home pad', true);
  await page.waitForSelector(`.sn-widget[data-ordinal="1"]`, { timeout: 10000 });
  check('the A widget is there', true);
  const hash = await page.evaluate(() => window.location.hash);
  check('deep-link hash carries the sketch', hash.includes(`sketch=${slug}`), hash);

  // Cleanup: suggestions + pad (cascades widgets), group rows.
  psql(`DELETE FROM suggested_change WHERE user_id='${TEST_USERNAME}'`);
  psql(`DELETE FROM note WHERE sketch_id='${slug}'`);
  psql(`UPDATE sketch SET canon_variation_id=NULL, placed_from_variation_id=NULL WHERE sketch_id='${slug}'`);
  psql(`DELETE FROM variation WHERE sketch_id='${slug}'`);
  psql(`DELETE FROM sketch WHERE sketch_id='${slug}'`);
  psql(`DELETE FROM scratchpad WHERE scratchpad_id=${pad}`);
  await browser.close();
  console.log(failed ? '\n❌ failed' : '\n✅ Test passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('Test crashed:', e); process.exit(1); });
