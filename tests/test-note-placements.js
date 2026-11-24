// Note placements (NOTE_PLACEMENTS_PLAN.md), through the API:
//   phase 1 — every note write lands a junction row (note_sentence for a
//             sentence note, note_scratchpad for a pad note) and a pad SAVE
//             re-mirrors its doc into note_scratchpad;
//   phase 2 — the readers use the junction: a note can sit on several
//             sentences (one margin row per placement), be attached /
//             detached, exist with no placement at all (a FREE note), a pad
//             delete leaves notes alive, and an anchor leaving a pad closes
//             the placement instead of deleting the note.
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
    get: (p) => page.request.get(`${API_BASE_URL}${p}`),
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
  const [sidA, sidB] = await page.evaluate(() => {
    const ids = [...new Set([...document.querySelectorAll('.pagedjs_pages .sentence[data-sentence-id]')].map((s) => s.dataset.sentenceId))];
    return [ids[5], ids[40]];
  });
  const migrationId = await page.evaluate(() => window.WriteSysRenderer.currentMigrationID);
  const r1 = await api.post('/notes', { sentence_id: sidA, color: 'yellow', body: 'placement test (sentence)', priority: 'none' });
  check('sentence note created', r1.ok(), String(r1.status()));
  const sNote = (await r1.json()).note_id;
  const srow = psql(`SELECT ns.sentence_id = '${sidA.replace(/'/g, "''")}' AND ns.origin_sentence_id = ns.sentence_id AND ns.sentence_id_history = '[]'::jsonb AND ns.position <> '' FROM note_sentence ns WHERE ns.note_id=${sNote}`);
  check('note_sentence row: the sentence, its origin, a position, an empty history', srow === 't', srow);
  check('a sentence note has no pad row', psql(`SELECT count(*) FROM note_scratchpad WHERE note_id=${sNote}`) === '0');

  // ---- a pad note gets a live note_scratchpad row ----
  const rp = await api.post('/scratchpads', { title: 'Placements pad' });
  check('pad created', rp.ok(), String(rp.status()));
  const padId = (await rp.json()).scratchpad_id;
  const r2 = await api.post('/notes', { scratchpad_id: padId, color: 'green', body: 'placement test (pad)', priority: 'none' });
  check('pad note created', r2.ok(), String(r2.status()));
  const pNote = (await r2.json()).note_id;
  check('pad note has a live note_scratchpad row', padRow(pNote, padId) === 'live', padRow(pNote, padId));
  check('pad note has content version 1 with no sentence', psql(`SELECT count(*) FILTER (WHERE sentence_id IS NULL) || '/' || count(*) FROM note_version WHERE note_id=${pNote}`) === '1/1');

  // ---- the pad SAVE mirrors the doc ----
  let rs = await api.put(`/scratchpads/${padId}`, { title: 'Placements pad', doc: doc(pNote, sNote) });
  check('save with both anchors ok', rs.status() === 204, String(rs.status()));
  check('…pad note still live', padRow(pNote, padId) === 'live');
  check('…a sentence note pasted into the pad gets a live pad row too', padRow(sNote, padId) === 'live', padRow(sNote, padId));
  check('…and keeps its sentence row', psql(`SELECT count(*) FROM note_sentence WHERE note_id=${sNote}`) === '1');
  rs = await api.put(`/scratchpads/${padId}`, { title: 'Placements pad', doc: doc(sNote) });
  check('save without the pad note\'s anchor closes its row, note untouched', padRow(pNote, padId) === 'closed'
    && psql(`SELECT deleted_at IS NULL FROM note WHERE note_id=${pNote}`) === 't', padRow(pNote, padId));
  rs = await api.put(`/scratchpads/${padId}`, { title: 'Placements pad', doc: doc(sNote, pNote) });
  check('anchor back (undo) re-opens the row, no duplicate', padRow(pNote, padId) === 'live'
    && psql(`SELECT count(*) FROM note_scratchpad WHERE scratchpad_id=${padId}`) === '2');
  rs = await api.put(`/scratchpads/${padId}`, { title: 'Placements pad', doc: doc(sNote, pNote, 987654321) });
  check('an anchor to a non-existent note is ignored, save still 204', rs.status() === 204
    && psql(`SELECT count(*) FROM note_scratchpad WHERE scratchpad_id=${padId}`) === '2');

  // ---- phase 2: the margin reads placements — one row per placement ----
  const bookNotes = async () => (await (await api.get(`/migrations/${migrationId}/manuscript`)).json()).notes || [];
  let notes = await bookNotes();
  check('the sentence note is in the book payload on its sentence', notes.some((n) => n.note_id === sNote && n.sentence_id === sidA));
  check('the pad note is not (no sentence placement)', !notes.some((n) => n.note_id === pNote));

  // Attach the pad note to sentence B, and the sentence note to B as well.
  let ra = await api.put(`/notes/${pNote}/sentences/${encodeURIComponent(sidB)}`);
  check('attach: pad note placed on a sentence', ra.ok(), String(ra.status()));
  const pl = await ra.json();
  check('…placements list it: 1 sentence + 1 live pad', pl.sentences.length === 1 && pl.sentences[0].sentence_id === sidB && pl.scratchpads.length === 1 && pl.scratchpads[0].live, JSON.stringify(pl));
  check('…and stamps the manuscript', psql(`SELECT manuscript_id IS NOT NULL FROM note WHERE note_id=${pNote}`) === 't');
  ra = await api.put(`/notes/${sNote}/sentences/${encodeURIComponent(sidB)}`);
  check('attach: a sentence note can sit on a second sentence', ra.ok() && (await ra.json()).sentences.length === 2);
  notes = await bookNotes();
  check('the book payload now carries the sentence note TWICE (A and B)',
    notes.filter((n) => n.note_id === sNote).map((n) => n.sentence_id).sort().join() === [sidA, sidB].sort().join(),
    notes.filter((n) => n.note_id === sNote).map((n) => n.sentence_id).join());
  check('…and the pad note once, on B', notes.filter((n) => n.note_id === pNote).map((n) => n.sentence_id).join() === sidB);
  check('attaching again is a no-op', (await api.put(`/notes/${sNote}/sentences/${encodeURIComponent(sidB)}`)).ok()
    && psql(`SELECT count(*) FROM note_sentence WHERE note_id=${sNote}`) === '2');

  // The margin UI sees it: notes on B via the per-sentence endpoint.
  const onBResp = await (await api.get(`/notes/sentence/${encodeURIComponent(sidB)}`)).json();
  const onB = Array.isArray(onBResp) ? onBResp : (onBResp.notes || []);
  check('GET /notes/sentence/B lists both placements', [sNote, pNote].every((id) => onB.some((n) => n.note_id === id)), JSON.stringify(onB.map((n) => n.note_id)));

  // Detach: the sentence note leaves B, stays on A; the pad note leaves B and is pad-only again.
  let rd = await api.del(`/notes/${sNote}/sentences/${encodeURIComponent(sidB)}`);
  check('detach: 200 with the remaining placements', rd.ok() && (await rd.json()).sentences.map((p) => p.sentence_id).join() === sidA, String(rd.status()));
  check('detaching where it isn\'t placed is 404', (await api.del(`/notes/${sNote}/sentences/${encodeURIComponent(sidB)}`)).status() === 404);
  rd = await api.del(`/notes/${pNote}/sentences/${encodeURIComponent(sidB)}`);
  check('detach: the pad note is pad-only again, NOT deleted', rd.ok()
    && psql(`SELECT count(*) FROM note_sentence WHERE note_id=${pNote}`) === '0'
    && psql(`SELECT deleted_at IS NULL FROM note WHERE note_id=${pNote}`) === 't');

  // ---- free notes ----
  const rf = await api.post('/notes', { color: 'blue', body: 'a free note', priority: 'none' });
  check('a note with no sentence and no pad is created (free note)', rf.status() === 201, String(rf.status()));
  const fNote = (await rf.json()).note_id;
  check('…no placements', psql(`SELECT (SELECT count(*) FROM note_sentence WHERE note_id=${fNote}) + (SELECT count(*) FROM note_scratchpad WHERE note_id=${fNote})`) === '0');
  const home = await (await api.get('/home')).json();
  const fCard = (home.notes || []).find((n) => n.note_id === fNote);
  check('…it shows on the landing page with no context', !!fCard && !fCard.context, JSON.stringify(fCard && fCard.context));
  const ru = await api.put(`/notes/${fNote}`, { body: 'a free note, edited', color: 'red' });
  check('…it can be edited (content version appended)', ru.ok() && psql(`SELECT count(*) FROM note_version WHERE note_id=${fNote}`) === '2', String(ru.status()));
  ra = await api.put(`/notes/${fNote}/sentences/${encodeURIComponent(sidA)}`);
  check('…and placed on a sentence later', ra.ok() && (await bookNotes()).some((n) => n.note_id === fNote && n.sentence_id === sidA));
  rd = await api.del(`/notes/${fNote}/sentences/${encodeURIComponent(sidA)}`);
  check('…and taken off again, becoming free (not deleted)', rd.ok() && psql(`SELECT deleted_at IS NULL FROM note WHERE note_id=${fNote}`) === 't');
  const rdel = await api.del(`/notes/${fNote}`);
  check('the trash deletes a free note', rdel.status() === 204);

  // ---- deleting the pad closes every placement; notes survive ----
  const rpd = await api.del(`/scratchpads/${padId}`);
  check('pad deleted', rpd.ok(), String(rpd.status()));
  check('…every placement in it is closed', psql(`SELECT count(*) FROM note_scratchpad WHERE scratchpad_id=${padId} AND removed_at IS NULL`) === '0');
  check('…the pad note survives as a free note', psql(`SELECT deleted_at IS NULL FROM note WHERE note_id=${pNote}`) === 't');
  check('…the pasted sentence note survives on its sentence', psql(`SELECT deleted_at IS NULL FROM note WHERE note_id=${sNote}`) === 't'
    && (await bookNotes()).some((n) => n.note_id === sNote && n.sentence_id === sidA));
  const home2 = await (await api.get('/home')).json();
  const pCard = (home2.notes || []).find((n) => n.note_id === pNote);
  check('…a note from a deleted pad shows no pad context', !!pCard && !pCard.scratchpad_id, JSON.stringify(pCard && { ctx: pCard.context, pad: pCard.scratchpad_id }));

  await cleanupTestNotes();
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
