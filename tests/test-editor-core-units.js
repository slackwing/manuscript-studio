// Units for the pure parts of web/scratchpad/editor-core.mjs, run inside a
// real browser page (it's an ES module importing vendored ProseMirror, so a
// page is the natural runtime). Covers CODE_REVIEW_AUG_2026.md §1.4:
//   Schema & modernizeDoc — all 6 rows
//   API layer & caches — apicall-error-shape, bookdata-cache-semantics,
//     parse-variation-ref, letterof-fmtdeleted, find-normalized
//   Toolbar/menus — insert-block-node-selection
//
// READ-ONLY against the dev server: no fixture data is touched — network for
// apiCall is stubbed via page.route, bookData's fetchJSON is replaced with a
// counting fake, and everything else is in-memory.
//
// Technique note: since the module split (CODE_REVIEW_AUG_2026.md §1, phase
// 2C-2) editor-core.mjs is the ASSEMBLY module and re-exports the internals
// under test (modernizeDoc, apiCall, parseVariationRef, fmtDeleted,
// findNormalized, insertBlockSafely) from its sibling modules (schema.mjs,
// api.mjs, sketch-view.mjs, pad-notes.mjs, menus.mjs) — so the test imports
// the REAL module URL (same ?v pinned in modal.mjs); the old fetch-and-
// rewrite blob import is gone. The vendor bundle is imported by its plain
// URL, which is exactly what every editor module resolves to, so instanceof
// checks share one ProseMirror instance. If this test fails with missing
// exports, editor-core dropped/renamed a re-export or modal.mjs's pinned ?v
// drifted.
const { chromium } = require('playwright');
const { BASE_URL, loginAsTestUser } = require('./test-utils');

// Keep in lockstep with web/scratchpad/modal.mjs's `./editor-core.mjs?v=N`.
const EDITOR_CORE_V = 73;

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  let failed = 0;
  const check = (n, ok, extra) => {
    console.log(`${ok ? '✓' : '✗'} ${n}${extra ? ` (${extra})` : ''}`);
    if (!ok) failed++;
  };

  await loginAsTestUser(page);

  // apiCall stub endpoints (apiCall builds relative 'api/…' URLs).
  await page.route('**/api/__unit/**', (route) => {
    const url = route.request().url();
    if (url.includes('/err500')) return route.fulfill({ status: 500, body: '  boom  \n' });
    if (url.includes('/errempty')) return route.fulfill({ status: 418, body: '' });
    if (url.includes('/nocontent')) return route.fulfill({ status: 204, body: '' });
    if (url.includes('/okjson')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"a":1,"echo":"' + route.request().method() + '"}' });
    }
    return route.fulfill({ status: 404, body: 'unrouted' });
  });

  // home.html loads icons.js/edit-pane.js as plain scripts — the editor
  // modules call into those window globals at runtime (letterOf, icons), so
  // import from a page where they exist (same load order as modal.mjs).
  await page.goto(`${BASE_URL}/home.html`, { waitUntil: 'domcontentloaded' });

  const pinnedMatches = await page.evaluate(async (v) => {
    const src = await (await fetch('scratchpad/modal.mjs?unit-probe=1')).text();
    const m = /editor-core\.mjs\?v=(\d+)/.exec(src);
    return m ? parseInt(m[1], 10) === v : false;
  }, EDITOR_CORE_V);
  check(`modal.mjs pins editor-core.mjs?v=${EDITOR_CORE_V} (test in lockstep)`, pinnedMatches);

  const setup = await page.evaluate(async (v) => {
    const vendorURL = new URL('scratchpad/vendor/prosemirror.mjs', document.baseURI).href;
    try {
      window.__ec = await import(new URL(`scratchpad/editor-core.mjs?v=${v}`, document.baseURI).href);
      window.__pm = await import(vendorURL);
    } catch (e) {
      return String(e);
    }
    const missing = ['schema', 'letterOf', 'bookData', 'modernizeDoc', 'apiCall', 'parseVariationRef',
      'fmtDeleted', 'findNormalized', 'insertBlockSafely'].filter((k) => !window.__ec[k]);
    return missing.length ? `missing exports: ${missing.join(',')}` : 'ok';
  }, EDITOR_CORE_V);
  check('editor-core module imports with internals exposed', setup === 'ok', setup);
  if (setup !== 'ok') { await browser.close(); process.exit(1); }

  const results = await page.evaluate(async () => {
    const r = [];
    const t = (name, ok, detail) => r.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
    const { schema, letterOf, bookData, modernizeDoc, apiCall, parseVariationRef,
      fmtDeleted, findNormalized, insertBlockSafely } = window.__ec;
    const { Node: PMNode, EditorState, NodeSelection, TextSelection } = window.__pm;
    const loads = (json) => { const n = PMNode.fromJSON(schema, json); n.check(); return n; };
    const typesIn = (json) => {
      const set = new Set();
      (function walk(n) { if (!n) return; set.add(n.type); (n.content || []).forEach(walk); }(json));
      return set;
    };
    // Deep equality up to object-key ORDER (toJSON emits e.g. marks before
    // text; the VALUES must be identical).
    const deepEq = (a, b) => {
      if (a === b) return true;
      if (Array.isArray(a) || Array.isArray(b)) {
        return Array.isArray(a) && Array.isArray(b) && a.length === b.length
          && a.every((x, i) => deepEq(x, b[i]));
      }
      if (a && b && typeof a === 'object' && typeof b === 'object') {
        const ka = Object.keys(a).sort(); const kb = Object.keys(b).sort();
        return ka.length === kb.length && ka.every((k, i) => k === kb[i] && deepEq(a[k], b[k]));
      }
      return false;
    };

    // ---- modernize-idless-snippet-drop (editor-core:191–192) --------------
    {
      const out = modernizeDoc({
        type: 'doc',
        content: [
          { type: 'book_content' },
          { type: 'snippet' },                            // no attrs at all
          { type: 'snippet', attrs: { variationId: 0 } }, // idless
          { type: 'snippet', attrs: { variationId: 5 } }, // keep
          { type: 'blockquote', content: [{ type: 'book_content' }, { type: 'paragraph' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'prose' }] },
        ],
      });
      const kinds = out.content.map((n) => n.type);
      t('modernize: book_content and idless snippets dropped (nested too)',
        kinds.join(',') === 'snippet,blockquote,paragraph'
          && out.content[1].content.length === 1,
        kinds.join(','));
      t('modernize: snippet with a real variationId survives',
        out.content[0].attrs.variationId === 5);
      try { loads(out); t('modernize: result is schema-valid', true); }
      catch (e) { t('modernize: result is schema-valid', false, e.message); }
    }

    // ---- modernize-orphan-highlight (:179–182, :175) ----------------------
    {
      const out = modernizeDoc({
        type: 'doc',
        content: [
          { type: 'paragraph', content: [
            { type: 'text', text: 'orphan', marks: [{ type: 'noteHighlight', attrs: { noteId: 3, color: 'red' } }] },
            { type: 'text', text: ' bold', marks: [{ type: 'noteHighlight', attrs: { noteId: 3 } }, { type: 'strong' }] },
          ] },
          { type: 'paragraph', content: [
            { type: 'noteAnchor', attrs: { noteId: 0, color: 'green' } },
            { type: 'text', text: 'the run', marks: [{ type: 'noteHighlight', attrs: { noteId: 0 } }] },
          ] },
        ],
      });
      const p1 = out.content[0].content;
      t('orphan highlight: mark stripped, text kept',
        p1[0].text === 'orphan' && !(p1[0].marks || []).length, JSON.stringify(p1[0]));
      t('orphan highlight: OTHER marks on the same node survive',
        p1[1].marks && p1[1].marks.length === 1 && p1[1].marks[0].type === 'strong', JSON.stringify(p1[1].marks));
      const p2 = out.content[1].content;
      t('anchor with noteId 0: folded to PLAIN text (no noteRef)',
        p2.length === 1 && p2[0].type === 'text' && p2[0].text === 'the run' && !(p2[0].marks || []).length,
        JSON.stringify(p2));
      try { loads(out); t('orphan highlight: result is schema-valid', true); }
      catch (e) { t('orphan highlight: result is schema-valid', false, e.message); }
    }

    // ---- modernize-multi-note-run (:157–187) ------------------------------
    {
      const out = modernizeDoc({
        type: 'doc',
        content: [
          { type: 'paragraph', content: [
            { type: 'text', text: 'Before ' },
            { type: 'noteAnchor', attrs: { noteId: 9, color: 'blue' } },
            { type: 'text', text: 'one', marks: [{ type: 'noteHighlight', attrs: { noteId: 9 } }] },
            { type: 'text', text: ' two', marks: [{ type: 'noteHighlight', attrs: { noteId: 9 } }] },
            { type: 'text', text: ' three', marks: [{ type: 'noteHighlight', attrs: { noteId: 9 } }] },
            { type: 'text', text: ' after.' },
          ] },
          { type: 'blockquote', content: [
            { type: 'paragraph', content: [
              { type: 'noteAnchor', attrs: { noteId: 11 } },
              { type: 'text', text: 'quoted note', marks: [{ type: 'noteHighlight', attrs: { noteId: 11 } }] },
            ] },
          ] },
          { type: 'bullet_list', content: [
            { type: 'list_item', content: [
              { type: 'paragraph', content: [
                { type: 'noteAnchor', attrs: { noteId: 12 } },
                { type: 'text', text: 'listed note', marks: [{ type: 'noteHighlight', attrs: { noteId: 12 } }] },
              ] },
            ] },
          ] },
        ],
      });
      const p = out.content[0].content;
      t('multi-note run: anchor + highlighted run fold to ONE noteRef',
        p.length === 3 && p[1].type === 'noteRef', p.map((n) => n.type).join(','));
      t('multi-note run: noteRef carries id + concatenated text',
        p[1].attrs.noteId === 9 && p[1].attrs.text === 'one two three', JSON.stringify(p[1].attrs));
      t('multi-note run: surrounding text intact',
        p[0].text === 'Before ' && p[2].text === ' after.');
      const quoted = out.content[1].content[0].content;
      t('multi-note run: recurses into blockquote',
        quoted.length === 1 && quoted[0].type === 'noteRef' && quoted[0].attrs.noteId === 11,
        JSON.stringify(quoted));
      const listed = out.content[2].content[0].content[0].content;
      t('multi-note run: recurses into list items',
        listed.length === 1 && listed[0].type === 'noteRef' && listed[0].attrs.noteId === 12,
        JSON.stringify(listed));
      try { loads(out); t('multi-note run: result is schema-valid', true); }
      catch (e) { t('multi-note run: result is schema-valid', false, e.message); }
    }

    // ---- modernize-empty-root (:204) --------------------------------------
    {
      const skeleton = (x) => JSON.stringify(modernizeDoc(x)) === '{"type":"doc","content":[{"type":"paragraph"}]}';
      t('empty root: null → fallback doc-with-paragraph skeleton', skeleton(null));
      t('empty root: undefined → skeleton', skeleton(undefined));
      t('empty root: non-object garbage → skeleton', skeleton('garbage') && skeleton(42));
      try { loads(modernizeDoc(null)); t('empty root: skeleton is schema-valid', true); }
      catch (e) { t('empty root: skeleton is schema-valid', false, e.message); }
    }

    // ---- schema-roundtrip (:46–145) — every node + mark type --------------
    {
      const cell = (type, text) => ({ type, attrs: { colspan: 1, rowspan: 1, colwidth: null },
        content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
      const doc = {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [
            { type: 'text', text: 'plain ' },
            { type: 'text', text: 'bold', marks: [{ type: 'strong' }] },
            { type: 'text', text: ' both', marks: [{ type: 'strong' }, { type: 'em' }] },
            { type: 'hard_break' },
            { type: 'text', text: 'after break ' },
            { type: 'noteRef', attrs: { noteId: 7, text: 'noted run' } },
          ] },
          { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'H2' }] },
          { type: 'heading', attrs: { level: 4 }, content: [{ type: 'text', text: 'H4' }] },
          { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'quoted' }] }] },
          { type: 'horizontal_rule' },
          { type: 'image', attrs: { imageId: 'abc123', alt: 'pic' } },
          { type: 'snippet', attrs: { variationId: 42 } },
          { type: 'bullet_list', content: [
            { type: 'list_item', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'item' }] }] },
          ] },
          { type: 'ordered_list', attrs: { order: 1 }, content: [
            { type: 'list_item', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] },
          ] },
          { type: 'table', content: [
            { type: 'table_row', content: [cell('table_header', 'h'), cell('table_cell', 'c')] },
          ] },
        ],
      };
      try {
        const node = loads(doc);
        const json = node.toJSON();
        t('roundtrip: JSON→PMNode→toJSON is the identity (up to key order)',
          deepEq(json, doc));
        const again = PMNode.fromJSON(schema, json);
        t('roundtrip: second pass stable and node-equal', again.eq(node)
          && JSON.stringify(again.toJSON()) === JSON.stringify(json));
        const seen = typesIn(json);
        const want = ['paragraph', 'heading', 'blockquote', 'horizontal_rule', 'image', 'snippet',
          'noteRef', 'text', 'hard_break', 'bullet_list', 'ordered_list', 'list_item',
          'table', 'table_row', 'table_cell', 'table_header'];
        t('roundtrip: every schema node type exercised',
          want.every((w) => seen.has(w)), want.filter((w) => !seen.has(w)).join(','));
        t('roundtrip: both marks exercised', JSON.stringify(json).includes('"strong"')
          && JSON.stringify(json).includes('"em"'));
      } catch (e) {
        t('roundtrip: JSON→PMNode→toJSON is the identity', false, e.message);
      }
    }

    // ---- noteref-todom-persistence (:116–120) -----------------------------
    {
      const n = schema.nodes.noteRef.create({ noteId: 12, text: 'kept text' });
      const spec = n.type.spec.toDOM(n);
      const attrs = spec[1] || {};
      t('noteRef toDOM: span with data attrs',
        spec[0] === 'span' && attrs['data-note-ref'] === '12' && attrs['data-note-text'] === 'kept text',
        JSON.stringify(attrs));
      t('noteRef toDOM: no color class (color deliberately NOT in the doc)',
        attrs.class === 'sn-note-ref' && !/color/.test(attrs.class), attrs.class);
      t('noteRef toDOM: visible text is the snapshot text', spec[2] === 'kept text');
      // And parseDOM completes the persistence loop (copy/paste form).
      const dom = document.createElement('span');
      dom.setAttribute('data-note-ref', '12');
      dom.setAttribute('data-note-text', 'kept text');
      const parsed = schema.nodes.noteRef.spec.parseDOM[0].getAttrs(dom);
      t('noteRef parseDOM: attrs recovered from the serialized span',
        parsed.noteId === 12 && parsed.text === 'kept text', JSON.stringify(parsed));
    }

    // ---- apicall-error-shape (:233–246) -----------------------------------
    {
      try {
        await apiCall('GET', 'api/__unit/err500');
        t('apiCall: non-ok throws', false, 'resolved');
      } catch (e) {
        t('apiCall: non-ok throws an Error', e instanceof Error);
        t('apiCall: error carries .status', e.status === 500, String(e.status));
        t('apiCall: error message is the trimmed body', e.message === 'boom', JSON.stringify(e.message));
      }
      try {
        await apiCall('GET', 'api/__unit/errempty');
        t('apiCall: empty-body failure throws', false, 'resolved');
      } catch (e) {
        t('apiCall: empty body → message falls back to the status code',
          e.message === '418' && e.status === 418, `${e.status}/${e.message}`);
      }
      t('apiCall: 204 → null', (await apiCall('DELETE', 'api/__unit/nocontent')) === null);
      const ok = await apiCall('POST', 'api/__unit/okjson', { x: 1 });
      t('apiCall: ok → parsed JSON (request method honored)',
        ok && ok.a === 1 && ok.echo === 'POST', JSON.stringify(ok));
    }

    // ---- bookdata-cache-semantics (:211–229) ------------------------------
    // bookData calls the bare global fetchJSON — swap in a counting fake
    // (restored after). This is the real module's cache now (real import, not
    // a blob copy) — but this page never opens a pad, so the app has cached
    // nothing, and the ids used here (901–903) are synthetic.
    {
      const realFetchJSON = window.fetchJSON;
      let latest = 0, manu = 0, sugg = 0;
      let fail902 = true, failSug = false;
      window.fetchJSON = async (url) => {
        if (url.includes('migrations/latest')) {
          latest++;
          if (url.includes('=902') && fail902) { const e = new Error('down'); e.status = 500; throw e; }
          return { migration_id: 55 };
        }
        if (url.includes('/manuscript')) { manu++; return { sentences: [{ id: 's1', text: 'T' }] }; }
        if (url.includes('/suggestions')) {
          sugg++;
          if (failSug) { const e = new Error('sugfail'); e.status = 500; throw e; }
          return { suggestions: [{ sentence_id: 's1', text: 'S' }] };
        }
        throw new Error('unexpected url ' + url);
      };
      try {
        const p1 = bookData.load(901);
        const p2 = bookData.load(901);
        const r1 = await p1; const r2 = await p2;
        t('bookData: concurrent loads share one promise (one fetch)',
          latest === 1 && manu === 1 && r1 === r2, `latest=${latest}`);
        t('bookData: payload carries sentences + sugMap',
          r1.sentences.length === 1 && r1.sugMap.s1 === 'S' && r1.migration.migration_id === 55);
        const r3 = await bookData.load(901);
        t('bookData: cache hit — no refetch', latest === 1 && r3 === r1);
        const r4 = await bookData.load(901, true);
        t('bookData: force → refetch, fresh object', latest === 2 && r4 !== r1);
        let threw = false;
        try { await bookData.load(902); } catch (e) { threw = true; }
        t('bookData: failing load rejects', threw);
        fail902 = false;
        const before = latest;
        const r5 = await bookData.load(902);
        t('bookData: rejection self-evicted — retry actually refetches',
          latest === before + 1 && r5.migration.migration_id === 55, `latest=${latest}`);
        failSug = true;
        const r6 = await bookData.load(903);
        t('bookData: suggestions failure tolerated (empty sugMap, data kept)',
          r6.sentences.length === 1 && Object.keys(r6.sugMap).length === 0, JSON.stringify(r6.sugMap));
      } finally {
        window.fetchJSON = realFetchJSON;
      }
    }

    // ---- parse-variation-ref (:319–323) -----------------------------------
    {
      t('variationRef: plain form parses', parseVariationRef('ms-variation:123') === 123);
      t('variationRef: surrounding whitespace tolerated', parseVariationRef('  ms-variation:45 \n') === 45);
      t('variationRef: missing number rejected', parseVariationRef('ms-variation:') === null);
      t('variationRef: leading junk rejected', parseVariationRef('xms-variation:1') === null);
      t('variationRef: trailing junk rejected',
        parseVariationRef('ms-variation:1x') === null && parseVariationRef('ms-variation:12 34') === null);
      t('variationRef: empty/null → null', parseVariationRef('') === null && parseVariationRef(null) === null);
    }

    // ---- letterof-fmtdeleted (:282–291) -----------------------------------
    {
      t('letterOf: 1 → A, 26 → Z', letterOf(1) === 'A' && letterOf(26) === 'Z');
      t('letterOf: ordinal 0 → ·', letterOf(0) === '·');
      t('letterOf: missing ordinal → ·', letterOf(undefined) === '·' && letterOf(null) === '·');
      t('fmtDeleted: empty → \'\'', fmtDeleted('') === '' && fmtDeleted(null) === '');
      t('fmtDeleted: invalid ISO → \'\'', fmtDeleted('not-a-date') === '');
      const d = fmtDeleted('2026-07-26T12:00:00Z');
      t('fmtDeleted: valid ISO → short "Mon D" local date', /^[A-Z][a-z]{2} \d{1,2}$/.test(d), d);
    }

    // ---- find-normalized (:1352–1387) -------------------------------------
    {
      t('findNormalized: exact text found at its raw offset',
        findNormalized('Hello brave world', 'brave world') === 6);
      const raw = 'She said “It’s *important*” — twice.';
      t('findNormalized: smartquote/markdown/dash cosmetics tolerated',
        findNormalized(raw, "It's important") === raw.indexOf('It'),
        String(findNormalized(raw, "It's important")));
      const rep = 'abc xx abc yy abc';
      t('findNormalized: no hint → first occurrence', findNormalized(rep, 'abc', null) === 0);
      t('findNormalized: hint picks the NEAREST occurrence',
        findNormalized(rep, 'abc', 8) === 7 && findNormalized(rep, 'abc', 15) === 14,
        `${findNormalized(rep, 'abc', 8)},${findNormalized(rep, 'abc', 15)}`);
      t('findNormalized: empty needle → -1', findNormalized('anything', '') === -1);
      t('findNormalized: punctuation-only needle → -1', findNormalized('anything', '—…!') === -1);
      t('findNormalized: not found → -1', findNormalized('short text', 'absent phrase') === -1);
    }

    // ---- insert-block-node-selection (:1315–1324) -------------------------
    {
      const doc = PMNode.fromJSON(schema, {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'before' }] },
          { type: 'snippet', attrs: { variationId: 1 } },
          { type: 'paragraph', content: [{ type: 'text', text: 'after' }] },
        ],
      });
      const snippetPos = 8; // paragraph "before" occupies 0..8
      t('insertBlock: setup — pos 8 is the snippet atom',
        doc.nodeAt(snippetPos) && doc.nodeAt(snippetPos).type.name === 'snippet');

      const run = (node) => {
        const state = EditorState.create({ doc, selection: NodeSelection.create(doc, snippetPos) });
        let out = null;
        const ok = insertBlockSafely(state, (tr) => { out = state.apply(tr); }, node);
        return { ok, doc: out ? out.doc : null };
      };

      const hr = run(schema.nodes.horizontal_rule.create());
      t('insertBlock: hr insert returns true and dispatches', hr.ok && !!hr.doc);
      t('insertBlock: hr lands AFTER the node-selected atom — atom survives',
        hr.doc && hr.doc.childCount === 4
          && hr.doc.child(1).type.name === 'snippet' && hr.doc.child(1).attrs.variationId === 1
          && hr.doc.child(2).type.name === 'horizontal_rule',
        hr.doc && Array.from({ length: hr.doc.childCount }, (_, i) => hr.doc.child(i).type.name).join(','));

      const table = schema.nodes.table.create(null, [
        schema.nodes.table_row.create(null, [
          schema.nodes.table_cell.create(null, schema.nodes.paragraph.create()),
        ]),
      ]);
      const tb = run(table);
      t('insertBlock: table insert also goes AFTER the atom',
        tb.ok && tb.doc && tb.doc.child(1).type.name === 'snippet' && tb.doc.child(2).type.name === 'table',
        tb.doc && Array.from({ length: tb.doc.childCount }, (_, i) => tb.doc.child(i).type.name).join(','));

      // Contrast: a TEXT selection takes the replaceSelectionWith path.
      const tstate = EditorState.create({ doc, selection: TextSelection.create(doc, 4) });
      let tout = null;
      const tok = insertBlockSafely(tstate, (tr) => { tout = tstate.apply(tr); }, schema.nodes.horizontal_rule.create());
      t('insertBlock: text selection uses replaceSelectionWith (hr appears, snippet intact)',
        tok && tout && JSON.stringify(tout.doc.toJSON()).includes('horizontal_rule')
          && JSON.stringify(tout.doc.toJSON()).includes('"snippet"'));

      const nstate = EditorState.create({ doc, selection: NodeSelection.create(doc, snippetPos) });
      let dispatched = false;
      t('insertBlock: null node → false, nothing dispatched',
        insertBlockSafely(nstate, () => { dispatched = true; }, null) === false && !dispatched);
      t('insertBlock: no dispatch fn → true without side effects (command dry-run)',
        insertBlockSafely(nstate, null, schema.nodes.horizontal_rule.create()) === true);
    }

    return r;
  });

  for (const { name, ok, detail } of results) check(name, ok, ok ? '' : detail);

  await browser.close();
  console.log(failed === 0 ? '\n✅ Test passed' : `\n❌ ${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
