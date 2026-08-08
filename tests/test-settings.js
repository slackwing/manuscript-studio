// Settings page: task-type chips (name left, color dot RIGHT), the horizontal
// dot-palette popover (NOT the sticky-note palette — that one exploded here),
// landing-page chrome (home-page body + global search + gear), no description
// copy, and the end-to-end recolor guarantee: picking a type recolors the note
// with the type's STORED color (regression: picker once stored a different
// color than the one clicked, so notes turned "random" colors).
// Categories (033): TASK vs NON-TASK sections; NO type name is special —
// notes start untyped ('n/a', NULL) and every type (reminder included) is
// deletable. Delete = chip-click arms an ×; soft-delete semantics (row
// survives, notes keep the value, dropdown stops offering it, re-adding the
// name revives it). Manual order via drag, persisted as position (also the
// dropdown order). Dropdown labels are plain words (no ●).
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const { TEST_URL, TEST_USERNAME, cleanupTestNotes, loginAsTestUser } = require('./test-utils');
const SETTINGS_URL = new URL('settings.html', TEST_URL).href;
const HOME_URL = new URL('home.html', TEST_URL).href;
function psql(sql) {
  return execSync(
    `PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8' });
}
// This test's own custom types; hard-wiped both ends (they're test-only).
const TT = 'zz-test-color';
const TDEL = 'zz-test-del';
const TKEEP = 'zz-test-keep';
const wipeTypes = () => psql(`DELETE FROM task_type WHERE name IN ('${TT}','${TDEL}','${TKEEP}')`);

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('dialog', d => d.accept());
  let failed = false;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed = true; };

  await cleanupTestNotes();
  wipeTypes();
  const originalOrder = psql(`SELECT name FROM task_type WHERE NOT deleted ORDER BY position, name`).trim().split('\n');
  await loginAsTestUser(page);
  await page.goto(SETTINGS_URL);
  await page.waitForSelector('.tt-chip');

  // --- Chrome is the landing page's chrome ---
  check('body carries home-page class', await page.evaluate(() => document.body.classList.contains('home-page')));
  check('global search present', await page.locator('#global-search #gs-input').count() === 1);
  check('gear link present', await page.locator('#settings-link').count() === 1);
  check('chrome.css loaded', await page.evaluate(() =>
    [...document.querySelectorAll('link[rel=stylesheet]')].some(l => l.href.includes('chrome.css'))));

  // --- Copy: bare section heads (non-task first), no descriptions ---
  const heads = await page.locator('.home-section-head h2').allInnerTexts();
  check('sections: non-task, task, note actions',
    heads.map(h => h.trim()).join('|') === 'Non-task types|Task types|Note actions', heads.join('|'));

  // --- Categories: reminder is non-task; tasks hold the built-ins ---
  const ttNames = await page.locator('#tt-chips .tt-chip > span:first-child').allInnerTexts();
  const ntNames = await page.locator('#nt-chips .tt-chip > span:first-child').allInnerTexts();
  check('non-task section holds reminder', ntNames.includes('reminder'), ntNames.join(','));
  check('task section does not', !ttNames.includes('reminder'), ttNames.join(','));
  check('task section has built-ins', ttNames.includes('write') && ttNames.includes('organize'));
  check('reminder is yellow', psql(`SELECT color FROM task_type WHERE name='reminder'`).trim() === 'yellow');

  // --- Chip anatomy: name first, then dot (right); EVERY chip deletable ---
  const firstChip = page.locator('#tt-chips .tt-chip').first();
  check('name precedes the dot', await firstChip.evaluate((el) =>
    [...el.children].findIndex(c => c.tagName === 'SPAN' && !c.className) <
    [...el.children].findIndex(c => c.classList.contains('color-dot-solo'))));
  const remChip = page.locator('#nt-chips .tt-chip', { hasText: 'reminder' });
  await remChip.click();
  check('even reminder arms for delete (no special names)',
    await remChip.evaluate((el) => el.classList.contains('tt-armed')) &&
    await remChip.locator('.tt-del').isVisible());
  await page.mouse.click(10, 400); // disarm without deleting

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
  await page.mouse.move(10, 400); // close the palette before working the chips

  // --- Delete: click chip → dot becomes ×; × soft-deletes ---
  await page.fill('#tt-input', TDEL);
  await page.keyboard.press('Enter');
  const delChip = page.locator('#tt-chips .tt-chip', { hasText: TDEL });
  await delChip.waitFor({ timeout: 4000 });
  await delChip.click();
  check('armed chip hides the dot', !(await delChip.locator('.color-dot-solo').isVisible()));
  check('armed chip shows the ×', await delChip.locator('.tt-del').isVisible());
  await delChip.locator('.tt-del').click();
  await page.waitForTimeout(600);
  check('deleted chip is gone from settings', await page.locator('.tt-chip', { hasText: TDEL }).count() === 0);
  const delRow = psql(`SELECT deleted || '|' || is_task FROM task_type WHERE name = '${TDEL}'`).trim();
  check('soft delete: row survives, deleted=true', delRow === 'true|true', delRow);

  // --- Revive: re-adding the name (in the OTHER category) restores it ---
  await page.fill('#nt-input', TDEL);
  await page.keyboard.press('Enter');
  await page.locator('#nt-chips .tt-chip', { hasText: TDEL }).waitFor({ timeout: 4000 });
  const revRow = psql(`SELECT deleted || '|' || is_task FROM task_type WHERE name = '${TDEL}'`).trim();
  check('re-adding revives into non-task', revRow === 'false|false', revRow);
  psql(`DELETE FROM task_type WHERE name = '${TDEL}'`);

  // --- Manual order: PUT /api/task-types/order rules the chips ---
  const csrf = await page.evaluate(() => sessionStorage.getItem('csrf_token'));
  const reordered = originalOrder.filter(n => n !== 'write');
  reordered.splice(originalOrder.indexOf('reminder') + 1, 0, 'write'); // write → first task
  const orderStatus = await page.evaluate(async ({ names, csrf }) => {
    const r = await fetch('api/task-types/order', {
      method: 'PUT', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({ names }),
    });
    return r.status;
  }, { names: reordered, csrf });
  check('reorder endpoint accepts', orderStatus === 200, `status=${orderStatus}`);
  await page.reload();
  await page.waitForSelector('.tt-chip');
  const ttAfter = await page.locator('#tt-chips .tt-chip > span:first-child').allInnerTexts();
  check('manual order rules the chips (write now first task)', ttAfter[0] === 'write', ttAfter.join(','));

  // --- Recolor e2e: add a TASK type, pick blue, store must be blue ---
  await page.fill('#tt-input', TT);
  await page.keyboard.press('Enter');
  const chip = page.locator('#tt-chips .tt-chip', { hasText: TT });
  await chip.waitFor({ timeout: 4000 });
  await chip.locator('.color-dot-solo').hover();
  await chip.locator('.dot-palette.visible').waitFor({ timeout: 3000 });
  await chip.locator('.dot-option[data-color="blue"]').click();
  await page.waitForTimeout(600);
  const stored = psql(`SELECT color FROM task_type WHERE name = '${TT}'`).trim();
  check('clicking blue stores blue', stored === 'blue', `stored=${stored}`);
  const painted = await chip.locator('.color-dot-current').evaluate((el) => el.style.background);
  check('dot painted with the picked color', painted.includes('--highlight-blue'), painted);

  // A soft-deleted TASK type a note will hold on to (semantics check below).
  psql(`INSERT INTO task_type (name, built_in, is_task) VALUES ('${TKEEP}', false, true)`);

  // --- Pad: new note is UNTYPED ('n/a'): no priority/star; dropdown plain ---
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
  check('new note is n/a', (await float.locator('.dim-type .dim-label').innerText()).trim() === 'n/a');
  check('untyped note stores NULL', psql(`SELECT COALESCE(task_type,'<null>') FROM note WHERE note_id = ${noteId}`).trim() === '<null>');
  check('untyped: no priority chip', await float.locator('.dim-priority').count() === 0);
  check('untyped: no star', !(await float.locator('.points-star').isVisible()));
  await float.locator('.dim-type').click();
  const popup = page.locator('.note-linkpop');
  await popup.waitFor({ timeout: 4000 });
  const labels = await popup.locator('button[data-v]').allInnerTexts();
  check('dropdown labels are plain words (no ●)', labels.every(l => !l.includes('●')), labels.join(','));
  check('dropdown leads with n/a', labels[0] && labels[0].trim() === 'n/a');
  check('dropdown offers non-task types too', labels.some(l => l.trim() === 'reminder'));
  const trimmed = labels.map(l => l.trim());
  check('non-tasks come before tasks in the dropdown',
    trimmed.indexOf('reminder') < trimmed.indexOf('write'), trimmed.join(','));
  await popup.locator(`button[data-v="${TT}"]`).click();
  await page.waitForTimeout(800);
  const noteColor = psql(`SELECT color FROM note WHERE note_id = ${noteId}`).trim();
  check('note recolored to the type’s stored color (blue)', noteColor === 'blue', `color=${noteColor}`);
  const hasBlueClass = await float.evaluate((el) => el.classList.contains('color-blue'));
  check('float shows blue', hasBlueClass);

  // --- Picking n/a again untypes the note (back to NULL, chips retract) ---
  await float.locator('.dim-type').click();
  await popup.waitFor({ timeout: 4000 });
  await popup.locator('button[data-v=""]').click();
  await page.waitForTimeout(800);
  check('picking n/a clears the type (NULL)', psql(`SELECT COALESCE(task_type,'<null>') FROM note WHERE note_id = ${noteId}`).trim() === '<null>');
  check('n/a retracts priority chip', await float.locator('.dim-priority').count() === 0);

  // --- Soft-delete semantics on a note: value kept, never offered again ---
  await float.locator('.dim-type').click();
  await popup.waitFor({ timeout: 4000 });
  await popup.locator(`button[data-v="${TKEEP}"]`).click();
  await page.waitForTimeout(800);
  psql(`UPDATE task_type SET deleted = true WHERE name = '${TKEEP}'`);
  await page.reload();
  // The modal deep-links — reload usually reopens the same pad by itself;
  // fall back to the landing grid card when it doesn't.
  try {
    await page.waitForSelector('.spm-overlay .ProseMirror', { timeout: 4000 });
  } catch (e) {
    await page.waitForSelector('#home-new-pad');
    await page.locator('.card-scratchpad').first().click();
    await page.waitForSelector('.spm-overlay .ProseMirror');
  }
  await page.locator('.sn-note-ref').first().click();
  const float2 = page.locator('.sn-note-float .sticky-note');
  await float2.waitFor({ timeout: 5000 });
  const typeLabel = (await float2.locator('.dim-type .dim-label').innerText()).trim();
  check('note KEEPS its soft-deleted type', typeLabel === TKEEP, typeLabel);
  check('deleted type still counts as a task (star visible)', await float2.locator('.points-star').isVisible());
  await float2.locator('.dim-type').click();
  const popup2 = page.locator('.note-linkpop');
  await popup2.waitFor({ timeout: 4000 });
  check('dropdown no longer offers the deleted type', await popup2.locator(`button[data-v="${TKEEP}"]`).count() === 0);
  await popup2.locator('button[data-v="write"]').click();
  await page.waitForTimeout(800);
  const changed = psql(`SELECT task_type FROM note WHERE note_id = ${noteId}`).trim();
  check('changing away from a deleted type sticks', changed === 'write', changed);

  // --- Note actions: award / complete / delete → audit rows with undo ---
  const csrf2 = await page.evaluate(() => sessionStorage.getItem('csrf_token'));
  const api = (method, path, body) => page.evaluate(async ({ method, path, body, csrf }) => {
    const r = await fetch(path, { method, credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: body ? JSON.stringify(body) : undefined });
    return r.status;
  }, { method, path, body, csrf: csrf2 });
  check('award 7 points', (await api('POST', `api/notes/${noteId}/points`, { points: 7 })) < 300);
  check('complete note', (await api('POST', `api/notes/${noteId}/complete`)) < 300);
  // A completed note leaves the UI (and the delete path), so the deleted
  // action gets its own note.
  const padId = psql(`SELECT scratchpad_id FROM scratchpad WHERE user_id='${TEST_USERNAME}' ORDER BY scratchpad_id DESC LIMIT 1`).trim();
  const delNoteId = await page.evaluate(async ({ padId, csrf }) => {
    const r = await fetch('api/notes', { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({ scratchpad_id: parseInt(padId, 10), color: 'yellow', body: 'Delete me please.' }) });
    return (await r.json()).note_id;
  }, { padId, csrf: csrf2 });
  check('delete note', (await api('DELETE', `api/notes/${delNoteId}`)) < 300);
  await page.goto(SETTINGS_URL);
  await page.waitForSelector('.na-row', { timeout: 5000 });
  const kinds = await page.locator('.na-row').evaluateAll(rows => rows.map(r => r.className));
  check('three action rows, newest first (deleted, completed, points)',
    kinds.length >= 3 && kinds[0].includes('na-deleted') && kinds[1].includes('na-completed') && kinds[2].includes('na-points'),
    kinds.join(';'));
  check('rows carry the note-UI icons', await page.locator('.na-row .na-icon svg').count() >= 3);
  check('rows wear the note color', kinds[0].includes('na-color-yellow') && kinds[2].includes('na-color-blue'), kinds.join(';'));
  check('preview shows the note body', (await page.locator('.na-row.na-points .na-prev').innerText()).includes('Recolor me'));
  check('deleted row previews its own note', (await page.locator('.na-row.na-deleted .na-prev').innerText()).includes('Delete me'));
  check('when column shows date + time', /[A-Za-z]+ \d+.*\d+:\d\d/.test(await page.locator('.na-row .na-when').first().innerText()),
    await page.locator('.na-row .na-when').first().innerText());
  await page.locator('.na-row.na-deleted .na-undo').first().click();
  await page.waitForTimeout(700);
  check('undo delete restores the note', psql(`SELECT deleted_at IS NULL FROM note WHERE note_id=${delNoteId}`).trim() === 't');
  await page.locator('.na-row.na-completed .na-undo').first().click();
  await page.waitForTimeout(700);
  check('undo complete restores the note', psql(`SELECT completed_at IS NULL FROM note WHERE note_id=${noteId}`).trim() === 't');
  const unawardLabel = (await page.locator('.na-row.na-points .na-undo').first().innerText()).trim();
  check('unaward button names the points', unawardLabel === 'unaward 7 points', unawardLabel);
  await page.locator('.na-row.na-points .na-undo').first().click();
  await page.waitForTimeout(700);
  check('unaward hard-deletes the event', psql(`SELECT count(*) FROM point_event WHERE note_id=${noteId}`).trim() === '0');
  check('all three rows undone (table empty)', await page.locator('.na-row').count() === 0);

  // Back into the pad for the sketch checks below.
  await page.goto(HOME_URL);
  try {
    await page.waitForSelector('.spm-overlay .ProseMirror', { timeout: 4000 });
  } catch (e) {
    await page.waitForSelector('#home-new-pad');
    await page.locator('.card-scratchpad').first().click();
    await page.waitForSelector('.spm-overlay .ProseMirror');
  }

  // --- Sketch notes: untyped too (no default anywhere) ---
  await page.evaluate(() => window.WriteSysScratchpad.insertSketch());
  await page.waitForSelector('.sn-widget .sn-note-solo', { timeout: 10000 });
  await page.waitForTimeout(600);
  const sketchType = psql(`SELECT COALESCE(task_type,'<null>') FROM note WHERE user_id = '${TEST_USERNAME}' AND sketch_id IS NOT NULL ORDER BY note_id DESC LIMIT 1`).trim();
  check('sketch note starts untyped (NULL)', sketchType === '<null>', sketchType);
  await page.locator('.sn-widget .sn-note-solo').first().dispatchEvent('mousedown');
  const sfloat = page.locator('.sn-note-float .sticky-note');
  await sfloat.waitFor({ timeout: 10000 });
  check('sketch float shows n/a', (await sfloat.locator('.dim-type .dim-label').innerText()).trim() === 'n/a');
  check('sketch note is NOT a task (no star)', !(await sfloat.locator('.points-star').isVisible()));
  check('sketch note has no priority chip', await sfloat.locator('.dim-priority').count() === 0);

  // Restore the pre-test manual order.
  await page.goto(SETTINGS_URL);
  await page.waitForSelector('.tt-chip');
  await page.evaluate(async ({ names, csrf }) => {
    await fetch('api/task-types/order', {
      method: 'PUT', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({ names }),
    });
  }, { names: originalOrder, csrf: await page.evaluate(() => sessionStorage.getItem('csrf_token')) });

  wipeTypes();
  await cleanupTestNotes();
  await browser.close();
  process.exit(failed ? 1 : 0);
})();
