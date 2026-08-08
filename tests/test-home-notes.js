// Landing "Notes" section (NOTES_PLAN.md Phase 3): a note the user owns shows as
// a card in the Notes grid with its color + body + context.
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const { TEST_URL, cleanupTestNotes, loginAsTestUser } = require('./test-utils');
const HOME_URL = new URL('home.html', TEST_URL).href;
const OUT = '/tmp/claude-1000/-home-slackwing--config-my/8ba4eaee-57a9-43f6-8b98-5a406662b25a/scratchpad';
function psql(sql) {
  return execSync(`PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`, { encoding: 'utf8' });
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
  page.on('dialog', d => d.accept());
  let failed = false;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed = true; };

  await cleanupTestNotes();
  await loginAsTestUser(page);

  // Seed a scratchpad + a scratchpad note directly (independent of the editor).
  const padId = psql(`INSERT INTO scratchpad (user_id, title, doc, schema_version) VALUES ('test','My Pad', json_build_object('type','doc','content', json_build_array())::jsonb, 1) RETURNING scratchpad_id`).trim().split('\n').filter(x => /^\d+$/.test(x)).pop();
  psql(`INSERT INTO note (user_id, color, body, priority, task_type, position, scratchpad_id) VALUES ('test','orange','A landing-grid note.','should','write','a0',${padId})`);

  await page.goto(HOME_URL);
  await page.waitForSelector('.home-section');
  await page.waitForTimeout(400);

  // A "Notes" section exists.
  const headings = await page.locator('.home-section-head h2').allTextContents();
  check('Notes section present on the landing page', headings.some(h => /notes/i.test(h)), headings.join(','));

  // The note card mounts the SHARED note component (read-only + card variant),
  // so its body/chips come from buildNoteElement. Body + color + context here.
  const card = page.locator('.card-note').first();
  check('a note card is rendered', await page.locator('.card-note').count() >= 1);
  check('card mounts the shared note component (read-only card variant)',
    await card.locator('.sticky-note-card.sticky-note-readonly').count() === 1);
  const bodyText = await card.locator('.note-readonly-body').textContent().catch(() => '');
  check('card shows the note body', /landing-grid note/.test(bodyText), bodyText.trim());
  check('card body is NOT editable (no textarea)', await card.locator('textarea').count() === 0);
  const isOrange = await card.evaluate(el => el.classList.contains('color-orange')).catch(() => false);
  check('card wears the note color (orange)', isOrange);
  const ctx = await card.locator('.note-card-ctx').textContent().catch(() => '');
  check('card shows the scratchpad context', /My Pad/.test(ctx), ctx.trim());

  await page.screenshot({ path: `${OUT}/home-notes.png` });

  // cleanup
  psql(`DELETE FROM note WHERE scratchpad_id=${padId}; DELETE FROM scratchpad WHERE scratchpad_id=${padId};`);
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
