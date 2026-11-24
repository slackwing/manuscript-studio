// Note placements, phase 1 (NOTE_PLACEMENTS_PLAN.md): every note write the
// API performs also lands a junction row — note_sentence for a sentence note,
// note_scratchpad for a pad note — and a pad SAVE re-mirrors its doc into
// note_scratchpad (an anchor leaving the doc closes the row, coming back
// re-opens it, deleting the pad closes them all). Readers still use the
// legacy columns in this phase, so this test checks the DB, through the API.
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const { TEST_URL, API_BASE_URL, TEST_USERNAME, cleanupTestNotes, loginAsTestUser, waitForPagination } = require('./test-utils');
const psql = (sql) => execSync(
  `PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`,
  { encoding: 'utf-8' }).trim();

(async () => {
  const browser = await chromium.launch();
  let failed = false;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed = true; };
  await cleanupTestNotes();
  const page = await browser.newPage();
  await loginAsTestUser(page);
  const csrf = (await (await page.request.get(`${API_BASE_URL}/session`)).json().catch(() => ({}))).csrf_token
    || await page.evaluate(() => sessionStorage.getItem('csrf_token') || localStorage.getItem('csrf_token'));
  const H = { 'X-CSRF-Token': csrf || '' };
  const api = {
    post: (p, data) => page.request.post(`${API_BASE_URL}${p}`, { headers: H, data }),
    put: (p, data) => page.request.put(`${API_BASE_URL}${p}`, { headers: H, data }),
    del: (p) => page.request.delete(`${API_BASE_URL}${p}`, { headers: H }),
  };
  const padRow = (noteId, padId) => psql(`SELECT CASE WHEN removed_at IS NULL THEN 'live' ELSE 'closed' END FROM note_scratchpad WHERE note_id=${noteId} AND scratchpad_id=${padId}`);
  const doc = (...ids) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'anchors: ' },
    ...ids.map((id) => ({ type: 'noteRef', attrs: { noteId: id, text: `n${id}` } }))] }] });

  // ---- a sentence note gets a note_sentence row that mirrors the note ----
  await page.goto(TEST_URL);
  await waitForPagination(page);
  const sid = await page.evaluate(() => document.querySelectorAll('.pagedjs_pages .sentence[data-sentence-id]')[5].dataset.sentenceId);
  const r1 = await api.post('/notes', { sentence_id: sid, color: 'yellow', body: 'placement test (sentence)', priority: 'none' });
  check('sentence note created', r1.ok(), String(r1.status()));
  const sNote = (await r1.json()).note_id;
  const srow = psql(`SELECT ns.sentence_id = n.sentence_id AND ns.position = n.position AND ns.origin_sentence_id = n.sentence_id AND ns.sentence_id_history = '[]'::jsonb FROM note_sentence ns JOIN note n USING (note_id) WHERE ns.note_id=${sNote}`);
  check('note_sentence row mirrors sentence, position and origin', srow === 't', srow);
  check('a sentence note has no pad row', psql(`SELECT count(*) FROM note_scratchpad WHERE note_id=${sNote}`) === '0');

  // ---- a pad note gets a live note_scratchpad row ----
  const rp = await api.post('/scratchpads', { title: 'Placements pad' });
  check('pad created', rp.ok(), String(rp.status()));
  const padId = (await rp.json()).scratchpad_id;
  const r2 = await api.post('/notes', { scratchpad_id: padId, color: 'green', body: 'placement test (pad)', priority: 'none' });
  check('pad note created', r2.ok(), String(r2.status()));
  const pNote = (await r2.json()).note_id;
  check('pad note has a live note_scratchpad row', padRow(pNote, padId) === 'live', padRow(pNote, padId));

  // ---- the pad SAVE mirrors the doc ----
  let rs = await api.put(`/scratchpads/${padId}`, { title: 'Placements pad', doc: doc(pNote, sNote) });
  check('save with both anchors ok', rs.status() === 204, String(rs.status()));
  check('…pad note still live', padRow(pNote, padId) === 'live');
  check('…a sentence note pasted into the pad gets a live pad row too', padRow(sNote, padId) === 'live', padRow(sNote, padId));
  check('…and keeps its sentence row', psql(`SELECT count(*) FROM note_sentence WHERE note_id=${sNote}`) === '1');

  rs = await api.put(`/scratchpads/${padId}`, { title: 'Placements pad', doc: doc(sNote) });
  check('save without the pad note\'s anchor ok', rs.status() === 204);
  check('…closes its row (removed_at set), note itself untouched', padRow(pNote, padId) === 'closed'
    && psql(`SELECT deleted_at IS NULL FROM note WHERE note_id=${pNote}`) === 't', padRow(pNote, padId));

  rs = await api.put(`/scratchpads/${padId}`, { title: 'Placements pad', doc: doc(sNote, pNote) });
  check('anchor back (undo) re-opens the row, no duplicate', padRow(pNote, padId) === 'live'
    && psql(`SELECT count(*) FROM note_scratchpad WHERE scratchpad_id=${padId}`) === '2');

  rs = await api.put(`/scratchpads/${padId}`, { title: 'Placements pad', doc: doc(sNote, pNote, 987654321) });
  check('an anchor to a non-existent note is ignored, save still 204', rs.status() === 204
    && psql(`SELECT count(*) FROM note_scratchpad WHERE scratchpad_id=${padId}`) === '2');

  // ---- deleting the pad closes every placement (phase 1 still soft-deletes the pad's own notes) ----
  const rd = await api.del(`/scratchpads/${padId}`);
  check('pad deleted', rd.ok(), String(rd.status()));
  check('…every placement in it is closed', psql(`SELECT count(*) FROM note_scratchpad WHERE scratchpad_id=${padId} AND removed_at IS NULL`) === '0');
  check('…the pasted sentence note is NOT deleted with the pad', psql(`SELECT deleted_at IS NULL FROM note WHERE note_id=${sNote}`) === 't');

  // ---- parity: every legacy home among this user's notes has a placement row ----
  const parity = psql(`SELECT count(*) FROM note n WHERE n.user_id='${TEST_USERNAME}' AND ((n.sentence_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM note_sentence ns WHERE ns.note_id=n.note_id AND ns.sentence_id=n.sentence_id)) OR (n.scratchpad_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM note_scratchpad p WHERE p.note_id=n.note_id AND p.scratchpad_id=n.scratchpad_id)))`);
  check('parity: no legacy home without its placement row', parity === '0', parity);

  await cleanupTestNotes();
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
