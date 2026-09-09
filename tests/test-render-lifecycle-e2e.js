/**
 * Render lifecycle e2e — CODE_REVIEW_AUG_2026.md AREA 3 §3.4 renderer table:
 *   R26 init redirect without ?manuscript_id
 *   R23 sentence hover crosses page-split fragments
 *   R24 sentence click passes FULL sentenceMap text to notes (not fragment
 *       textContent)
 *   R17 renderManuscript anchor restore (incl. scroll-during-pagination)
 *   R18 renderManuscript selectSentenceId + outline page info after preview
 *   R27 inline &reference delegated click (survives re-render)
 *   R20 responsive scaling math (mobile scale + margin compensation; desktop
 *       clears)
 *   R21 migration-poll banner (transient error tolerated; banner once; poll
 *       cleared; Reload works)
 */
const { execSync } = require('child_process');
const { chromium } = require('playwright');
const {
  BASE_URL, TEST_URL, TEST_USERNAME, TEST_PASSWORD,
  waitForPagination,
} = require('./test-utils');

const psql = (sql) => execSync(
  `PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`,
  { encoding: 'utf-8' }).trim();

(async () => {
  console.log('=== Render lifecycle e2e (R17 R18 R20 R21 R23 R24 R26 R27) ===\n');
  psql(`DELETE FROM suggested_change WHERE user_id='${TEST_USERNAME}'`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  let failed = false;
  const check = (n, ok, extra) => {
    console.log(`${ok ? '✅' : '❌'} ${n}${extra !== undefined ? ' — ' + extra : ''}`);
    if (!ok) failed = true;
  };

  // In-page login so csrf_token lands in localStorage (needed for API PUTs
  // issued from page.evaluate).
  const login = async () => {
    await page.goto(`${BASE_URL}/login.html`);
    await page.evaluate(async ([u, p]) => {
      const r = await fetch('api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify({ username: u, password: p }),
      });
      const d = await r.json();
      localStorage.setItem('csrf_token', d.csrf_token);
    }, [TEST_USERNAME, TEST_PASSWORD]);
  };

  const putSuggestion = (id, text) => page.evaluate(async ([sid, t]) => {
    const r = await fetch(`api/sentences/${encodeURIComponent(sid)}/suggestion`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': localStorage.getItem('csrf_token') || '' },
      credentials: 'same-origin',
      body: JSON.stringify({ text: t }),
    });
    return r.status;
  }, [id, text]);

  const reloadSuggestionsAndRender = (opts) => page.evaluate(async (o) => {
    await window.WriteSysSuggestions.loadForMigration(window.WriteSysRenderer.currentMigrationID);
    await window.WriteSysRenderer.renderManuscript(o || {});
  }, opts || null);

  try {
    await login();

    // ---- R26: book page without ?manuscript_id redirects to home ----------
    await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/home\.html/, { timeout: 10000 });
    check('R26: no ?manuscript_id → replaced with home.html', /home\.html/.test(page.url()));

    // ---- main load ---------------------------------------------------------
    await page.goto(TEST_URL);
    await waitForPagination(page);

    // ---- R23: hover crosses page-split fragments ---------------------------
    const split = await page.evaluate(() => {
      const counts = {};
      document.querySelectorAll('.pagedjs_pages .sentence[data-sentence-id]').forEach((el) => {
        const id = el.dataset.sentenceId;
        counts[id] = (counts[id] || 0) + 1;
      });
      // Prefer a sentence split across DIFFERENT pages (the real page-break
      // fragment case).
      let best = null;
      for (const [id, n] of Object.entries(counts)) {
        if (n < 2) continue;
        const frags = [...document.querySelectorAll(`.sentence[data-sentence-id="${CSS.escape(id)}"]`)];
        const pages = new Set(frags.map((f) => f.closest('.pagedjs_page')));
        if (pages.size > 1) { best = { id, n, crossPage: true }; break; }
        if (!best) best = { id, n, crossPage: false };
      }
      return best;
    });
    check('R23: found a page-split (multi-fragment) sentence', !!split,
      split ? `${split.n} fragments, crossPage=${split.crossPage}` : 'none');
    if (split) {
      await page.locator(`.sentence[data-sentence-id="${split.id}"]`).first().hover();
      const hovered = await page.evaluate((id) =>
        [...document.querySelectorAll(`.sentence[data-sentence-id="${CSS.escape(id)}"]`)]
          .map((el) => el.classList.contains('hover')), split.id);
      check('R23: hover highlights ALL fragments of the sentence',
        hovered.length === split.n && hovered.every(Boolean), JSON.stringify(hovered));
      await page.mouse.move(5, 5);
      const unhovered = await page.evaluate((id) =>
        [...document.querySelectorAll(`.sentence[data-sentence-id="${CSS.escape(id)}"]`)]
          .every((el) => !el.classList.contains('hover')), split.id);
      check('R23: mouseleave clears hover on all fragments', unhovered);
    }

    // ---- R24: click uses full sentenceMap text, selects all fragments ------
    if (split) {
      const r24 = await page.evaluate((id) => {
        const R = window.WriteSysRenderer;
        const orig = window.WriteSysNotes && window.WriteSysNotes.showNotesForSentence;
        const captured = [];
        if (window.WriteSysNotes) {
          window.WriteSysNotes.showNotesForSentence = (sid, text) => { captured.push({ sid, text }); };
        }
        // Click the LAST fragment — its textContent is a partial tail.
        const frags = [...document.querySelectorAll(`.sentence[data-sentence-id="${CSS.escape(id)}"]`)];
        const frag = frags[frags.length - 1];
        const fragText = frag.textContent;
        frag.click();
        if (window.WriteSysNotes && orig) window.WriteSysNotes.showNotesForSentence = orig;
        return {
          captured,
          fragText,
          mapText: R.sentenceMap[id],
          selected: frags.map((f) => f.classList.contains('selected')),
          selId: R.currentSelectedSentenceId,
        };
      }, split.id);
      check('R24: click captured exactly one notes call', r24.captured.length === 1);
      const cap = r24.captured[0] || {};
      check('R24: notes got the FULL sentenceMap text (not fragment textContent)',
        cap.text === r24.mapText && r24.mapText !== r24.fragText,
        `map ${String(r24.mapText).length} ch vs fragment ${String(r24.fragText).length} ch`);
      check('R24: all fragments get .selected; currentSelectedSentenceId set',
        r24.selected.every(Boolean) && r24.selId === split.id);
    }

    // ---- R17: anchor restore ----------------------------------------------
    const anchorId = await page.evaluate(() => {
      const R = window.WriteSysRenderer;
      // A sentence from the middle of the manuscript that exists in the DOM.
      const ids = R.currentSentences.map((s) => s.id);
      for (let i = Math.floor(ids.length / 2); i < ids.length; i++) {
        const el = document.querySelector(`.sentence[data-sentence-id="${CSS.escape(ids[i])}"]`);
        if (el && el.textContent.trim().length > 30) return ids[i];
      }
      return ids[0];
    });
    await page.evaluate((id) => {
      document.querySelector(`.sentence[data-sentence-id="${CSS.escape(id)}"]`)
        .scrollIntoView({ block: 'center' });
    }, anchorId);
    const yBefore = await page.evaluate((id) =>
      document.querySelector(`.sentence[data-sentence-id="${CSS.escape(id)}"]`)
        .getBoundingClientRect().top, anchorId);
    await page.evaluate((id) =>
      window.WriteSysRenderer.renderManuscript({ anchorSentenceId: id }), anchorId);
    const yAfter = await page.evaluate((id) =>
      document.querySelector(`.sentence[data-sentence-id="${CSS.escape(id)}"]`)
        .getBoundingClientRect().top, anchorId);
    check('R17: anchor viewport y restored after re-render (±1.5px)',
      Math.abs(yAfter - yBefore) <= 1.5, `before ${yBefore.toFixed(1)} after ${yAfter.toFixed(1)}`);

    // Scroll DURING pagination: the offset is re-captured at swap time, so
    // the restore honors the user's mid-pagination scroll.
    await page.evaluate((id) => {
      window.__renderP = window.WriteSysRenderer.renderManuscript({ anchorSentenceId: id });
    }, anchorId);
    await page.evaluate(() => window.scrollBy(0, 300));
    const yMid = await page.evaluate((id) => {
      const el = document.querySelector(`.sentence[data-sentence-id="${CSS.escape(id)}"]`);
      return el ? el.getBoundingClientRect().top : null;
    }, anchorId);
    await page.evaluate(() => window.__renderP);
    const yFinal = await page.evaluate((id) =>
      document.querySelector(`.sentence[data-sentence-id="${CSS.escape(id)}"]`)
        .getBoundingClientRect().top, anchorId);
    check('R17: scroll during pagination still restores (swap-time re-capture, ±2.5px)',
      yMid !== null && Math.abs(yFinal - yMid) <= 2.5,
      `at-scroll ${yMid && yMid.toFixed(1)} final ${yFinal.toFixed(1)}`);

    // ---- R18: selectSentenceId + page info ---------------------------------
    // The fixture is markdown-only (no &chapter), so the outline is empty;
    // a SUGGESTED &chapter must appear in the nav (buildOutline over
    // effective fragments) and get page info once the preview resolves.
    const r18id = await page.evaluate(() => {
      const R = window.WriteSysRenderer;
      const spans = [...document.querySelectorAll('.pagedjs_pages .sentence[data-sentence-id]')];
      const seen = {};
      spans.forEach((s) => { seen[s.dataset.sentenceId] = (seen[s.dataset.sentenceId] || 0) + 1; });
      const el = spans.find((s) => s.textContent.trim().length > 40
        && !s.textContent.trim().startsWith('#') && seen[s.dataset.sentenceId] === 1);
      return el && el.dataset.sentenceId;
    });
    const st18 = await putSuggestion(r18id, '&chapter{Test Chapter}{e2e}');
    check('R18: chapter suggestion PUT accepted', st18 === 200 || st18 === 204, `status ${st18}`);
    await reloadSuggestionsAndRender({ selectSentenceId: r18id });
    const r18 = await page.evaluate((id) => ({
      selected: [...document.querySelectorAll(`.pagedjs_pages .sentence[data-sentence-id="${CSS.escape(id)}"]`)]
        .map((el) => el.classList.contains('selected')),
      chapterInNav: !!document.querySelector('.outline-chapter'),
      pageInfo: (() => {
        const el = document.querySelector('.outline-chapter .outline-pageinfo');
        return el ? el.textContent.trim() : null;
      })(),
    }), r18id);
    check('R18: .selected applied to the sentence after render',
      r18.selected.length > 0 && r18.selected.every(Boolean));
    check('R18: suggested chapter shows in outline with page info after preview resolves',
      r18.chapterInNav && !!r18.pageInfo && /\d/.test(r18.pageInfo), `pageinfo="${r18.pageInfo}"`);

    // ---- R27: inline reference delegated click -----------------------------
    // Suggested anchor early + suggested reference late; slugMap is rebuilt
    // from effective fragments so the link resolves.
    const pair = await page.evaluate(() => {
      const R = window.WriteSysRenderer;
      const ids = R.currentSentences.map((s) => s.id);
      const prose = (id) => {
        const t = R.sentenceMap[id] || '';
        return t.trim().length > 40 && !t.trim().startsWith('#') && !t.includes('&');
      };
      const early = ids.slice(2, 30).find(prose);
      const late = ids.slice(Math.floor(ids.length * 0.7)).find(prose);
      return { early, late, earlyText: R.sentenceMap[early], lateText: R.sentenceMap[late] };
    });
    await putSuggestion(pair.early, `&anchor#e2ereftarget{E2E ref target}\n${pair.earlyText.replace(/^(\n\n|\n\t)/, '')}`);
    await putSuggestion(pair.late, pair.lateText + ' &reference#e2ereftarget{see the target}');
    await reloadSuggestionsAndRender();
    const refState = await page.evaluate(() => {
      const a = document.querySelector('.pagedjs_pages a.inline-ref[data-ref-target]');
      return a ? { target: a.dataset.refTarget, text: a.textContent } : null;
    });
    check('R27: suggested &reference resolves to a live link (slugMap)',
      !!refState && refState.target === pair.early, refState && refState.target);
    if (refState) {
      await page.evaluate(() => {
        document.querySelector('.pagedjs_pages a.inline-ref[data-ref-target]')
          .scrollIntoView({ block: 'center' });
      });
      await page.locator('.pagedjs_pages a.inline-ref[data-ref-target]').first().click();
      // Flash is applied synchronously on click (and auto-removed after
      // 1.2s); the smooth scroll across many pages takes longer — assert the
      // two separately.
      await page.waitForFunction((id) => {
        const el = document.querySelector(`.sentence[data-sentence-id="${CSS.escape(id)}"]`);
        return el && el.classList.contains('flash-highlight');
      }, pair.early, { timeout: 3000 });
      await page.waitForFunction((id) => {
        const el = document.querySelector(`.sentence[data-sentence-id="${CSS.escape(id)}"]`);
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.top > -100 && r.top < window.innerHeight;
      }, pair.early, { timeout: 20000 });
      check('R27: click flashes + scrolls to the anchor sentence', true);
      // Survives a re-render (listener is delegated on document).
      await page.evaluate(() => window.WriteSysRenderer.renderManuscript());
      await page.waitForFunction((id) => {
        const el = document.querySelector(`.sentence[data-sentence-id="${CSS.escape(id)}"]`);
        return el && !el.classList.contains('flash-highlight');
      }, pair.early, { timeout: 5000 });
      await page.evaluate(() => {
        document.querySelector('.pagedjs_pages a.inline-ref[data-ref-target]')
          .scrollIntoView({ block: 'center' });
      });
      await page.locator('.pagedjs_pages a.inline-ref[data-ref-target]').first().click();
      await page.waitForFunction((id) => {
        const el = document.querySelector(`.sentence[data-sentence-id="${CSS.escape(id)}"]`);
        return el && el.classList.contains('flash-highlight');
      }, pair.early, { timeout: 10000 });
      check('R27: reference click still works after an in-place re-render', true);
    }

    // Clean the suggestions out before the remaining scenarios — IN PLACE
    // (refetch the now-empty suggestion set and re-render): the outline
    // empties without a page reload now that outline.render resets its
    // cached nodes on the non-empty → empty transition (asserted in
    // test-render-pending-fixes.js). This exercises the fixed path.
    psql(`DELETE FROM suggested_change WHERE user_id='${TEST_USERNAME}'`);
    await reloadSuggestionsAndRender();
    check('in-place re-render after clearing suggestions empties the outline',
      await page.evaluate(() => document.querySelectorAll('.outline-item').length === 0));

    // R25 (render reentrancy: overlapping calls coalesce to one tree) is
    // asserted in test-render-pending-fixes.js.

    // ---- R20: responsive scaling math -------------------------------------
    await page.setViewportSize({ width: 500, height: 800 });
    await page.waitForFunction(() => {
      const el = document.querySelector('.pagedjs_pages');
      return el && el.style.transform.includes('scale');
    }, null, { timeout: 5000 });
    const r20 = await page.evaluate(() => {
      const el = document.querySelector('.pagedjs_pages');
      const m = el.style.transform.match(/scale\(([\d.]+)\)/);
      const scale = m ? parseFloat(m[1]) : null;
      const rectH = el.getBoundingClientRect().height; // = naturalH * scale
      return {
        scale,
        expectedScale: Math.min(1, (window.innerWidth - 24) / 576),
        marginLeft: el.style.marginLeft,
        marginBottom: parseFloat(el.style.marginBottom),
        expectedMarginBottom: -((rectH / scale) * (1 - scale)),
        origin: el.style.transformOrigin,
        bodyBg: document.body.style.background,
      };
    });
    check('R20: mobile scale = (vw − 24) / 576',
      r20.scale !== null && Math.abs(r20.scale - r20.expectedScale) < 0.001,
      `scale=${r20.scale} expected=${r20.expectedScale.toFixed(4)}`);
    check('R20: negative margin-bottom equals the height the scale removed (±2px)',
      Math.abs(r20.marginBottom - r20.expectedMarginBottom) <= 2,
      `got ${r20.marginBottom.toFixed(1)} expected ${r20.expectedMarginBottom.toFixed(1)}`);
    check('R20: origin top left, gutter margin-left 12px, body backdrop painted',
      (r20.origin === 'top left' || r20.origin === 'left top')
      && r20.marginLeft === '12px' && r20.bodyBg !== '',
      `origin="${r20.origin}" ml="${r20.marginLeft}" bg="${r20.bodyBg}"`);
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.waitForFunction(() => {
      const el = document.querySelector('.pagedjs_pages');
      return el && el.style.transform === '';
    }, null, { timeout: 5000 });
    const r20d = await page.evaluate(() => {
      const el = document.querySelector('.pagedjs_pages');
      return {
        transform: el.style.transform, marginBottom: el.style.marginBottom,
        marginLeft: el.style.marginLeft, padding: el.style.padding,
        bodyBg: document.body.style.background,
      };
    });
    check('R20: desktop clears transform/margins, restores 2em padding',
      r20d.transform === '' && r20d.marginBottom === '' && r20d.marginLeft === ''
      && r20d.padding === '2em' && r20d.bodyBg === '');

    // ---- R21: migration-poll banner ---------------------------------------
    const curMig = await page.evaluate(() => window.WriteSysRenderer.currentMigrationID);
    const msId = await page.evaluate(() => window.WriteSysRenderer.manuscriptId);
    // (a) transient poll failure tolerated: no banner, poll keeps running.
    let failOnce = true;
    await page.route('**/api/migrations/latest*', async (route) => {
      if (failOnce) { failOnce = false; return route.abort(); }
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          migration_id: curMig + 100000, manuscript_id: msId,
          commit_hash: 'feedfacefeedfacefeedfacefeedfacefeedface',
          segmenter: 'segman-2.6.0', processed_at: new Date().toISOString(),
        }),
      });
    });
    await page.evaluate(() => window.WriteSysRenderer.checkForNewerMigration());
    const afterTransient = await page.evaluate(() => ({
      banner: !!document.getElementById('stale-migration-banner'),
      pollAlive: !!window.WriteSysRenderer._migrationPollTimer,
    }));
    check('R21: transient poll error tolerated (no banner, poll still armed)',
      !afterTransient.banner && afterTransient.pollAlive);
    // (b) newer migration → banner once, poll cleared.
    await page.evaluate(() => window.WriteSysRenderer.checkForNewerMigration());
    await page.waitForSelector('#stale-migration-banner', { timeout: 5000 });
    await page.evaluate(() => window.WriteSysRenderer.checkForNewerMigration());
    const r21 = await page.evaluate(() => ({
      banners: document.querySelectorAll('#stale-migration-banner, .stale-migration-banner').length,
      pollCleared: !window.WriteSysRenderer._migrationPollTimer,
      text: document.querySelector('.stale-migration-text').textContent,
    }));
    check('R21: banner shown exactly once', r21.banners === 1, `count=${r21.banners}`);
    check('R21: poll interval cleared once the banner is up', r21.pollCleared);
    check('R21: banner names the newer commit', r21.text.includes('feedfac'), r21.text.slice(0, 60));
    // (c) Reload button reloads the page (unroute first so the reload loads
    // real data again).
    await page.unroute('**/api/migrations/latest*');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
      page.click('.stale-migration-reload'),
    ]);
    await waitForPagination(page);
    const afterReload = await page.evaluate(() => ({
      banner: !!document.getElementById('stale-migration-banner'),
      mig: window.WriteSysRenderer.currentMigrationID,
    }));
    check('R21: Reload button reloads; banner gone; real migration restored',
      !afterReload.banner && afterReload.mig === curMig, `mig=${afterReload.mig}`);

  } catch (e) {
    console.log(`❌ Test errored: ${e.message}`);
    failed = true;
  } finally {
    psql(`DELETE FROM suggested_change WHERE user_id='${TEST_USERNAME}'`);
    await browser.close();
  }

  console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('Test crashed:', e); process.exit(1); });
