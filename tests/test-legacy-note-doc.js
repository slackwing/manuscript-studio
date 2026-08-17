// Regression: a scratchpad doc saved by the PRE-ATOMIC build (legacy noteAnchor
// node + noteHighlight mark) must still open — modernizeDoc converts them to the
// atomic noteRef. Before the fix, such a doc threw "Unknown node type:
// noteAnchor" and the scratchpad wouldn't open at all. (This is the gap that hit
// prod: local tests only made NEW docs, never opened an existing legacy one.)
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const { TEST_URL, TEST_USERNAME, cleanupTestNotes, loginAsTestUser } = require('./test-utils');
const HOME_URL = new URL('home.html', TEST_URL).href;
function psql(sql) {
  return execSync(`PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`, { encoding: 'utf8' });
}

// A doc in the OLD format: an inline noteAnchor followed by text carrying the
// matching noteHighlight mark (both tagged noteId).
const LEGACY_DOC = JSON.stringify({
  type: 'doc',
  content: [{
    type: 'paragraph',
    content: [
      { type: 'text', text: 'Before ' },
      { type: 'noteAnchor', attrs: { color: 'green', noteId: 0 } },
      { type: 'text', text: 'the noted phrase', marks: [{ type: 'noteHighlight', attrs: { color: 'green', noteId: 0 } }] },
      { type: 'text', text: ' and after.' },
    ],
  }],
});

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  page.on('dialog', d => d.accept());
  let failed = false;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed = true; };

  await cleanupTestNotes();
  await loginAsTestUser(page);

  // Seed a note + a legacy-format doc referencing it.
  const noteId = psql(`INSERT INTO note (user_id, color, body, priority, position) VALUES ('${TEST_USERNAME}','green','the noted phrase','none','a0') RETURNING note_id`).trim().split('\n').filter(x => /^\d+$/.test(x)).pop();
  const docWithId = LEGACY_DOC.replace(/"noteId": ?0/g, `"noteId": ${noteId}`);
  const padId = psql(`INSERT INTO scratchpad (user_id, title, doc, schema_version) VALUES ('${TEST_USERNAME}','Legacy', '${docWithId.replace(/'/g, "''")}'::jsonb, 1) RETURNING scratchpad_id`).trim().split('\n').filter(x => /^\d+$/.test(x)).pop();
  psql(`UPDATE note SET scratchpad_id=${padId} WHERE note_id=${noteId}`);

  let consoleErr = '';
  page.on('console', m => { if (m.type() === 'error' && /Unknown node|noteAnchor/.test(m.text())) consoleErr += m.text(); });

  await page.goto(HOME_URL);
  await page.waitForTimeout(300);
  await page.evaluate((id) => window.WriteSysScratchpadModal.open(parseInt(id, 10)), padId);
  await page.waitForTimeout(1200);

  const body = await page.locator('.spm-editor').textContent().catch(() => '');
  check('legacy doc opens (no "Failed to open")', !/Failed to open/.test(body), body.slice(0, 80));
  check('no "Unknown node type" console error', consoleErr === '', consoleErr);
  check('legacy noteAnchor+highlight converted to one atomic noteRef',
    (await page.locator('.sn-note-ref').count()) === 1);
  const refText = await page.locator('.sn-note-ref-text').textContent().catch(() => '');
  check('converted noteRef keeps the highlighted text', /the noted phrase/.test(refText), refText);
  const refClass = await page.locator('.sn-note-ref').first().getAttribute('class').catch(() => '');
  check('converted noteRef sources color from note data (green)', /color-green/.test(refClass), refClass);

  psql(`DELETE FROM note WHERE scratchpad_id=${padId}; DELETE FROM scratchpad WHERE scratchpad_id=${padId};`);
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
