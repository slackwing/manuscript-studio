// import-scratchpad.js e2e (CODE_REVIEW_AUG_2026 Area 1, the
// import-scratchpad half of the last table — 8 rows; canonize-two-step-failure
// ⚠ lives in test-editor-pending-fixes.js):
//   proximity-single-hot, eligibility-filtering, slug-collision-guard,
//   stale-migration-409, replace-mode-marker, freeze-all-prompt (accept /
//   decline / failure-non-fatal), stale-draft-purge, hash-scroll-retry.
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const {
  TEST_URL, TEST_MANUSCRIPT_ID,
  cleanupTestNotes, loginAsTestUser,
  waitForPagination, paginationStamp, waitForRepagination,
} = require('./test-utils');
function psql(sql) {
  return execSync(
    `PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8' }).trim();
}

(async () => {
  console.log('=== import-scratchpad (book-side canonize) e2e ===\n');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } });
  let freezeMode = 'accept'; // how to answer the "Freeze all variations?" confirm
  const dialogs = [];
  page.on('dialog', (d) => {
    dialogs.push(d.message());
    if (/Freeze all variations/.test(d.message()) && freezeMode === 'dismiss') d.dismiss().catch(() => {});
    else d.accept().catch(() => {});
  });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  let failed = 0;
  const check = (n, ok, extra) => {
    console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`);
    if (!ok) failed++;
  };

  await cleanupTestNotes();
  await loginAsTestUser(page);

  try {
    // ---- API setup: the sketch cast ---------------------------------------
    // S1 eligible; S2 canonized (disabled); S3 linked elsewhere (disabled);
    // S4 accept-freeze (2 variations); S5 freeze-500; S6 slug-collision;
    // S7 replace-mode.
    await page.goto(TEST_URL, { waitUntil: 'domcontentloaded' });
    // index.html seeds sessionStorage.csrf_token asynchronously — wait for it.
    await page.waitForFunction(() =>
      sessionStorage.getItem('csrf_token') || localStorage.getItem('csrf_token'), null, { timeout: 15000 });
    const cast = await page.evaluate(async () => {
      const csrf = (localStorage.getItem('csrf_token') || sessionStorage.getItem('csrf_token')) || '';
      const H = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf };
      const mk = async (text) => {
        const s = await (await fetch('api/sketches', { method: 'POST', headers: H, body: JSON.stringify({ mode: 'new' }) })).json();
        await fetch(`api/variations/${s.variation.variation_id}`, { method: 'PUT', headers: H, body: JSON.stringify({ text }) });
        return { sketchId: s.sketch.sketch_id, varId: s.variation.variation_id };
      };
      const s1 = await mk('Eligible variation body one. It has two sentences.');
      const s2 = await mk('Already canonized body.');
      const s3 = await mk('Linked elsewhere body.');
      const s4 = await mk('Freeze accept body.');
      const s4b = await (await fetch('api/sketches', { method: 'POST', headers: H, body: JSON.stringify({ mode: 'variation', source_variation_id: s4.varId }) })).json();
      const s5 = await mk('Freeze failure body.');
      const s6 = await mk('Slug collision body.');
      const s7 = await mk('Replace mode body for the marker test.');
      return { s1, s2, s3, s4: { ...s4, varB: s4b.variation.variation_id }, s5, s6, s7, csrf };
    });
    // S2: canonize directly (no region needed for the eligibility flag).
    const s2can = await page.evaluate(async (a) => {
      const r = await fetch(`api/variations/${a.varId}/canonize`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': a.csrf },
        body: JSON.stringify({ manuscript_id: a.mid }),
      });
      return r.status;
    }, { varId: cast.s2.varId, csrf: cast.csrf, mid: TEST_MANUSCRIPT_ID });
    check('S2 canonized via API (eligibility fixture)', s2can === 200 || s2can === 201 || s2can === 204, `status=${s2can}`);
    // S3: linked to a FOREIGN manuscript (worker 1's fixture row).
    psql(`UPDATE sketch SET linked_manuscript_id = (SELECT manuscript_id FROM manuscript WHERE manuscript_id <> ${TEST_MANUSCRIPT_ID} ORDER BY manuscript_id LIMIT 1) WHERE sketch_id='${cast.s3.sketchId}'`);
    // S6: its slug already lives in the effective manuscript via a plain
    // API suggestion (no canonize) — the client guard must catch it.
    await page.evaluate(async (a) => {
      const mig = await (await fetch(`api/migrations/latest?manuscript_id=${a.mid}`, { credentials: 'same-origin' })).json();
      const data = await (await fetch(`api/migrations/${mig.migration_id}/manuscript`, { credentials: 'same-origin' })).json();
      const s = data.sentences[30];
      await fetch(`api/sentences/${encodeURIComponent(s.id)}/suggestion`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': a.csrf },
        body: JSON.stringify({ text: `${s.text.replace(/\s+$/, '')}\n&sketch#${a.slug}{Zed}\n\tpre-existing region\n&end#${a.slug}` }),
      });
    }, { mid: TEST_MANUSCRIPT_ID, csrf: cast.csrf, slug: cast.s6.sketchId });

    // ---- load the book ----------------------------------------------------
    await page.goto(TEST_URL);
    await waitForPagination(page);
    await page.waitForSelector('.import-zone .import-tab', { timeout: 20000 });

    // ---- proximity-single-hot --------------------------------------------
    {
      const zones = await page.evaluate(() =>
        [...document.querySelectorAll('.import-zone')].map((z) => {
          const r = z.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width };
        }).filter(z => z.y > 0 && z.y < window.innerHeight));
      check('import zones exist in the viewport', zones.length >= 2, `zones=${zones.length}`);
      let maxHot = 0, hotOnTarget = false;
      await page.mouse.move(zones[0].x, zones[0].y);
      await page.waitForTimeout(120);
      await page.mouse.move(zones[0].x + 1, zones[0].y); // beat the 33ms throttle
      await page.waitForFunction(() => document.querySelectorAll('.import-zone.import-hot').length === 1, null, { timeout: 5000 });
      hotOnTarget = await page.evaluate((y) => {
        const hot = document.querySelector('.import-zone.import-hot');
        const r = hot.getBoundingClientRect();
        return Math.abs((r.top + r.height / 2) - y) <= 27;
      }, zones[0].y);
      check('hovering a gap lights exactly ONE + (the nearest zone)', hotOnTarget);
      // Sweep down the column — never more than one hot at a time.
      for (const z of zones.slice(0, 4)) {
        await page.mouse.move(z.x, z.y + 3);
        await page.waitForTimeout(80);
        maxHot = Math.max(maxHot, await page.locator('.import-zone.import-hot').count());
      }
      check('sweeping the column never lights two zones', maxHot <= 1, `max=${maxHot}`);
      // Way off the column (>80px past the zone's right edge) → none.
      await page.mouse.move(zones[0].x + zones[0].w / 2 + 200, zones[0].y);
      await page.waitForTimeout(80);
      await page.mouse.move(zones[0].x + zones[0].w / 2 + 201, zones[0].y);
      await page.waitForFunction(() => document.querySelectorAll('.import-zone.import-hot').length === 0, null, { timeout: 5000 });
      check('>80px off-column lights nothing', true);
    }

    // ---- open the modal at zone[0] ---------------------------------------
    const boundary1 = await page.evaluate(() => {
      const z = document.querySelector('.import-zone');
      z.querySelector('.import-tab').click();
      return z.dataset.sentenceId;
    });
    await page.waitForSelector('#import-modal');
    await page.waitForSelector('.im-block');

    // ---- eligibility-filtering -------------------------------------------
    const rows = await page.evaluate(() =>
      [...document.querySelectorAll('.im-block')].map(b => ({
        text: b.querySelector('.im-block-text').textContent,
        disabled: b.querySelector('input').disabled,
      })));
    const rowFor = (needle) => rows.find(r => r.text.includes(needle));
    check('eligible variation is selectable', rowFor('Eligible variation') && !rowFor('Eligible variation').disabled);
    check('canonized group disabled with "already placed"',
      rowFor('Already canonized') && rowFor('Already canonized').disabled
      && /already placed/.test(rowFor('Already canonized').text), rowFor('Already canonized') && rowFor('Already canonized').text.slice(-60));
    check('foreign-linked group disabled with "linked to …"',
      rowFor('Linked elsewhere') && rowFor('Linked elsewhere').disabled
      && /linked to/.test(rowFor('Linked elsewhere').text), rowFor('Linked elsewhere') && rowFor('Linked elsewhere').text.slice(-60));

    // ---- stale-migration-409 + stale-draft-purge + decline-freeze ---------
    await page.evaluate((a) => {
      // A crash-leftover suggest-edit draft for the boundary — must be purged.
      localStorage.setItem(`ms-draft-suggest-${a.b}`, JSON.stringify({ t: 'stale draft', at: Date.now() }));
      const rows = [...document.querySelectorAll('.im-block')];
      rows.find(r => /Eligible variation/.test(r.textContent)).querySelector('input').click();
    }, { b: boundary1 });
    await page.fill('#im-label', 'Region One');
    {
      let block = true;
      await page.route('**/suggestion', (route) => {
        if (route.request().method() === 'PUT' && block) return route.fulfill({ status: 409, body: 'stale' });
        return route.continue();
      });
      await page.click('#im-go');
      await page.waitForFunction(() =>
        /manuscript changed under you/.test((document.querySelector('#im-error') || {}).textContent || ''));
      check('suggestion PUT 409 → "manuscript changed" message', true);
      check('modal stays open for a retry', (await page.locator('#import-modal').count()) === 1);
      block = false;
      await page.unroute('**/suggestion');
    }
    // Retry for real; DECLINE the freeze-all prompt this time.
    freezeMode = 'dismiss';
    const stamp1 = await paginationStamp(page);
    await page.click('#im-go');
    await page.waitForSelector('#import-modal', { state: 'detached', timeout: 30000 });
    await waitForRepagination(page, stamp1);
    check('canonize completed (modal closed, book re-rendered)', true);
    check('freeze-all was PROMPTED', dialogs.some(m => /Freeze all variations/.test(m)));
    check('declining the freeze prompt leaves the variation draft',
      psql(`SELECT state FROM variation WHERE variation_id=${cast.s1.varId}`) === 'draft');
    check('S1 canonized (canon pointer set)',
      psql(`SELECT canon_variation_id FROM sketch WHERE sketch_id='${cast.s1.sketchId}'`) === String(cast.s1.varId));
    const draftGone = await page.evaluate((b) => localStorage.getItem(`ms-draft-suggest-${b}`) === null, boundary1);
    check('stale suggest-edit draft purged after canonize', draftGone);
    const rendered = await page.evaluate(() =>
      [...document.querySelectorAll('.pagedjs_pages .sentence')].some(s => /Eligible variation body one/.test(s.textContent)));
    check('the placed region renders in the book', rendered);

    // ---- freeze-all-prompt: ACCEPT freezes every variation ---------------
    freezeMode = 'accept';
    {
      await page.waitForSelector('.import-zone .import-tab', { timeout: 20000 });
      await page.evaluate((b1) => {
        const z = [...document.querySelectorAll('.import-zone')].find(z => z.dataset.sentenceId !== b1);
        z.querySelector('.import-tab').click();
      }, boundary1);
      await page.waitForSelector('.im-block');
      await page.evaluate(() => {
        [...document.querySelectorAll('.im-block')].find(r => /Freeze accept body/.test(r.textContent)).querySelector('input').click();
      });
      await page.fill('#im-label', 'Region Two');
      const stamp = await paginationStamp(page);
      await page.click('#im-go');
      await page.waitForSelector('#import-modal', { state: 'detached', timeout: 30000 });
      await waitForRepagination(page, stamp);
      let frozen = '';
      for (let i = 0; i < 40; i++) {
        frozen = psql(`SELECT count(*) FROM variation WHERE sketch_id='${cast.s4.sketchId}' AND state='frozen' AND ordinal IS NOT NULL`);
        if (frozen === '2') break;
        await new Promise(r => setTimeout(r, 200));
      }
      check('accepting the freeze prompt freezes ALL the group\'s variations', frozen === '2', `frozen=${frozen}`);
    }

    // ---- freeze-all-prompt: a freeze-all failure is NON-fatal ------------
    {
      await page.route('**/freeze-all', (route) => route.fulfill({ status: 500, body: 'freezer broken' }));
      await page.waitForSelector('.import-zone .import-tab', { timeout: 20000 });
      await page.evaluate((b1) => {
        const zones = [...document.querySelectorAll('.import-zone')].filter(z => z.dataset.sentenceId !== b1);
        zones[zones.length - 1].querySelector('.import-tab').click();
      }, boundary1);
      await page.waitForSelector('.im-block');
      await page.evaluate(() => {
        [...document.querySelectorAll('.im-block')].find(r => /Freeze failure body/.test(r.textContent)).querySelector('input').click();
      });
      await page.fill('#im-label', 'Region Three'); // labeled → outline lists it (hash test target)
      const stamp = await paginationStamp(page);
      await page.click('#im-go');
      await page.waitForSelector('#import-modal', { state: 'detached', timeout: 30000 });
      await waitForRepagination(page, stamp);
      check('freeze-all 500 does NOT undo the canonize (modal closed, canon set)',
        psql(`SELECT canon_variation_id FROM sketch WHERE sketch_id='${cast.s5.sketchId}'`) === String(cast.s5.varId));
      await page.unroute('**/freeze-all');
    }

    // ---- slug-collision-guard (fresh load so S6's suggestion is live) -----
    {
      await page.goto(TEST_URL);
      await waitForPagination(page);
      await page.waitForSelector('.import-zone .import-tab', { timeout: 20000 });
      let sugPuts = 0;
      await page.route('**/suggestion', (route) => {
        if (route.request().method() === 'PUT') sugPuts++;
        return route.continue();
      });
      await page.evaluate(() => document.querySelector('.import-zone .import-tab').click());
      await page.waitForSelector('.im-block');
      await page.evaluate(() => {
        [...document.querySelectorAll('.im-block')].find(r => /Slug collision body/.test(r.textContent)).querySelector('input').click();
      });
      await page.click('#im-go');
      await page.waitForFunction((slug) =>
        new RegExp(`Sketch #${slug} already appears`).test((document.querySelector('#im-error') || {}).textContent || ''), cast.s6.sketchId);
      check('slug already effective → error, canonize refused', true);
      check('…and NO suggestion PUT was attempted', sugPuts === 0, `puts=${sugPuts}`);
      await page.unroute('**/suggestion');
      await page.evaluate(() => window.WriteSysImportScratchpad.closeModal());
    }

    // ---- replace-mode-marker ---------------------------------------------
    // The fixture has no committed &placeholder, so drive the replace path
    // directly at a marker-led committed sentence ('\n\t' paragraph 21) and
    // assert the suggested text KEEPS the leading structural marker.
    {
      // Pick a marker-led committed sentence DYNAMICALLY — sentence ids are
      // per-fixture (worker fixtures drift as pushes re-migrate them), so a
      // hard-coded id only exists on the worker it was copied from.
      const targetInfo = await page.evaluate(() => {
        const R = window.WriteSysRenderer;
        const s = (R.currentSentences || []).find((x) =>
          x.text.startsWith('\n\t') && !x.text.includes('&') && x.text.trim().length > 20);
        return s ? { id: s.id, opening: s.text.trim().split(/\s+/).slice(0, 3).join(' ') } : null;
      });
      check('replace-mode: found a \\n\\t-led committed sentence', !!targetInfo);
      const target = targetInfo.id;
      let putBody = null;
      await page.route('**/suggestion', (route) => {
        if (route.request().method() === 'PUT' && route.request().url().includes(target)) {
          putBody = JSON.parse(route.request().postData()).text;
        }
        return route.continue();
      });
      await page.evaluate((a) => {
        window.WriteSysImportScratchpad.openModal({ mode: 'replace', sentenceId: a.target, slug: 'legacy-ph-slug' });
      }, { target });
      await page.waitForSelector('.im-block');
      check('replace-mode modal explains the placeholder swap',
        await page.evaluate(() => /Replaces placeholder/.test(document.querySelector('.im-hint').textContent)));
      await page.evaluate(() => {
        [...document.querySelectorAll('.im-block')].find(r => /Replace mode body/.test(r.textContent)).querySelector('input').click();
      });
      await page.fill('#im-label', 'Marker Kept');
      const stamp = await paginationStamp(page);
      await page.click('#im-go');
      await page.waitForSelector('#import-modal', { state: 'detached', timeout: 30000 });
      await waitForRepagination(page, stamp);
      check('replace-mode suggestion PUT captured', !!putBody);
      check('replace-mode keeps the LEADING MARKER and drops the old body',
        !!putBody && putBody.startsWith(`\n\t&sketch#${cast.s7.sketchId}{Marker Kept}\n\t`)
        && !putBody.includes(targetInfo.opening), JSON.stringify((putBody || '').slice(0, 60)));
      await page.unroute('**/suggestion');
    }

    // ---- hash-scroll-retry ------------------------------------------------
    {
      // S5's region was placed at the LAST zone — below the fold, so the deep
      // link must actually scroll (S1's region sits near the top). On a slow
      // pagination the ticker's 40×500ms lifetime can lapse before the
      // outline resolves (the documented give-up), so once the outline IS
      // resolved re-invoke initHashScroll — the scroll must then land.
      await page.goto(`${TEST_URL}#${cast.s5.sketchId}`);
      await waitForPagination(page);
      await page.waitForFunction((slug) => {
        const map = (window.WriteSysOutline && window.WriteSysOutline.slugMap) || {};
        return !!(map[slug] && document.querySelector(`.sentence[data-sentence-id="${CSS.escape(map[slug])}"]`));
      }, cast.s5.sketchId, { timeout: 30000 });
      // If the in-page ticker already scrolled, this second invocation is a
      // no-op re-scroll to the same spot; if it gave up, this is the retry.
      await page.evaluate(() => window.WriteSysImportScratchpad.initHashScroll());
      let scrolled = false, pos = null;
      for (let i = 0; i < 40 && !scrolled; i++) {
        pos = await page.evaluate((slug) => {
          const map = (window.WriteSysOutline && window.WriteSysOutline.slugMap) || {};
          const el = document.querySelector(`.sentence[data-sentence-id="${CSS.escape(map[slug])}"]`);
          const r = el.getBoundingClientRect();
          return { top: r.top, inView: r.top > -80 && r.top < window.innerHeight, scrollY: window.scrollY };
        }, cast.s5.sketchId);
        scrolled = !!(pos && pos.inView && pos.scrollY > 0);
        if (!scrolled) await page.waitForTimeout(250);
      }
      check('#<slug> hash scrolls to the region once the outline resolves', scrolled, JSON.stringify(pos));
      // A bogus slug: no crash, no scroll (short negative window; the full
      // 40-try give-up is ~20s and not worth the wall time here).
      errs.length = 0;
      await page.goto(`${TEST_URL}#totally-bogus-slug`); // hash-only change…
      await page.reload();                               // …so force a real load
      await waitForPagination(page);
      await page.evaluate(() => window.scrollTo(0, 0)); // defeat scroll restoration
      for (let i = 0; i < 5; i++) await page.waitForTimeout(400);
      check('a bogus slug neither scrolls nor crashes',
        (await page.evaluate(() => window.scrollY)) === 0 && errs.length === 0);
    }

    check('no page errors', errs.length === 0, errs.slice(0, 3).join('; '));
  } finally {
    // Wipe this worker's suggestions + sketches (regions live only as
    // suggestions, so the manuscript is clean again).
    psql(`DELETE FROM suggested_change WHERE sentence_id IN (
      SELECT sentence_id FROM sentence WHERE migration_id IN (
        SELECT migration_id FROM migration WHERE manuscript_id = ${TEST_MANUSCRIPT_ID}))`);
    await cleanupTestNotes();
    await browser.close();
  }

  console.log(failed === 0 ? '\n✅ Test passed' : `\n❌ ${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('Test crashed:', e); process.exit(1); });
