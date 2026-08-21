// In-pad notes e2e (CODE_REVIEW_AUG_2026 Area 1, "Notes (in-pad)" — all 8 rows;
// multi-ref-removal is listed U/E and exercised here as E):
//   note-create-empty-selection, note-complete-removes-ref-keeps-note,
//   sketch-note-complete-square, note-float-singleton-and-race,
//   note-float-outside-close-exceptions, recolor-no-doc-edit,
//   multi-ref-removal, teardown-preserves-notes.
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const { TEST_URL, cleanupTestNotes, loginAsTestUser } = require('./test-utils');
const HOME_URL = new URL('home.html', TEST_URL).href;
function psql(sql) {
  return execSync(
    `PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8' }).trim();
}

(async () => {
  console.log('=== in-pad notes e2e ===\n');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  page.on('dialog', d => d.accept());
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  let failed = 0;
  const check = (n, ok, extra) => {
    console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`);
    if (!ok) failed++;
  };
  // Select `needle` inside the PM doc via a real transaction (updateToolbar runs).
  const selectText = (needle) => page.evaluate((needle) => {
    const ed = window.WriteSysScratchpad; const v = ed.view;
    let from = -1;
    v.state.doc.descendants((node, pos) => {
      if (from >= 0) return false;
      if (node.isText && node.text.includes(needle)) { from = pos + node.text.indexOf(needle); return false; }
    });
    if (from < 0) return false;
    v.dispatch(v.state.tr.setSelection(ed.pm.TextSelection.create(v.state.doc, from, from + needle.length)));
    return true;
  }, needle);
  const docJSON = () => page.evaluate(() => JSON.stringify(window.WriteSysScratchpad.view.state.doc.toJSON()));
  const docText = () => page.evaluate(() => window.WriteSysScratchpad.view.state.doc.textContent);
  // Set a note's task type through the float's own type chip (dim-pop picker).
  const setTypeViaFloat = async (typeName) => {
    await page.locator('.sn-note-float .dim-type').click();
    await page.waitForSelector('.note-linkpop.dim-pop button[data-v]');
    await page.locator(`.note-linkpop.dim-pop button[data-v="${typeName}"]`).click();
    await page.waitForSelector('.sn-note-float .complete-check:not([style*="none"])');
  };
  const completeViaFloat = async () => {
    await page.locator('.sn-note-float .complete-check').click();
    await page.waitForSelector('.sn-note-float .complete-check.confirming');
    await page.locator('.sn-note-float .complete-check').click();
  };

  await cleanupTestNotes();
  await loginAsTestUser(page);
  await page.goto(HOME_URL);
  await page.waitForSelector('.card-ghost[data-ghost="scratchpad"]');
  await page.click('.card-ghost[data-ghost="scratchpad"]');
  await page.waitForSelector('.spm-overlay .ProseMirror');
  const padId = await page.evaluate(() => window.WriteSysScratchpad.scratchpadId);

  try {
    await page.locator('.spm-editor .ProseMirror').click();
    await page.keyboard.type('First noted phrase here. Second noted phrase there. Tail words.');
    await page.waitForFunction(() => document.querySelector('#spm-status').textContent === 'Unsaved' || document.querySelector('#spm-status').textContent === 'Saved');

    // ---- note-create-empty-selection --------------------------------------
    {
      let notePosts = 0;
      await page.route('**/api/notes', (route) => {
        if (route.request().method() === 'POST') notePosts++;
        return route.continue();
      });
      await page.keyboard.press('End'); // caret only, no selection
      await page.waitForFunction(() =>
        document.querySelector('.sn-note-colorbar').classList.contains('sn-note-colorbar-disabled'));
      check('empty selection disables the color bar', true);
      await page.locator('.sn-note-colorbar .sn-note-colorbtn.color-yellow').click();
      await page.waitForTimeout(300);
      check('clicking a square with no selection creates nothing',
        notePosts === 0 && (await page.locator('.sn-note-ref').count()) === 0, `posts=${notePosts}`);
      await page.unroute('**/api/notes');
    }

    // ---- create note1 + recolor-no-doc-edit -------------------------------
    check('selection found (note1 target)', await selectText('First noted phrase'));
    await page.waitForFunction(() =>
      !document.querySelector('.sn-note-colorbar').classList.contains('sn-note-colorbar-disabled'));
    check('non-empty selection enables the color bar', true);
    await page.locator('.sn-note-colorbar .sn-note-colorbtn.color-yellow').click();
    await page.waitForSelector('.sn-note-float .sticky-note');
    const note1 = parseInt(await page.locator('.sn-note-ref').first().getAttribute('data-note-id'), 10);
    check('note1 created (ref + float)', note1 > 0, `note_id=${note1}`);

    const jsonBefore = await docJSON();
    await page.evaluate(() => {
      document.querySelector('.sn-note-float .sticky-note-palette .color-circle[data-color="blue"]').click();
    });
    await page.waitForFunction((id) => {
      const ref = document.querySelector(`.sn-note-ref[data-note-id="${id}"]`);
      return ref && /color-blue/.test(ref.className);
    }, note1);
    check('recolor re-renders every ref view (blue)', true);
    check('recolor makes NO doc edit (doc JSON byte-identical)', (await docJSON()) === jsonBefore);
    let dbColor = '';
    for (let i = 0; i < 20; i++) {
      dbColor = psql(`SELECT color FROM note WHERE note_id=${note1}`);
      if (dbColor === 'blue') break;
      await new Promise(r => setTimeout(r, 150));
    }
    check('recolor persisted on the note row', dbColor === 'blue', dbColor);
    check('doc JSON never mentions a color', !/color/.test(jsonBefore));
    await page.locator('#spm-title').click(); // close the float
    await page.waitForFunction(() => !document.querySelector('.sn-note-float'));

    // ---- create note2 + float-outside-close-exceptions --------------------
    check('selection found (note2 target)', await selectText('Second noted phrase'));
    await page.locator('.sn-note-colorbar .sn-note-colorbtn.color-green').click();
    await page.waitForSelector('.sn-note-float .sticky-note');
    const note2 = await page.evaluate(() =>
      parseInt([...document.querySelectorAll('.sn-note-ref')].map(r => r.dataset.noteId).sort((a, b) => b - a)[0], 10));
    check('note2 created', note2 > note1, `note_id=${note2}`);
    // Open the float's manuscript picker (a body-level .note-linkpop popover).
    await page.locator('.sn-note-float .note-ms-slot > *').first().click();
    await page.waitForSelector('.note-linkpop');
    await page.locator('.note-linkpop').first().dispatchEvent('mousedown', { bubbles: true });
    await page.waitForTimeout(250);
    check('mousedown inside .note-linkpop keeps the float open',
      (await page.locator('.sn-note-float').count()) === 1);
    await page.locator('#spm-title').dispatchEvent('mousedown', { bubbles: true });
    await page.waitForFunction(() => !document.querySelector('.sn-note-float'));
    check('mousedown elsewhere closes the float', true);

    // ---- note-float-singleton-and-race ------------------------------------
    await page.evaluate(({ a, b }) => {
      const refA = document.querySelector(`.sn-note-ref[data-note-id="${a}"]`);
      const refB = document.querySelector(`.sn-note-ref[data-note-id="${b}"]`);
      // Two opens in the SAME tick — the async float opens race; the
      // supersede guard must leave exactly one float.
      refA.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      refB.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    }, { a: note1, b: note2 });
    await page.waitForSelector('.sn-note-float');
    let maxFloats = 0;
    for (let i = 0; i < 8; i++) {
      maxFloats = Math.max(maxFloats, await page.locator('.sn-note-float').count());
      await page.waitForTimeout(100);
    }
    check('rapid double open leaves exactly ONE float (supersede guard)', maxFloats === 1, `max=${maxFloats}`);
    await page.locator('#spm-title').dispatchEvent('mousedown', { bubbles: true });
    await page.waitForFunction(() => !document.querySelector('.sn-note-float'));

    // ---- teardown-preserves-notes -----------------------------------------
    {
      let noteDeletes = 0;
      await page.route('**/api/notes/**', (route) => {
        if (route.request().method() === 'DELETE') noteDeletes++;
        return route.continue();
      });
      await page.waitForFunction(() => document.querySelector('#spm-status').textContent === 'Saved');
      await page.click('#spm-close');
      await page.waitForSelector('.spm-overlay', { state: 'detached' });
      await page.waitForTimeout(500); // the destroy() re-scan window
      check('closing a pad with notes fires ZERO note DELETEs', noteDeletes === 0, `deletes=${noteDeletes}`);
      check('both notes alive after close',
        psql(`SELECT count(*) FROM note WHERE note_id IN (${note1},${note2}) AND deleted_at IS NULL`) === '2');
      await page.unroute('**/api/notes/**');
      await page.evaluate((id) => window.WriteSysScratchpadModal.open(id), padId);
      await page.waitForSelector('.spm-overlay .ProseMirror');
      await page.waitForSelector('.sn-note-ref');
    }

    // ---- multi-ref-removal (two refs of note1, right-to-left restore) -----
    {
      await page.evaluate((id) => {
        const ed = window.WriteSysScratchpad; const v = ed.view;
        // A SECOND ref of note1 at the very start of the doc.
        const ref = ed.schema.nodes.noteRef.create({ noteId: id, text: 'echo of the first' });
        v.dispatch(v.state.tr.insert(1, ref));
      }, note1);
      await page.waitForFunction((id) =>
        document.querySelectorAll(`.sn-note-ref[data-note-id="${id}"]`).length === 2, note1);
      check('second ref of note1 inserted', true);
      // Two-click confirm on one ref's trash → deleteNoteViaDoc removes BOTH.
      await page.evaluate((id) => {
        const trash = document.querySelector(`.sn-note-ref[data-note-id="${id}"] .sn-note-ref-trash`);
        trash.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        trash.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      }, note1);
      await page.waitForFunction((id) =>
        document.querySelectorAll(`.sn-note-ref[data-note-id="${id}"]`).length === 0, note1);
      check('both refs of the note removed together', true);
      const text = await docText();
      check('each ref restored ITS OWN text in place (right-to-left, no corruption)',
        /echo of the first/.test(text) && /First noted phrase/.test(text)
        && text.indexOf('echo of the first') < text.indexOf('First noted phrase'), text.slice(0, 90));
      let deleted = '';
      for (let i = 0; i < 20; i++) {
        deleted = psql(`SELECT deleted_at IS NOT NULL FROM note WHERE note_id=${note1}`);
        if (deleted === 't') break;
        await new Promise(r => setTimeout(r, 150));
      }
      check('trash-delete soft-deletes the note', deleted === 't');
      check('note2 untouched by note1\'s removal',
        psql(`SELECT deleted_at IS NULL FROM note WHERE note_id=${note2}`) === 't');
    }

    // ---- note-complete-removes-ref-keeps-note (note2) ---------------------
    {
      const jsonPre = await docJSON();
      await page.evaluate((id) => {
        document.querySelector(`.sn-note-ref[data-note-id="${id}"]`)
          .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      }, note2);
      await page.waitForSelector('.sn-note-float .sticky-note');
      await setTypeViaFloat('write'); // completion is task-gated
      await completeViaFloat();
      await page.waitForFunction((id) =>
        document.querySelectorAll(`.sn-note-ref[data-note-id="${id}"]`).length === 0, note2);
      check('complete removes the ref from the doc', true);
      check('…restoring the highlighted text as plain prose', /Second noted phrase/.test(await docText()));
      check('complete closes the float', (await page.locator('.sn-note-float').count()) === 0);
      await page.waitForTimeout(500); // destroy()'s re-scan window
      const row = psql(`SELECT (completed_at IS NOT NULL) || '|' || (deleted_at IS NULL) FROM note WHERE note_id=${note2}`);
      check('note completed WITHOUT being soft-deleted', row === 'true|true', row);
    }

    // ---- sketch-note-complete-square --------------------------------------
    {
      const ctx = await page.evaluate(() => window.WriteSysScratchpad.insertSketch());
      const sketchNoteId = await page.evaluate(async () => {
        // The widget's corner square carries the sketch note's id.
        for (let i = 0; i < 50; i++) {
          const sq = document.querySelector('.sn-widget .sn-note-solo');
          if (sq) return parseInt(sq.dataset.noteId, 10);
          await new Promise(r => setTimeout(r, 100));
        }
        return 0;
      });
      check('sketch widget wears its note square', sketchNoteId > 0, `note_id=${sketchNoteId}`);
      await page.locator('.sn-widget .sn-note-solo').dispatchEvent('mousedown', { bubbles: true });
      await page.waitForSelector('.sn-note-float .sticky-note');
      check('sketch note float has NO delete affordance',
        (await page.locator('.sn-note-float .note-trash').count()) === 0);
      await setTypeViaFloat('write');
      const jsonPre = await docJSON();
      await completeViaFloat();
      await page.waitForSelector(`.sn-note-solo[data-note-id="${sketchNoteId}"].sn-note-done`);
      check('completing flips the square to the green check', true);
      check('sketch-note completion makes NO doc edit', (await docJSON()) === jsonPre);
      check('sketch note completed in the DB (and never deleted)',
        psql(`SELECT (completed_at IS NOT NULL) || '|' || (deleted_at IS NULL) FROM note WHERE note_id=${sketchNoteId}`) === 'true|true');
    }

    check('no page errors', errs.length === 0, errs.slice(0, 3).join('; '));
  } finally {
    await cleanupTestNotes();
    await browser.close();
  }

  console.log(failed === 0 ? '\n✅ Test passed' : `\n❌ ${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('Test crashed:', e); process.exit(1); });
