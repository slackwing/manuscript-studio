/**
 * Scratchpad editor CORE (HOME_PLAN.md): the embeddable component. The old
 * scratchpad page died; the singleton modal (modal.mjs) is the only host.
 *
 * ProseMirror (vendored bundle — scripts/vendor-prosemirror.sh) drives the
 * SCRATCHPAD surface only. Sketch content is NEVER edited with PM — since
 * VARIATIONS_PLAN.md a sketch node is a PLACEMENT marker {variationId};
 * the text lives in the variation tables and is edited in a monospace
 * textarea, previewed through the real book pipeline (scratch-render.js →
 * renderer.js in a shadow root with book.css).
 *
 * SPLIT (CODE_REVIEW_AUG_2026.md §1): this file is now the ASSEMBLY/entry
 * module — createScratchpadEditor, toolbar assembly, keymap/plugins — over
 * cohesive sibling modules (schema.mjs, api.mjs, scroll.mjs, sketch-view.mjs,
 * pad-notes.mjs, menus.mjs). It re-exports everything the outside world
 * (modal.mjs, tests) consumes, so import sites are unchanged. Cross-module
 * imports are pinned (?v=N) — the URL including the query is the module-
 * instance key, so bump a sibling's pin in ALL importers together. The
 * vendored prosemirror.mjs import stays relative and unpinned everywhere so
 * instanceof checks share one instance.
 */
import {
  Node as PMNode, Plugin,
  EditorState, NodeSelection, TextSelection, Selection,
  EditorView,
  keymap, history, undo, redo,
  baseKeymap, toggleMark, setBlockType, chainCommands,
  wrapInList, splitListItem, liftListItem, sinkListItem,
  dropCursor, gapCursor,
  tableEditing, columnResizing, goToNextCell,
  addRowAfter, deleteRow, addColumnAfter, deleteColumn, deleteTable,
} from './vendor/prosemirror.mjs';
import { schema, modernizeDoc } from './schema.mjs?v=1';
import { csrf, bookData, variationApi, uploadImage } from './api.mjs?v=1';
import { scrollDiag } from './scroll.mjs?v=1';
import {
  SketchView, variationFlushers, dirtyVariations, refreshSketchSiblings,
} from './sketch-view.mjs?v=3';
import {
  NoteRefView, buildNoteColorBar, noteColorGroups, noteCache, closeNoteFloat,
  setActiveView, getActiveView, setEditorTearingDown,
} from './pad-notes.mjs?v=1';
import {
  insertBlockSafely, markActive, headingActive, inTable, inBlockquote,
  toggleBlockquote, buildTablePicker, buildSketchMenu,
} from './menus.mjs?v=1';

// Re-exports: the one public surface (modal.mjs and the unit tests import
// ONLY from this module; the sibling modules are an internal layout).
export { schema, modernizeDoc } from './schema.mjs?v=1';
export { apiCall, bookData, variationApi, setCurrentScratchpadId } from './api.mjs?v=1';
export { suspendScrollHolds } from './scroll.mjs?v=1';
export { letterOf, parseVariationRef } from './sketch-view.mjs?v=3';
export { findNormalized } from './pad-notes.mjs?v=1';
export { fmtDeleted, insertBlockSafely } from './menus.mjs?v=1';

// ---------------------------------------------------------------- helpers

// Breathing-room rule (ONE implementation — the edit-time plugin and the
// open-time pass both use it): every WIDGET (sketch) must be followed by a
// non-widget block. Two consecutive widgets left nowhere to click a caret
// between them (the gap cursor is undiscoverable). With `atOpen`, ALSO
// require the doc to end with a paragraph (docs saved before the plugin
// existed can end in a table/image — the plugin only runs on edits).
// Returns the positions (ascending) where an empty paragraph must go.
function breathingRoomInserts(doc, sc, atOpen) {
  const inserts = [];
  doc.forEach((node, offset, index) => {
    if (node.type !== sc.nodes.snippet) return;
    const next = doc.maybeChild(index + 1);
    if (!next || next.type === sc.nodes.snippet) inserts.push(offset + node.nodeSize);
  });
  if (atOpen && (!doc.lastChild || doc.lastChild.type !== sc.nodes.paragraph)) {
    if (!inserts.includes(doc.content.size)) inserts.push(doc.content.size);
  }
  return inserts;
}

// SVG toolbar glyphs (text labels read as buttons, not tools).
const ICON_UL = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="2.5" cy="3.5" r="1.4"/><circle cx="2.5" cy="8" r="1.4"/><circle cx="2.5" cy="12.5" r="1.4"/><rect x="6" y="2.7" width="9" height="1.6" rx="0.8"/><rect x="6" y="7.2" width="9" height="1.6" rx="0.8"/><rect x="6" y="11.7" width="9" height="1.6" rx="0.8"/></svg>';
const ICON_OL = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><text x="0" y="5.4" font-size="5.4" font-family="Helvetica,Arial,sans-serif">1.</text><text x="0" y="10.4" font-size="5.4" font-family="Helvetica,Arial,sans-serif">2.</text><text x="0" y="15.4" font-size="5.4" font-family="Helvetica,Arial,sans-serif">3.</text><rect x="6" y="2.7" width="9" height="1.6" rx="0.8"/><rect x="6" y="7.2" width="9" height="1.6" rx="0.8"/><rect x="6" y="11.7" width="9" height="1.6" rx="0.8"/></svg>';

// ----------------------------------------------------------- the instance

/**
 * createScratchpadEditor(els, scratchpadId): loads the pad, mounts PM, and
 * returns the instance. els = {titleInput, statusEl, toolbarEl, editorEl,
 * imageInput}. destroy() flushes any unsaved changes (doc AND variations).
 */
export async function createScratchpadEditor(els, scratchpadId) {
  const data = await fetchJSON(`api/scratchpads/${scratchpadId}`, {}, false);
  const pad = data.scratchpad;
  els.titleInput.value = pad.title;
  // Fresh per editor instance (the modal can open/close repeatedly).
  noteColorGroups.length = 0;
  // The note cache too: a note recolored BETWEEN pad opens (landing grid,
  // another surface) must render its fresh color on reopen — a stale cache
  // survived modal cycles and pinned the old color (notecache-staleness).
  noteCache.clear();
  closeNoteFloat();

  let view = null;
  let destroyed = false;

  // ---- doc autosave: the SHARED autosaver (edit-pane.js createAutosaver;
  // DRY.md item 3). ONE save machine for the doc and every variation
  // textarea: same debounce/flush/dirty discipline, same retry ladder
  // (2s → 60s cap, attempt cap 6, live countdown), same 401 re-login link —
  // and, crucially, the in-flight CHASE: keystrokes typed while a PUT is in
  // flight leave the saver dirty and trigger a follow-up save, instead of
  // being masked by the stale PUT resolving (the old hand-rolled copy's
  // data-loss bug). The saved "value" is the exact PUT body (title + doc
  // JSON), so title edits and doc edits share one dirty comparison.
  let docSaver = null; // created below, after the open-time normalization
  const docValue = () => JSON.stringify({ title: els.titleInput.value, doc: view.state.doc.toJSON() });
  // Status vocabulary: this surface says Saved / Saving… / Unsaved where the
  // shared pane says '' / 'saving…'. Failure lines ("Failed to save. Trying
  // again in Ns", plus the 401 re-login link appended to statusEl) pass
  // through verbatim — the two machines already agreed on those.
  const docStatus = (text) => {
    els.statusEl.textContent =
      text === '' ? (docSaver && docSaver.isDirty() ? 'Unsaved' : 'Saved')
        : text === 'saving…' ? 'Saving…'
          : text;
  };

  // Flush any widget textareas with unsaved variation text.
  const flushVariations = async () => {
    const results = await Promise.all([...variationFlushers].map(f => f().catch(() => false)));
    return results.every(Boolean);
  };

  // The close-guard flush: variations flush FIRST, then the doc PUT; false if
  // ANY widget flush failed OR the doc save failed — the modal refuses to
  // close on false, so a dead server never eats work.
  const saveNow = async () => {
    if (!view) return false;
    const variationsOk = await flushVariations();
    const docOk = docSaver ? await docSaver.flush() : true;
    return variationsOk && docOk;
  };

  // ---- toolbar ----
  // show: called on every state change; the button hides when false
  // (the table-ops group only exists while the cursor is in a table).
  const showInTable = s => inTable(s);
  const items = [
    { label: 'B', title: 'Bold (Ctrl-B)', run: toggleMark(schema.marks.strong), active: s => markActive(s, schema.marks.strong) },
    { label: 'I', title: 'Italic (Ctrl-I)', cls: 'i', run: toggleMark(schema.marks.em), active: s => markActive(s, schema.marks.em) },
    { sep: true },
    ...[1, 2, 3, 4].map(l => ({
      label: 'H' + l, title: `Heading ${l} (Ctrl+Alt+${l})`,
      // TOGGLE: clicking the active heading reverts to a paragraph
      // (plain setBlockType is a no-op on an already-set heading — the
      // "can't unselect H2" trap).
      run: (s, d) => headingActive(s, l)
        ? setBlockType(schema.nodes.paragraph)(s, d)
        : setBlockType(schema.nodes.heading, { level: l })(s, d),
      active: s => headingActive(s, l),
    })),
    { html: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="12" rx="1.5"/><path d="M1.5 6h13M5 1v3M11 1v3"/></svg>',
      title: 'Insert today\u2019s date as a heading (Alt+D)', run: (s, d) => insertDate(s, d) },
    { sep: true },
    { html: ICON_UL, title: 'Bullet list (Ctrl+Shift+8)', run: wrapInList(schema.nodes.bullet_list) },
    { html: ICON_OL, title: 'Numbered list (Ctrl+Shift+7)', run: wrapInList(schema.nodes.ordered_list) },
    { sep: true },
    { label: '❝', title: 'Blockquote (Ctrl+Shift+9)', run: toggleBlockquote, active: inBlockquote },
    { label: '—', title: 'Horizontal rule', run: (s, d) => insertBlockSafely(s, d, schema.nodes.horizontal_rule.create()) },
    { sep: true },
    { table: true },
    { label: 'Image', title: 'Insert image', run: () => { els.imageInput.click(); return true; } },
    { sketchMenu: true },
    { sep: true, show: showInTable },
    { label: '+ Row', title: 'Add row below', run: addRowAfter, show: showInTable },
    { label: '− Row', title: 'Delete row', run: deleteRow, show: showInTable },
    { label: '+ Col', title: 'Add column right', run: addColumnAfter, show: showInTable },
    { label: '− Col', title: 'Delete column', run: deleteColumn, show: showInTable },
    { label: '✕ Table', title: 'Delete table', run: deleteTable, show: showInTable },
    { sep: true },
    { label: '↶', title: 'Undo (Ctrl+Z)', run: undo },
    { label: '↷', title: 'Redo (Ctrl+Y)', run: redo },
    // Right-aligned note-color section (NOTES_PLAN.md Phase 2): 6 colored squares
    // that create a note from the current selection.
    { noteColors: true },
  ];
  els.toolbarEl.innerHTML = '';
  const btns = [];
  const dyn = []; // anything with a show() — buttons and separators alike
  for (const it of items) {
    if (it.table) {
      buildTablePicker(els.toolbarEl, () => view);
      continue;
    }
    if (it.sketchMenu) {
      buildSketchMenu(els.toolbarEl, () => view);
      continue;
    }
    if (it.noteColors) {
      buildNoteColorBar(els.toolbarEl, () => view);
      continue;
    }
    if (it.sep) {
      const sep = document.createElement('span');
      sep.className = 'tb-sep';
      els.toolbarEl.appendChild(sep);
      if (it.show) { sep._item = it; dyn.push(sep); }
      continue;
    }
    const b = document.createElement('button');
    b.type = 'button';
    if (it.html) b.innerHTML = it.html; else b.textContent = it.label;
    b.title = it.title;
    if (it.cls) b.classList.add(it.cls);
    b.addEventListener('mousedown', (e) => {
      e.preventDefault();
      it.run(view.state, view.dispatch, view);
      view.focus();
    });
    b._item = it;
    els.toolbarEl.appendChild(b);
    btns.push(b);
    if (it.show) dyn.push(b);
  }
  const updateToolbar = () => {
    btns.forEach(b => {
      if (b._item.active) b.classList.toggle('active', b._item.active(view.state));
    });
    dyn.forEach(el => el.classList.toggle('tb-hidden', !el._item.show(view.state)));
    // Note-color squares are disabled when there's no selection to note.
    noteColorGroups.forEach(g => g.classList.toggle('sn-note-colorbar-disabled', view.state.selection.empty));
  };

  // ---- editor ----
  // Alt+D: type today's date ("Saturday, August 1") at the cursor.
  const insertDate = (state, dispatch) => {
    // Today's date as an H2 block at the caret — "Tuesday, August 25".
    if (dispatch) {
      insertBlockSafely(state, dispatch, schema.nodes.heading.create({ level: 2 },
        schema.text(window.WriteSysEditPane.dateString())));
    }
    return true;
  };
  const li = schema.nodes.list_item;
  const state = EditorState.create({
    doc: PMNode.fromJSON(schema, modernizeDoc(pad.doc)),
    plugins: [
      history(),
      keymap({
        'Mod-z': undo, 'Mod-y': redo, 'Shift-Mod-z': redo,
        'Mod-b': toggleMark(schema.marks.strong),
        'Mod-i': toggleMark(schema.marks.em),
        'Alt-d': insertDate,
        // Headings: Ctrl+Alt+1..4 (the Docs standard; plain Alt+N is the
        // browser's tab switcher in Firefox).
        ...Object.fromEntries([1, 2, 3, 4].map((l) => [
          `Mod-Alt-${l}`, (s, d) => headingActive(s, l)
            ? setBlockType(schema.nodes.paragraph)(s, d)
            : setBlockType(schema.nodes.heading, { level: l })(s, d),
        ])),
        // Lists + quote: the Docs/Notion conventions.
        'Shift-Mod-7': wrapInList(schema.nodes.ordered_list),
        'Shift-Mod-8': wrapInList(schema.nodes.bullet_list),
        'Shift-Mod-9': toggleBlockquote,
        'Enter': splitListItem(li),
        'Tab': chainCommands(goToNextCell(1), sinkListItem(li)),
        'Shift-Tab': chainCommands(goToNextCell(-1), liftListItem(li)),
      }),
      keymap(baseKeymap),
      dropCursor(),
      gapCursor(),
      columnResizing(),
      tableEditing(),
      // Breathing-room guarantee on every edit — shared rule, see
      // breathingRoomInserts above.
      new Plugin({
        appendTransaction(trs, _old, newState) {
          if (!trs.some(tr => tr.docChanged)) return null;
          const { doc, schema: sc } = newState;
          const inserts = breathingRoomInserts(doc, sc, false);
          if (!inserts.length) return null;
          let tr = newState.tr;
          for (let i = inserts.length - 1; i >= 0; i--) {
            tr = tr.insert(inserts[i], sc.nodes.paragraph.create());
          }
          return tr;
        },
      }),
    ],
  });

  view = new EditorView(els.editorEl, {
    state,
    nodeViews: {
      // keyed by the PM node's LEGACY STORAGE NAME ('snippet' — see the
      // schema def), not the UI term.
      snippet: (node, v, getPos) => new SketchView(node, v, getPos),
      noteRef: (node, v, getPos) => new NoteRefView(node, v, getPos),
    },
    dispatchTransaction(tr) {
      if (destroyed) return;
      const newState = view.state.apply(tr);
      view.updateState(newState);
      // docSaver is null only during the open-time normalization dispatch —
      // that change is not an edit (it's re-derived on every open).
      if (tr.docChanged && docSaver) docSaver.poke();
      updateToolbar();
    },
  });
  setActiveView(view);
  const diagHost = view.dom.closest('.spm-editor');
  if (diagHost) scrollDiag.install(diagHost);
  // Docs SAVED with a trailing sketch/table/image predate the trailing-node
  // plugin (which only runs on edits) — normalize once at open (shared rule,
  // see breathingRoomInserts).
  {
    const inserts0 = breathingRoomInserts(view.state.doc, schema, true);
    if (inserts0.length) {
      let tr0 = view.state.tr;
      inserts0.sort((a, b) => b - a).forEach((pos) => {
        tr0 = tr0.insert(pos, schema.nodes.paragraph.create());
      });
      view.dispatch(tr0);
    }
  }
  updateToolbar();

  // The saver is created AFTER the normalization pass so its baseline is the
  // as-opened (normalized) doc: opening a pad never counts as an edit.
  docSaver = window.WriteSysEditPane.createAutosaver({
    initialValue: docValue(),
    debounceMs: 1200,
    getValue: docValue,
    save: async (body) => {
      const r = await fetch(`api/scratchpads/${scratchpadId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() },
        body,
      });
      if (!r.ok) {
        const err = new Error(String(r.status));
        err.status = r.status;
        throw err;
      }
    },
    statusEl: els.statusEl, // the 401 re-login link appends here
    setStatus: docStatus,
    onDirty: (d) => { if (d) els.statusEl.textContent = 'Unsaved'; },
  });
  els.statusEl.textContent = 'Saved';

  const onTitleInput = () => docSaver.poke();
  els.titleInput.addEventListener('input', onTitleInput);
  // After an in-place re-login (session-guard.js), don't sit out the rest of
  // the retry backoff — flush everything unsaved right away.
  const onSessionRestored = () => {
    if (docSaver.isDirty() || dirtyVariations.size > 0) saveNow();
  };
  document.addEventListener('ms:session-restored', onSessionRestored);
  const onImage = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file || !view) return;
    try {
      const imageId = await uploadImage(file);
      const node = schema.nodes.image.create({ imageId, alt: file.name || '' });
      insertBlockSafely(view.state, view.dispatch, node);
      view.focus();
    } catch (err) {
      alert('Image upload failed: ' + err.message);
    }
  };
  els.imageInput.addEventListener('change', onImage);

  return {
    scratchpadId,
    schema,
    bookData,
    variationApi,
    get view() { return view; },
    saveNow,
    // Programmatic inserts (tests / power use): create server-side, place.
    insertSketch: async () => {
      const ctx = await variationApi.createNew();
      insertBlockSafely(view.state, view.dispatch,
        schema.nodes.snippet.create({ variationId: ctx.variation.variation_id }));
      return ctx;
    },
    // Based-on: mint a new sibling variation (next letter) and place it.
    insertVariationOf: async (sourceId) => {
      const ctx = await variationApi.createFrom(sourceId);
      insertBlockSafely(view.state, view.dispatch,
        schema.nodes.snippet.create({ variationId: ctx.variation.variation_id }));
      // Existing siblings must show the new variation in their tab bar now.
      const sketchId = (ctx.sketch && ctx.sketch.sketch_id)
        || (ctx.variation && ctx.variation.sketch_id);
      await refreshSketchSiblings(sketchId, ctx.variation.variation_id);
      return ctx;
    },
    pm: { Selection, TextSelection, NodeSelection },
    isDirty: () => docSaver.isDirty() || dirtyVariations.size > 0,
    async destroy() {
      await flushVariations(); // best effort; the modal's guard already ran
      destroyed = true;
      els.titleInput.removeEventListener('input', onTitleInput);
      els.imageInput.removeEventListener('change', onImage);
      document.removeEventListener('ms:session-restored', onSessionRestored);
      // Conditional final save, then tear the saver down: a failure here
      // schedules a retry, and destroy() cancels it — at most ONE final
      // attempt, never a post-teardown retry.
      if (docSaver.isDirty()) await docSaver.flush();
      docSaver.destroy();
      closeNoteFloat();
      // Anchor NodeViews destroy() during view.destroy(); don't let that
      // soft-delete the notes (the doc persists them).
      setEditorTearingDown(true);
      if (getActiveView() === view) setActiveView(null);
      view.destroy();
      setEditorTearingDown(false);
      view = null;
    },
  };
}
