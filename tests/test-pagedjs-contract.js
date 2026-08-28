/**
 * pagedjs-config contract e2e — CODE_REVIEW_AUG_2026.md AREA 3 §3.4:
 *   P1 document.body.dataset.paginated is a monotonic +1-per-pass counter —
 *      the test harness's OWN synchronization primitive (waitForPagination /
 *      waitForRepagination consume it), so it gets pinned first.
 *   P3 afterRendered work lands on the NEW pages after an in-place
 *      re-render (the old/new-tree coexistence race): inter-sentence
 *      spaces, hover handlers, rainbow bars.
 *   P2 pages whose content holds a &part/&title heading are tagged
 *      .no-folio and their page-number box is hidden.
 */
const { execSync } = require('child_process');
const { chromium } = require('playwright');
const {
  BASE_URL, TEST_URL, TEST_USERNAME, TEST_PASSWORD,
  waitForPagination, paginationStamp, waitForRepagination, cleanupTestAnnotations,
} = require('./test-utils');

const psql = (sql) => execSync(
  `PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`,
  { encoding: 'utf-8' }).trim();

(async () => {
  console.log('=== pagedjs-config contract e2e (P1 P2 P3) ===\n');
  psql(`DELETE FROM suggested_change WHERE user_id='${TEST_USERNAME}'`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  let failed = false;
  const check = (n, ok, extra) => {
    console.log(`${ok ? '✅' : '❌'} ${n}${extra !== undefined ? ' — ' + extra : ''}`);
    if (!ok) failed = true;
  };

  try {
    await page.goto(`${BASE_URL}/login.html`);
    await page.evaluate(async ([u, p]) => {
      const r = await fetch('api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify({ username: u, password: p }),
      });
      const d = await r.json();
      localStorage.setItem('csrf_token', d.csrf_token);
    }, [TEST_USERNAME, TEST_PASSWORD]);

    // A colored note BEFORE page load so currentNotes (and rainbow bars)
    // exist from the first render.
    await page.goto(TEST_URL);
    await waitForPagination(page);
    const noted = await page.evaluate(async () => {
      const spans = [...document.querySelectorAll('.pagedjs_pages .sentence[data-sentence-id]')];
      const el = spans.find((s) => s.textContent.trim().length > 40 && !s.textContent.trim().startsWith('#'));
      const sid = el.dataset.sentenceId;
      const r = await fetch('api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': localStorage.getItem('csrf_token') || '' },
        credentials: 'same-origin',
        body: JSON.stringify({ sentence_id: sid, color: 'green', body: 'rainbow contract note', priority: 'none', flagged: false }),
      });
      const d = await r.json();
      return { sid, noteId: d.note_id };
    });
    check('Setup: note created for the rainbow-bar contract', !!noted.noteId, `note ${noted.noteId} on ${noted.sid.slice(0, 12)}`);
    await page.goto(TEST_URL); // reload so data.notes includes it
    await waitForPagination(page);

    // ---- P1: monotonic counter --------------------------------------------
    const s0 = parseInt(await paginationStamp(page), 10);
    check('P1: initial load bumped the counter at least once', s0 >= 1, `paginated=${s0}`);
    await page.evaluate(() => window.WriteSysRenderer.renderManuscript());
    const s1 = parseInt(await paginationStamp(page), 10);
    check('P1: one re-render → exactly +1', s1 === s0 + 1, `${s0} → ${s1}`);
    await page.evaluate(() => window.WriteSysRenderer.renderManuscript());
    const s2 = parseInt(await paginationStamp(page), 10);
    check('P1: second re-render → exactly +1 again (monotonic, never resets)',
      s2 === s1 + 1, `${s1} → ${s2}`);

    // ---- P3: afterRendered work lands on the NEW pages ---------------------
    // The two renders above were in-place re-renders; the CURRENT tree is a
    // "new" tree that briefly coexisted with its predecessor. Everything the
    // afterRendered hook + post-swap re-runs provide must be present HERE.
    const p3 = await page.evaluate((sid) => {
      const trees = document.querySelectorAll('.pagedjs_pages');
      // Inter-sentence separators: adjacent sentences join through a
      // .sent-sp span carrying a real space — baked in at render time,
      // because an ELEMENT survives pagination where the old bare text
      // node did not (the page-boundary word-loss bug).
      let spacedChecked = 0, spacedOk = 0;
      trees[0].querySelectorAll('p').forEach((p) => {
        const kids = [...p.childNodes].filter((n) => !(n.nodeType === 3 && !n.nodeValue.trim()));
        for (let i = 1; i < kids.length; i++) {
          const a = kids[i - 1], b = kids[i];
          if (a.nodeType !== 1 || !a.classList.contains('sentence')) continue;
          if (b.nodeType === 1 && b.classList.contains('sentence')) {
            spacedChecked += 1; // adjacent with NO separator = missing space
          } else if (b.nodeType === 1 && b.classList.contains('sent-sp') && /\s/.test(b.textContent)
            && kids[i + 1] && kids[i + 1].nodeType === 1 && kids[i + 1].classList.contains('sentence')) {
            spacedChecked += 1; spacedOk += 1;
          }
        }
      });
      const bars = [...document.querySelectorAll('.rainbow-bar-container')];
      const barInLiveTree = bars.some((b) => trees[0].contains(b));
      const barOnNotedPage = bars.some((b) => {
        const frag = document.querySelector(`.sentence[data-sentence-id="${CSS.escape(sid)}"]`);
        return frag && b.closest('.pagedjs_page') === frag.closest('.pagedjs_page');
      });
      return {
        trees: trees.length,
        spacedChecked, spacedOk,
        bars: bars.length, barInLiveTree, barOnNotedPage,
      };
    }, noted.sid);
    check('P3: single live tree after re-renders', p3.trees === 1, `trees=${p3.trees}`);
    check('P3: NEW pages keep their inter-sentence separator spans',
      p3.spacedChecked > 0 && p3.spacedOk === p3.spacedChecked,
      `${p3.spacedOk}/${p3.spacedChecked} adjacent pairs spaced`);
    check('P3: rainbow bars re-attached inside the NEW tree, on the noted page',
      p3.bars > 0 && p3.barInLiveTree && p3.barOnNotedPage,
      `bars=${p3.bars} inLive=${p3.barInLiveTree} onPage=${p3.barOnNotedPage}`);
    // Hover handlers were re-bound on the new spans.
    const hoverId = await page.evaluate(() => {
      const el = document.querySelector('.pagedjs_pages .sentence[data-sentence-id]');
      return el.dataset.sentenceId;
    });
    await page.locator(`.sentence[data-sentence-id="${hoverId}"]`).first().hover();
    check('P3: hover handlers live on the NEW pages',
      await page.evaluate((id) =>
        [...document.querySelectorAll(`.sentence[data-sentence-id="${CSS.escape(id)}"]`)]
          .every((el) => el.classList.contains('hover')), hoverId));
    await page.mouse.move(5, 5);

    // ---- P5: no sentence fragment escapes its page box ---------------------
    // The 2026-08 word-loss bug: pagination measured text WITHOUT its
    // inter-sentence spaces (bare text nodes die in pagination), then the
    // post-hoc space pass re-wrapped lines into the multicol phantom
    // column beyond the page edge — words invisible at page boundaries.
    const p5 = await page.evaluate(() => {
      let escaped = 0;
      document.querySelectorAll('.pagedjs_pages .sentence').forEach((el) => {
        const pg = el.closest('.pagedjs_page');
        if (!pg) return;
        const b = pg.getBoundingClientRect();
        for (const r of el.getClientRects()) {
          if (r.width > 0 && r.right > b.right + 2) { escaped += 1; break; }
        }
      });
      return escaped;
    });
    check('P5: no sentence fragment parked beyond its page edge', p5 === 0, `escaped=${p5}`);

    // ---- P2: no-folio on &part/&title divider pages ------------------------
    // The fixture is markdown-only, so inject a SUGGESTED &part — the
    // effective render must tag its page .no-folio and hide the folio box.
    const partSid = await page.evaluate(async () => {
      const spans = [...document.querySelectorAll('.pagedjs_pages .sentence[data-sentence-id]')];
      const seen = {};
      spans.forEach((s) => { seen[s.dataset.sentenceId] = (seen[s.dataset.sentenceId] || 0) + 1; });
      const el = spans.find((s) => s.textContent.trim().length > 40
        && !s.textContent.trim().startsWith('#') && seen[s.dataset.sentenceId] === 1);
      const sid = el.dataset.sentenceId;
      await fetch(`api/sentences/${encodeURIComponent(sid)}/suggestion`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': localStorage.getItem('csrf_token') || '' },
        credentials: 'same-origin',
        body: JSON.stringify({ text: '&part{Contract Part}' }),
      });
      await window.WriteSysSuggestions.loadForMigration(window.WriteSysRenderer.currentMigrationID);
      await window.WriteSysRenderer.renderManuscript();
      return sid;
    });
    const p2 = await page.evaluate(() => {
      const part = document.querySelector('.pagedjs_pages .cmd-part');
      if (!part) return { part: false };
      const partPage = part.closest('.pagedjs_page');
      const folioBox = partPage.querySelector('.pagedjs_margin-bottom-right');
      const otherPage = [...document.querySelectorAll('.pagedjs_page')]
        .find((p) => p !== partPage && !p.querySelector('.cmd-part, .cmd-title'));
      const otherFolio = otherPage && otherPage.querySelector('.pagedjs_margin-bottom-right');
      return {
        part: true,
        tagged: partPage.classList.contains('no-folio'),
        folioHidden: folioBox ? getComputedStyle(folioBox).visibility === 'hidden' : null,
        otherTagged: otherPage ? otherPage.classList.contains('no-folio') : null,
        otherFolioVisible: otherFolio ? getComputedStyle(otherFolio).visibility !== 'hidden' : null,
      };
    });
    check('P2: suggested &part renders on a page', p2.part === true);
    check('P2: the part page is tagged .no-folio and its folio box is hidden',
      p2.tagged === true && p2.folioHidden === true,
      `tagged=${p2.tagged} hidden=${p2.folioHidden}`);
    check('P2: ordinary pages keep their folio',
      p2.otherTagged === false && p2.otherFolioVisible === true,
      `otherTagged=${p2.otherTagged} otherVisible=${p2.otherFolioVisible}`);
    // Cleanup the suggestion IN PLACE (refetch + re-render): the outline
    // empties without a reload now that outline.render resets its cached
    // nodes on the non-empty → empty transition (asserted in
    // test-render-pending-fixes.js).
    await page.evaluate(async (sid) => {
      await fetch(`api/sentences/${encodeURIComponent(sid)}/suggestion`, {
        method: 'DELETE',
        headers: { 'X-CSRF-Token': localStorage.getItem('csrf_token') || '' },
        credentials: 'same-origin',
      });
      await window.WriteSysSuggestions.loadForMigration(window.WriteSysRenderer.currentMigrationID);
      await window.WriteSysRenderer.renderManuscript();
    }, partSid);

  } catch (e) {
    console.log(`❌ Test errored: ${e.message}`);
    failed = true;
  } finally {
    psql(`DELETE FROM suggested_change WHERE user_id='${TEST_USERNAME}'`);
    await cleanupTestAnnotations();
    await browser.close();
  }

  console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('Test crashed:', e); process.exit(1); });
