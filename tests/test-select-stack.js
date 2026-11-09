// Selection stack + suggest-edit modal (2026-11-09):
//   - a SINGLE selected sentence (plain click) gets the gutter stack too —
//     copy + trash; a shift-click range keeps copy / sketch / trash. The ✓
//     (batch accept) is gone:
//   - the trash's two clicks are the confirmation — a reviewer's deletions
//     are ACCEPTED on the spot (single sentence or range);
//   - after a range, a click on its first sentence just SELECTS it (the
//     renderer's hidden single-selection used to read it as a re-click and
//     open suggest-edit at once);
//   - clicking the modal's formatted view lands the mono caret on the
//     clicked character (markup, glyphs and struck diff text skipped);
//   - ✓ closes a modal you opened on its sentence; on a ‹ › tour it stays.
const pw = require('playwright');
const engine = pw[process.env.PW_ENGINE || 'chromium']; // PW_ENGINE=firefox for the caret's other implementation
const { execSync } = require('child_process');
const { TEST_URL, TEST_USERNAME, loginAsTestUser, waitForPagination } = require('./test-utils');
const psql = (sql) => execSync(`PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`, { encoding: 'utf8' }).trim();

(async () => {
  let failed = false;
  const check = (n, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) failed = true; };
  const clean = () => psql(`DELETE FROM suggested_change WHERE user_id='${TEST_USERNAME}'`);
  clean();
  const browser = await engine.launch({ headless: true, ...(process.env.PW_EXECUTABLE ? { executablePath: process.env.PW_EXECUTABLE } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    const dialogs = [];
    page.on('dialog', (d) => { dialogs.push(d.message()); d.accept().catch(() => {}); });
    await loginAsTestUser(page);
    await page.goto(TEST_URL);
    await waitForPagination(page);
    // Seven consecutive plain-prose sentences of one paragraph.
    const ids = await page.evaluate(() => {
      const R = window.WriteSysRenderer;
      const spans = [...document.querySelectorAll('.pagedjs_pages p .sentence[data-sentence-id]')];
      const plain = (id) => /^[A-Za-z][^&{*_\n]*[.?!]$/.test((R.sentenceMap[id] || '').trim()) && (R.sentenceMap[id] || '').trim().split(/\s+/).length > 5;
      for (let i = 0; i + 6 < spans.length; i++) {
        const run = spans.slice(i, i + 7);
        const sids = run.map((s) => s.dataset.sentenceId);
        if (new Set(run.map((s) => s.closest('p'))).size === 1 && new Set(sids).size === 7 && sids.every(plain)) return sids;
      }
      return [];
    });
    check('found seven plain sentences in one paragraph', ids.length === 7, JSON.stringify(ids));
    // A sentence's click target: its first LINE box (a wrapped span's
    // bounding-box center can fall between its lines, on the paragraph).
    const S = (id) => ({
      click: async (o) => {
        const pt = await page.evaluate((id) => {
          const e = document.querySelector(`.pagedjs_pages .sentence[data-sentence-id="${id}"]`);
          e.scrollIntoView({ block: 'center' });
          const r = e.getClientRects()[0];
          return { x: r.left + Math.min(8, r.width / 2), y: r.top + r.height / 2 };
        }, id);
        const shift = o && o.modifiers && o.modifiers.includes('Shift');
        if (shift) await page.keyboard.down('Shift');
        await page.mouse.click(pt.x, pt.y);
        if (shift) await page.keyboard.up('Shift');
      },
    });
    // A re-render paints the new pages before removing the old: settled =
    // one set of pages again.
    const settled = async (id) => {
      await page.waitForFunction((id) => document.querySelectorAll('.pagedjs_pages').length === 1
        && (!id || document.querySelector(`.pagedjs_pages .sentence.suggested-delete[data-sentence-id="${id}"]`)), id, { timeout: 15000 });
      await waitForPagination(page);
    };
    const status = (id) => psql(`SELECT coalesce(review_status, 'pending') || ':' || text FROM suggested_change WHERE user_id='${TEST_USERNAME}' AND sentence_id='${id}'`);
    const stack = () => page.evaluate(() => {
      const st = document.querySelector('.range-stack');
      if (!st) return null;
      const sheet = document.querySelector('.pagedjs_sheet') || document.querySelector('.pagedjs_page');
      return { buttons: [...st.querySelectorAll('.range-trash')].map((b) => b.className.replace('range-trash ', '').split(' ')[0]),
        offSheet: st.getBoundingClientRect().right <= sheet.getBoundingClientRect().left };
    });
    const modalOpen = () => page.evaluate(() => !!document.getElementById('suggestion-modal'));
    const unselect = () => page.evaluate(() => {
      window.WriteSysRenderer.currentSelectedSentenceId = null;
      document.querySelectorAll('.sentence.selected').forEach((e) => e.classList.remove('selected'));
      window.WriteSysRangeDelete.exit();
    });

    // ---- Single selection: copy + trash ----
    await unselect();
    await S(ids[0]).click();
    let st = await stack();
    check('a single click shows the stack: copy + trash (no sketch, no ✓)', st && st.buttons.join(',') === 'range-copy,range-del' && st.offSheet, JSON.stringify(st));
    await S(ids[0]).click();
    await page.waitForSelector('#suggestion-modal');
    check('…a second click still opens suggest-edit, and the stack goes', !(await stack()));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('suggestion-modal'));
    await unselect();
    await S(ids[1]).click();
    await page.click('.range-trash.range-del');
    await page.click('.range-trash.range-del');
    await page.waitForFunction(() => !document.querySelector('.range-stack'));
    await settled(ids[1]);
    check('single-sentence Delete (two clicks) deletes AND accepts', status(ids[1]) === 'accepted:', status(ids[1]));

    // ---- Range: copy / sketch / trash; Delete accepts all ----
    await unselect();
    await S(ids[2]).click();
    await S(ids[4]).click({ modifiers: ['Shift'] });
    st = await stack();
    check('a range keeps copy / sketch / trash — no ✓', st && st.buttons.join(',') === 'range-copy,range-sketch,range-del', JSON.stringify(st));
    await page.click('.range-trash.range-del');
    await page.click('.range-trash.range-del');
    await page.waitForFunction(() => !document.querySelector('.range-stack'));
    await settled(ids[4]); // the re-render follows the accepts
    const rangeStatus = [ids[2], ids[3], ids[4]].map(status);
    check('range Delete accepts every deletion', rangeStatus.every((s) => s === 'accepted:'), JSON.stringify(rangeStatus) + ' ' + dialogs.join(' | '));

    // ---- After the range, its first sentence just selects ----
    await S(ids[2]).click();
    await page.waitForTimeout(300); // a modal opens synchronously on click — give it a frame anyway
    const sel = await page.evaluate((id) => ({ modal: !!document.getElementById('suggestion-modal'),
      selected: !!document.querySelector(`.sentence.selected[data-sentence-id="${id}"]`) }), ids[2]);
    check('one click on a deleted sentence (the range\'s first) highlights it — no modal', !sel.modal && sel.selected, JSON.stringify(sel));
    check('…with its single-selection stack', JSON.stringify((await stack() || {}).buttons) === '["range-copy","range-del"]');
    await S(ids[2]).click();
    await page.waitForSelector('#suggestion-modal');
    check('…and a second click opens suggest-edit', await modalOpen());
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('suggestion-modal'));

    // ---- Caret lands where the formatted view was clicked ----
    // clickChar: click the LEFT quarter of the k-th occurrence of `needle`'s
    // first character inside the left formatted pane (a shadow tree).
    const clickAt = async (needle) => {
      const pt = await page.evaluate((needle) => {
        const host = document.querySelector('#suggestion-modal .sgm-fmt-left');
        const root = host.shadowRoot || host;
        const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let t = w.nextNode(); t; t = w.nextNode()) {
          if (t.parentElement.closest('del')) continue;
          const i = t.data.indexOf(needle);
          if (i < 0) continue;
          const r = document.createRange();
          r.setStart(t, i); r.setEnd(t, i + 1);
          const b = r.getBoundingClientRect();
          return { x: b.left + b.width * 0.25, y: b.top + b.height / 2 };
        }
        return null;
      }, needle);
      if (!pt) return false;
      await page.mouse.click(pt.x, pt.y);
      await page.waitForSelector('#suggestion-modal .suggestion-modal-textarea', { state: 'visible' });
      return true;
    };
    const caret = () => page.evaluate(() => {
      const ta = document.querySelector('#suggestion-modal .suggestion-modal-textarea');
      return { at: ta.selectionStart, end: ta.selectionEnd, focused: document.activeElement === ta, value: ta.value };
    });
    // Plain view (no edit yet).
    const plainText = await page.evaluate((id) => window.WriteSysRenderer.sentenceMap[id], ids[5]);
    const words = plainText.trim().split(/\s+/);
    const target = words[Math.floor(words.length / 2)]; // a word mid-sentence
    await unselect();
    await S(ids[5]).click();
    await S(ids[5]).click();
    await page.waitForSelector('#suggestion-modal .sgm-fmt-left');
    check('plain view: clicked a mid-sentence word', await clickAt(target), target);
    let c = await caret();
    check('…the caret lands right before it in the raw text', c.focused && c.at === c.end && c.at === c.value.indexOf(target), `at ${c.at}, want ${c.value.indexOf(target)}`);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('suggestion-modal'));
    // Diff view: an edit that drops the first word (struck text in the view,
    // not in the raw) and prepends italics (markup in the raw, not the view).
    const editText = `*Lo* and behold, ${words.slice(1).join(' ')}`;
    await page.evaluate(async ({ id, text }) => {
      const Sg = window.WriteSysSuggestions, R = window.WriteSysRenderer;
      await Sg.putSuggestion(id, text);
      await Sg.loadForMigration(R.currentMigrationID);
      await R.renderManuscript({ anchorSentenceId: id });
    }, { id: ids[5], text: editText });
    await settled();
    await unselect();
    await S(ids[5]).click();
    await S(ids[5]).click();
    await page.waitForSelector('#suggestion-modal .sgm-fmt-left');
    const hasDel = await page.evaluate(() => {
      const host = document.querySelector('#suggestion-modal .sgm-fmt-left');
      return !!(host.shadowRoot || host).querySelector('del');
    });
    check('diff view: struck old text present', hasDel);
    check('…clicked the same word', await clickAt(target), target);
    c = await caret();
    check('…the caret maps past the italics markup and the struck word', c.at === c.end && c.at === editText.indexOf(target), `at ${c.at}, want ${editText.indexOf(target)}`);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('suggestion-modal'));

    // ---- ✓ closes a modal opened on its sentence; a tour keeps it ----
    await unselect();
    await S(ids[5]).click();
    await S(ids[5]).click();
    await page.waitForSelector('#suggestion-modal .sgm-accept');
    await page.click('#suggestion-modal .sgm-accept');
    await page.waitForFunction(() => !document.getElementById('suggestion-modal'), null, { timeout: 5000 }).catch(() => {});
    check('✓ on the sentence you opened accepts and closes the modal', !(await modalOpen()) && status(ids[5]).startsWith('accepted:'), status(ids[5]));
    // A second edit to tour onto.
    await page.evaluate(async (id) => {
      const Sg = window.WriteSysSuggestions, R = window.WriteSysRenderer;
      await Sg.putSuggestion(id, R.sentenceMap[id] + ' Toured.');
      await Sg.loadForMigration(R.currentMigrationID);
      await R.renderManuscript({ anchorSentenceId: id });
    }, ids[6]);
    await settled();
    await unselect();
    await S(ids[5]).click();
    await S(ids[5]).click();
    await page.waitForSelector('#suggestion-modal');
    await page.click('#suggestion-modal .pw-nav-next');
    // The tour lands on ids[6] — the next edit after ids[5].
    const onSix = await page.waitForFunction((id) => {
      const R = window.WriteSysRenderer;
      const ta = document.querySelector('#suggestion-modal .suggestion-modal-textarea');
      return !!ta && ta.value === R.sentenceMap[id] + ' Toured.';
    }, ids[6], { timeout: 5000 }).then(() => true, () => false);
    check('› tours to the next edit', onSix);
    await page.click('#suggestion-modal .sgm-accept');
    for (let i = 0; i < 40 && !status(ids[6]).startsWith('accepted:'); i++) await page.waitForTimeout(100);
    await page.waitForTimeout(300); // a close would follow the accept within a frame
    check('✓ on a toured edit accepts but keeps the modal open', (await modalOpen()) && status(ids[6]).startsWith('accepted:'), status(ids[6]));
    await page.keyboard.press('Escape');
    await page.close();
  } catch (e) {
    check('run', false, e.message);
  } finally {
    clean();
    await browser.close();
  }
  console.log(failed ? '\n❌ failures' : '\n✅ all passed');
  process.exit(failed ? 1 : 0);
})();
