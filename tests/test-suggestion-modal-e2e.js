/**
 * Suggestion-modal e2e — CODE_REVIEW_AUG_2026.md AREA 3 §3.4 suggestions
 * table:
 *   S10 modal singleton + version-rail edge (no history → 1..3 disabled)
 *   S11 draft restore (ms-draft-suggest-<id> ≠ server → restored + dirty)
 *   S13 409 copy-out path (one alert, pinned status, close refused)
 *   S14 close flush-or-refuse (failing save blocks close; no-net-change
 *       skips render; net change → scroll_to + optimistic patch + selection
 *       + re-render + push refresh)
 *   S15 Tab inserts literal \t; Shift-Tab escapes the field (extends the
 *       snippet-editor-only Shift-Tab coverage to THIS modal)
 *   S16 mobile (390x844): modal + note stack inside the overlay, textarea
 *       NOT autofocused; desktop autofocuses
 *   S17 apostrophe diff stability (diff-before-smartquotes invariant):
 *       one-word edit near an apostrophe → exactly one <strong>, zero <del>
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

const suggestionCount = (sid) =>
  psql(`SELECT COUNT(*) FROM suggested_change WHERE sentence_id='${sid}' AND user_id='${TEST_USERNAME}'`);

// Poll a condition with short sleeps (condition wait, not a blind timer).
async function until(fn, timeoutMs = 8000, stepMs = 200) {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

(async () => {
  console.log('=== Suggestion modal e2e (S10 S11 S13 S14 S15 S16 S17) ===\n');
  psql(`DELETE FROM suggested_change WHERE user_id='${TEST_USERNAME}'`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  let failed = false;
  const check = (n, ok, extra) => {
    console.log(`${ok ? '✅' : '❌'} ${n}${extra !== undefined ? ' — ' + extra : ''}`);
    if (!ok) failed = true;
  };
  const dialogs = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); d.accept().catch(() => {}); });

  const openModal = async (sid) => {
    await page.evaluate((id) => window.WriteSysSuggestions.openModal(id), sid);
    await page.waitForSelector('#suggestion-modal', { timeout: 5000 });
  };
  const closeAndWaitDetached = async () => {
    await page.locator('.suggestion-modal-textarea').press('Escape');
    await page.waitForSelector('#suggestion-modal', { state: 'detached', timeout: 8000 });
  };

  try {
    // In-page login → csrf in localStorage (authenticatedFetch depends on it).
    await page.goto(`${BASE_URL}/login.html`);
    await page.evaluate(async ([u, p]) => {
      const r = await fetch('api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify({ username: u, password: p }),
      });
      const d = await r.json();
      localStorage.setItem('csrf_token', d.csrf_token);
    }, [TEST_USERNAME, TEST_PASSWORD]);

    await page.goto(TEST_URL);
    await waitForPagination(page);

    // A prose sentence rendered as a SINGLE fragment (so patchSentenceInPlace
    // can succeed in S14).
    const pick = await page.evaluate(() => {
      const R = window.WriteSysRenderer;
      const spans = [...document.querySelectorAll('.pagedjs_pages .sentence[data-sentence-id]')];
      const seen = {};
      spans.forEach((s) => { seen[s.dataset.sentenceId] = (seen[s.dataset.sentenceId] || 0) + 1; });
      const el = spans.find((s) => {
        const t = s.textContent.trim();
        return t.length > 40 && !t.startsWith('#') && seen[s.dataset.sentenceId] === 1;
      });
      return { id: el.dataset.sentenceId, text: R.sentenceMap[el.dataset.sentenceId] };
    });
    check('Picked a single-fragment prose sentence', !!pick.id, pick.id && pick.id.slice(0, 12));

    // ---- S10: singleton + version rail -------------------------------------
    await openModal(pick.id);
    await page.evaluate((id) => window.WriteSysSuggestions.openModal(id), pick.id);
    const s10 = await page.evaluate((sid) => {
      // Mirror the modal's own disable rule so this pins the EDGE (a version
      // is disabled iff its text is null — no record — or identical to the
      // version after it) regardless of how much history the fixture has.
      const original = window.WriteSysRenderer.sentenceMap[sid] || '';
      const he = (window.WriteSysHistory && window.WriteSysHistory.bySentenceId)
        ? window.WriteSysHistory.bySentenceId[sid] : null;
      const hist = (he && he.history) || [];
      const texts = [original];
      for (let k = 1; k <= 3; k++) texts.push(hist[k - 1] ? hist[k - 1].text : null);
      const expected = [{ ver: '0', disabled: false }];
      for (let k = 1; k <= 3; k++) {
        expected.push({ ver: String(k), disabled: texts[k] == null || texts[k] === texts[k - 1] });
      }
      return {
        modals: document.querySelectorAll('#suggestion-modal').length,
        overlays: document.querySelectorAll('#suggestion-modal-overlay').length,
        rail: [...document.querySelectorAll('#suggestion-modal .sn-rail [data-ver]')]
          .map((b) => ({ ver: b.dataset.ver, disabled: b.disabled })),
        expected,
        hasDisabled: expected.some((e) => e.disabled),
        focused: document.activeElement === document.querySelector('.suggestion-modal-textarea'),
      };
    }, pick.id);
    check('S10: second openModal is a no-op (one modal, one overlay)',
      s10.modals === 1 && s10.overlays === 1);
    check('S10: version rail disables exactly the null/identical versions',
      JSON.stringify(s10.rail) === JSON.stringify(s10.expected),
      `rail=${JSON.stringify(s10.rail)} expected=${JSON.stringify(s10.expected)}`);
    check('S10: the edge is exercised (at least one disabled rail button)', s10.hasDisabled);
    check('S16(desktop): textarea autofocused on desktop', s10.focused);
    await closeAndWaitDetached();

    // ---- S11: draft restore ------------------------------------------------
    const draftText = pick.text + ' DRAFT-RESTORED';
    await page.evaluate(([sid, t]) => {
      localStorage.setItem(`ms-draft-suggest-${sid}`, JSON.stringify({ t, at: Date.now() }));
    }, [pick.id, draftText]);
    await openModal(pick.id);
    const s11 = await page.evaluate(() => ({
      value: document.querySelector('.suggestion-modal-textarea').value,
      status: document.querySelector('#suggestion-modal .sn-save').textContent,
    }));
    check('S11: fresh draft ≠ server → textarea restored from draft',
      s11.value === draftText, s11.value.slice(-25));
    check('S11: status announces the restored draft',
      s11.status.includes('restored unsaved draft'), s11.status);
    // Restored draft counts as DIRTY → autosaves without further typing.
    const saved = await until(() => suggestionCount(pick.id) === '1', 8000);
    check('S11: restored draft is dirty → autosaved to the server', saved,
      `count=${suggestionCount(pick.id)}`);
    // Revert to original → server collapses to delete.
    await page.locator('.suggestion-modal-textarea').fill(pick.text);
    await closeAndWaitDetached();
    const reverted = await until(() => suggestionCount(pick.id) === '0', 8000);
    check('S11: reverting to the original collapses the suggestion', reverted);

    // ---- S13: 409 copy-out path -------------------------------------------
    await page.route('**/api/sentences/*/suggestion', (route) => {
      if (route.request().method() === 'PUT') {
        return route.fulfill({ status: 409, contentType: 'application/json', body: '{"error":"stale"}' });
      }
      return route.fallback();
    });
    dialogs.length = 0;
    await openModal(pick.id);
    await page.locator('.suggestion-modal-textarea').fill(pick.text + ' STALE EDIT ONE');
    await page.waitForFunction(() => {
      const el = document.querySelector('#suggestion-modal .sn-save');
      return el && el.textContent.includes('manuscript updated');
    }, null, { timeout: 8000 });
    check('S13: 409 pins the copy-out status (no retry countdown)',
      await page.evaluate(() => document.querySelector('#suggestion-modal .sn-save').textContent
        .includes('manuscript updated — copy your text, then reload')));
    check('S13: exactly one alert for the stale migration', dialogs.length === 1
      && dialogs[0].includes('Copy your text'), JSON.stringify(dialogs));
    // Close must refuse while the edit is unflushed.
    await page.locator('.suggestion-modal-textarea').press('Escape');
    await page.waitForFunction(() => {
      const el = document.querySelector('#suggestion-modal .sn-save');
      return el && el.textContent.includes('manuscript updated');
    }, null, { timeout: 5000 });
    check('S13: Escape while stale-unflushed leaves the modal open',
      await page.evaluate(() => !!document.getElementById('suggestion-modal')));
    // A second failing keystroke must NOT re-alert.
    await page.locator('.suggestion-modal-textarea').fill(pick.text + ' STALE EDIT TWO');
    await page.waitForFunction(() => {
      const el = document.querySelector('#suggestion-modal .sn-save');
      return el && el.textContent.includes('manuscript updated');
    }, null, { timeout: 8000 });
    check('S13: repeated 409s alert only once', dialogs.length === 1, `alerts=${dialogs.length}`);
    // Server recovers → close flushes and succeeds.
    await page.unroute('**/api/sentences/*/suggestion');
    await page.locator('.suggestion-modal-textarea').fill(pick.text); // revert → collapses on save
    await closeAndWaitDetached();
    check('S13: after recovery the close flushes and the modal closes', true);
    await until(() => suggestionCount(pick.id) === '0', 8000);

    // ---- S14: close flush-or-refuse ---------------------------------------
    // (a) failing save blocks close.
    await page.route('**/api/sentences/*/suggestion', (route) => {
      if (route.request().method() === 'PUT') return route.fulfill({ status: 500, body: 'boom' });
      return route.fallback();
    });
    await openModal(pick.id);
    await page.locator('.suggestion-modal-textarea').fill(pick.text + ' BLOCKED CLOSE');
    await page.waitForFunction(() => {
      const el = document.querySelector('#suggestion-modal .sn-save');
      return el && /Failed to save/.test(el.textContent);
    }, null, { timeout: 8000 });
    await page.locator('.suggestion-modal-textarea').press('Escape');
    await page.waitForFunction(() => {
      const el = document.querySelector('#suggestion-modal .sn-save');
      return el && /Failed to save/.test(el.textContent);
    }, null, { timeout: 5000 });
    check('S14: failing save blocks close (retry countdown visible)',
      await page.evaluate(() => !!document.getElementById('suggestion-modal')
        && /Trying again in \d+s/.test(document.querySelector('#suggestion-modal .sn-save').textContent)));
    await page.unroute('**/api/sentences/*/suggestion');
    // Escape now: flush succeeds → closes; a net change happened → re-render.
    const stampA = await paginationStamp(page);
    await closeAndWaitDetached();
    const s14c = await page.evaluate((id) => ({
      scrollTo: new URL(window.location.href).searchParams.get('scroll_to'),
      // The optimistic patch shows the diff BEFORE the authoritative
      // re-paginate completes.
      patched: [...document.querySelectorAll(`.pagedjs_pages .sentence[data-sentence-id="${CSS.escape(id)}"]`)]
        .some((el) => el.classList.contains('has-suggestion') && el.querySelector('strong')),
      selected: [...document.querySelectorAll(`.pagedjs_pages .sentence[data-sentence-id="${CSS.escape(id)}"]`)]
        .some((el) => el.classList.contains('selected')),
    }), pick.id);
    check('S14: net change stamps ?scroll_to=<sentence>', s14c.scrollTo === pick.id, s14c.scrollTo);
    check('S14: optimistic in-place patch shows the diff instantly', s14c.patched);
    check('S14: sentence marked .selected on close', s14c.selected);
    await waitForRepagination(page, stampA);
    const s14d = await page.evaluate((id) => ({
      stillDiffed: [...document.querySelectorAll(`.pagedjs_pages .sentence[data-sentence-id="${CSS.escape(id)}"]`)]
        .some((el) => el.classList.contains('has-suggestion') && el.querySelector('strong')),
      stillSelected: [...document.querySelectorAll(`.pagedjs_pages .sentence[data-sentence-id="${CSS.escape(id)}"]`)]
        .some((el) => el.classList.contains('selected')),
    }), pick.id);
    check('S14: authoritative re-render keeps diff + selection', s14d.stillDiffed && s14d.stillSelected);
    // (b) no-net-change close skips the re-render entirely.
    const pushCalls = await page.evaluate(() => {
      window.__pushCalls = 0;
      if (window.WriteSysPush) {
        const orig = window.WriteSysPush.refresh.bind(window.WriteSysPush);
        window.WriteSysPush.refresh = (...a) => { window.__pushCalls += 1; return orig(...a); };
      }
      return true;
    });
    const stampB = await paginationStamp(page);
    await openModal(pick.id); // opens with the saved suggestion — no edits
    await closeAndWaitDetached();
    await new Promise((r) => setTimeout(r, 600)); // give a wrongful re-render a beat to start
    const s14b = await page.evaluate(() => ({
      stamp: document.body.dataset.paginated || '0',
      pushCalls: window.__pushCalls,
    }));
    check('S14: no-net-change close skips the re-render', s14b.stamp === stampB,
      `stamp ${stampB} → ${s14b.stamp}`);
    check('S14: no-net-change close skips the push refresh', s14b.pushCalls === 0);
    // (c) net change refreshes push state.
    await openModal(pick.id);
    await page.locator('.suggestion-modal-textarea').fill(pick.text); // revert = net change back to none
    const stampC = await paginationStamp(page);
    await closeAndWaitDetached();
    await waitForRepagination(page, stampC);
    check('S14: net change triggers the push refresh',
      await page.evaluate(() => window.__pushCalls >= 1),
      `calls=${await page.evaluate(() => window.__pushCalls)}`);
    await until(() => suggestionCount(pick.id) === '0', 8000);

    // ---- S15: Tab inserts \t, Shift-Tab escapes ----------------------------
    await openModal(pick.id);
    const ta = page.locator('.suggestion-modal-textarea');
    await ta.focus();
    await page.evaluate(() => {
      const t = document.querySelector('.suggestion-modal-textarea');
      t.setSelectionRange(t.value.length, t.value.length);
    });
    await ta.press('Tab');
    const s15 = await page.evaluate(() => {
      const t = document.querySelector('.suggestion-modal-textarea');
      return { endsWithTab: t.value.endsWith('\t'), focused: document.activeElement === t };
    });
    check('S15: Tab inserts a literal \\t and keeps focus', s15.endsWithTab && s15.focused);
    await ta.press('Shift+Tab');
    check('S15: Shift-Tab escapes the field (focus leaves the textarea)',
      await page.evaluate(() => document.activeElement !== document.querySelector('.suggestion-modal-textarea')));
    await ta.fill(pick.text); // undo the \t
    await closeAndWaitDetached();
    await until(() => suggestionCount(pick.id) === '0', 8000);

    // ---- S16: mobile stacking, no autofocus --------------------------------
    // A note on the sentence so the mobile stack has content.
    const noteId = await page.evaluate(async (sid) => {
      const r = await fetch('api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': localStorage.getItem('csrf_token') || '' },
        credentials: 'same-origin',
        body: JSON.stringify({ sentence_id: sid, color: 'yellow', body: 'mobile stack note', priority: 'none', flagged: false }),
      });
      const d = await r.json();
      return d.note_id;
    }, pick.id);
    check('S16: created a note on the sentence', !!noteId, `note_id=${noteId}`);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(TEST_URL); // fresh load so currentNotes includes the note
    await waitForPagination(page);
    await openModal(pick.id);
    const s16 = await page.evaluate(() => {
      const overlay = document.getElementById('suggestion-modal-overlay');
      const modal = document.getElementById('suggestion-modal');
      const stack = document.getElementById('sgm-notes-stack');
      const ta2 = document.querySelector('.suggestion-modal-textarea');
      return {
        modalInOverlay: modal.parentElement === overlay,
        stackInOverlay: !!stack && stack.parentElement === overlay,
        stackBelowModal: !!stack && modal.compareDocumentPosition(stack) === Node.DOCUMENT_POSITION_FOLLOWING,
        stackHasNote: !!stack && !!stack.querySelector('.sticky-note'),
        focused: document.activeElement === ta2,
      };
    });
    check('S16: ≤1239px — modal lives INSIDE the overlay', s16.modalInOverlay);
    check('S16: note stack rides in the overlay below the modal',
      s16.stackInOverlay && s16.stackBelowModal && s16.stackHasNote,
      JSON.stringify({ inOverlay: s16.stackInOverlay, below: s16.stackBelowModal, note: s16.stackHasNote }));
    check('S16: textarea NOT autofocused on mobile', !s16.focused);
    await closeAndWaitDetached();
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto(TEST_URL);
    await waitForPagination(page);

    // ---- S17: apostrophe diff stability ------------------------------------
    const apos = await page.evaluate(() => {
      const map = window.WriteSysRenderer.sentenceMap;
      for (const [id, text] of Object.entries(map)) {
        if (text.includes("'") && text.length < 300 && text.split(/\s+/).length > 5
            && !text.trim().startsWith('#')) {
          return { id, text };
        }
      }
      return null;
    });
    check('S17: found a sentence with a straight apostrophe', !!apos,
      apos && apos.text.slice(0, 40));
    if (apos) {
      // Purely additive: append AFTER the final token without rewriting it.
      // Stripping the period made the diff legitimately delete the punctuated
      // final token ("said." → "said EXTRA.") on some fixtures — that's word-
      // diff semantics, not the apostrophe invariant this row pins.
      const aposNew = apos.text.replace(/\s*$/, '') + ' EXTRA';
      await openModal(apos.id);
      await page.locator('.suggestion-modal-textarea').fill(aposNew);
      const stamp17 = await paginationStamp(page);
      await closeAndWaitDetached();
      // Wait for the AUTHORITATIVE re-render — during the optimistic window
      // old and new page trees coexist and the diff would double-count.
      await waitForRepagination(page, stamp17);
      await page.waitForFunction((sid) => {
        const el = document.querySelector(`.sentence[data-sentence-id="${CSS.escape(sid)}"]`);
        return el && el.classList.contains('has-suggestion');
      }, apos.id, { timeout: 20000 });
      const s17 = await page.evaluate((sid) => {
        const els = [...document.querySelectorAll(`.pagedjs_pages .sentence[data-sentence-id="${CSS.escape(sid)}"]`)];
        return {
          delCount: els.reduce((n, el) => n + el.querySelectorAll('del').length, 0),
          strongCount: els.reduce((n, el) => n + el.querySelectorAll('strong').length, 0),
          delText: els.flatMap((el) => [...el.querySelectorAll('del')].map((d) => d.textContent)).join('|'),
          strongText: els.flatMap((el) => [...el.querySelectorAll('strong')].map((d) => d.textContent)).join('|'),
        };
      }, apos.id);
      check('S17: one-word edit → exactly one <strong>', s17.strongCount === 1,
        `strong=${s17.strongCount}: "${s17.strongText}"`);
      check('S17: zero <del> for a purely additive edit',
        s17.delCount === 0, `del=${s17.delCount}: "${s17.delText}"`);
      check('S17: the <strong> is the edit itself', s17.strongText.includes('EXTRA'));
      // The actual smartquotes invariant: no diff fragment ever contains an
      // apostrophe (straight or curled) — i.e. apostrophe-bearing words never
      // enter the diff when they weren't edited.
      check('S17: no diff fragment contains an apostrophe',
        !/['’]/.test(s17.delText) && !/['’]/.test(s17.strongText),
        `del="${s17.delText}" strong="${s17.strongText}"`);
      // Cleanup: revert.
      await openModal(apos.id);
      await page.locator('.suggestion-modal-textarea').fill(apos.text);
      await closeAndWaitDetached();
      await until(() => suggestionCount(apos.id) === '0', 8000);
    }

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
