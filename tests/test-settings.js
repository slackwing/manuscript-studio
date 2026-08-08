// Settings page: task-type chips (name left, color dot RIGHT), the horizontal
// dot-palette popover (NOT the sticky-note palette — that one exploded here),
// landing-page chrome (home-page body + global search + gear), no description
// copy, and the end-to-end recolor guarantee: picking a type recolors the note
// with the type's STORED color (regression: picker once stored a different
// color than the one clicked, so notes turned "random" colors).
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const { TEST_URL, cleanupTestNotes, loginAsTestUser } = require('./test-utils');
const SETTINGS_URL = new URL('settings.html', TEST_URL).href;
const HOME_URL = new URL('home.html', TEST_URL).href;
function psql(sql) {
  return execSync(
    `PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8' });
}
const TT = 'zz-test-color'; // this test's own custom type; cleaned up both ends

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('dialog', d => d.accept());
  let failed = false;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed = true; };

  await cleanupTestNotes();
  psql(`DELETE FROM task_type WHERE name = '${TT}'`);
  await loginAsTestUser(page);
  await page.goto(SETTINGS_URL);
  await page.waitForSelector('.tt-chip');

  // --- Chrome is the landing page's chrome ---
  check('body carries home-page class', await page.evaluate(() => document.body.classList.contains('home-page')));
  check('global search present', await page.locator('#global-search #gs-input').count() === 1);
  check('gear link present', await page.locator('#settings-link').count() === 1);
  check('chrome.css loaded', await page.evaluate(() =>
    [...document.querySelectorAll('link[rel=stylesheet]')].some(l => l.href.includes('chrome.css'))));

  // --- Copy: just "Task types", no description paragraph ---
  const h2 = await page.locator('.home-section-head h2').first().innerText();
  check('heading is exactly "Task types"', h2.trim() === 'Task types', `h2=${JSON.stringify(h2)}`);
  const hintText = (await page.locator('#tt-status').innerText()).trim();
  check('no description copy (status line empty)', hintText === '', `status=${JSON.stringify(hintText)}`);
  check('no other hint paragraphs', await page.locator('.settings-hint').count() === 1);

  // --- Chip anatomy: name first, color dot LAST (right side) ---
  const firstChip = page.locator('.tt-chip').first();
  const order = await firstChip.evaluate((el) => [...el.children].map(c => c.className || c.tagName).join('|'));
  check('dot is the chip’s last element', /color-dot-solo$/.test(order), order);

  // --- Palette: horizontal pill, 7 distinct options, on-screen ---
  await firstChip.locator('.color-dot-solo').hover();
  const pal = firstChip.locator('.dot-palette.visible');
  await pal.waitFor({ timeout: 3000 });
  check('palette has 7 color options', await pal.locator('.dot-option').count() === 7);
  const box = await pal.boundingBox();
  check('palette is horizontal', box && box.width > box.height, box && `${Math.round(box.width)}x${Math.round(box.height)}`);
  check('palette is compact (not sticky-note sized)', box && box.height < 45, box && `h=${Math.round(box.height)}`);
  const vp = page.viewportSize();
  check('palette fully on screen', box && box.y >= 0 && box.x + box.width <= vp.width && box.y + box.height <= vp.height);
  check('no sticky-note palette on this page', await page.locator('.sticky-note-palette').count() === 0);

  // --- Add a custom type, pick blue, and the STORE must be blue ---
  await page.fill('#tt-input', TT);
  await page.keyboard.press('Enter');
  const chip = page.locator('.tt-chip', { hasText: TT });
  await chip.waitFor({ timeout: 4000 });
  await chip.locator('.color-dot-solo').hover();
  await chip.locator('.dot-palette.visible').waitFor({ timeout: 3000 });
  await chip.locator('.dot-option[data-color="blue"]').click();
  await page.waitForTimeout(600);
  const stored = psql(`SELECT color FROM task_type WHERE name = '${TT}'`).trim();
  check('clicking blue stores blue', stored === 'blue', `stored=${stored}`);
  const painted = await chip.locator('.color-dot-current').evaluate((el) => el.style.background);
  check('dot painted with the picked color', painted.includes('--highlight-blue'), painted);

  // --- End to end: picking that type recolors the note BLUE, not anything else ---
  await page.goto(HOME_URL);
  await page.waitForSelector('#home-new-pad'); await page.click('#home-new-pad');
  await page.waitForSelector('.spm-overlay .ProseMirror');
  const pm = page.locator('.spm-editor .ProseMirror');
  await pm.click();
  await page.keyboard.type('Recolor me via task type.');
  await page.keyboard.press('Home');
  await page.keyboard.down('Shift'); await page.keyboard.press('End'); await page.keyboard.up('Shift');
  await page.waitForTimeout(150);
  await page.locator('.sn-note-colorbar .sn-note-colorbtn').first().click(); // yellow
  await page.waitForTimeout(600);
  const noteId = await page.locator('.sn-note-ref').first().getAttribute('data-note-id');
  const float = page.locator('.sn-note-float .sticky-note');
  await float.locator('.dim-type').click();
  const popup = page.locator('.note-linkpop');
  await popup.waitFor({ timeout: 4000 });
  await popup.locator(`button[data-v="${TT}"]`).click();
  await page.waitForTimeout(800);
  const noteColor = psql(`SELECT color FROM note WHERE note_id = ${noteId}`).trim();
  check('note recolored to the type’s stored color (blue)', noteColor === 'blue', `color=${noteColor}`);
  const hasBlueClass = await float.evaluate((el) => el.classList.contains('color-blue'));
  check('float shows blue', hasBlueClass);

  psql(`UPDATE note SET task_type = 'reminder' WHERE task_type = '${TT}'`);
  psql(`DELETE FROM task_type WHERE name = '${TT}'`);
  await cleanupTestNotes();
  await browser.close();
  process.exit(failed ? 1 : 0);
})();
