/**
 * Scratchpad editor (SCRATCHPAD_PLAN.md §6).
 *
 * ProseMirror (vendored single-file bundle — scripts/vendor-prosemirror.sh)
 * drives the SCRATCHPAD surface only: rich text, lists, tables, images, and
 * the book_content atom. Book content itself is NEVER edited with PM — the
 * node's text is plain .manuscript source edited in a monospace textarea
 * (same muscle memory as suggested edits), previewed/lived through the real
 * book render pipeline (scratch-render.js → renderer.js, shadow + book.css).
 */
import {
  Schema, Node as PMNode,
  EditorState, Plugin, NodeSelection, TextSelection, Selection,
  EditorView,
  keymap, history, undo, redo,
  baseKeymap, toggleMark, setBlockType, wrapIn, chainCommands, lift,
  addListNodes, wrapInList, splitListItem, liftListItem, sinkListItem,
  dropCursor, gapCursor,
  tableNodes, tableEditing, goToNextCell,
} from './vendor/prosemirror.mjs';

const csrf = () => sessionStorage.getItem('csrf_token') || '';
const $ = (sel) => document.querySelector(sel);

// ---------------------------------------------------------------- schema

const coreNodes = {
  doc: { content: 'block+' },
  paragraph: {
    group: 'block', content: 'inline*',
    parseDOM: [{ tag: 'p' }],
    toDOM: () => ['p', 0],
  },
  heading: {
    group: 'block', content: 'inline*', defining: true,
    attrs: { level: { default: 1 } },
    parseDOM: [1, 2, 3].map(l => ({ tag: 'h' + l, attrs: { level: l } })),
    toDOM: n => ['h' + n.attrs.level, 0],
  },
  blockquote: {
    group: 'block', content: 'block+',
    parseDOM: [{ tag: 'blockquote' }],
    toDOM: () => ['blockquote', 0],
  },
  horizontal_rule: {
    group: 'block',
    parseDOM: [{ tag: 'hr' }],
    toDOM: () => ['hr'],
  },
  // Scratchpad-only images served from scratchpad_image (never in the book).
  image: {
    group: 'block', atom: true, draggable: true,
    attrs: { imageId: { default: '' }, alt: { default: '' } },
    parseDOM: [{
      tag: 'img[data-image-id]',
      getAttrs: dom => ({ imageId: dom.getAttribute('data-image-id') || '', alt: dom.getAttribute('alt') || '' }),
    }],
    toDOM: n => ['img', {
      'data-image-id': n.attrs.imageId,
      src: 'api/scratchpad-images/' + n.attrs.imageId,
      alt: n.attrs.alt,
      class: 'scratch-image',
    }],
  },
  // The bridge into the book (plan §2/§3). Atom: PM never looks inside; the
  // NodeView owns everything.
  book_content: {
    group: 'block', atom: true, selectable: true,
    attrs: {
      blockId: { default: '' },
      text: { default: '' },
      manuscriptId: { default: 0 },
      refSlug: { default: '' },
      label: { default: '' },
      snapshotText: { default: '' },
      canonizedMigrationId: { default: 0 },
      canonizedAt: { default: '' },
    },
    parseDOM: [{ tag: 'div[data-book-content]', getAttrs: () => ({}) }],
    toDOM: n => ['div', { 'data-book-content': n.attrs.blockId }],
  },
  text: { group: 'inline' },
  hard_break: {
    group: 'inline', inline: true, selectable: false,
    parseDOM: [{ tag: 'br' }],
    toDOM: () => ['br'],
  },
};

const marks = {
  strong: {
    parseDOM: [{ tag: 'strong' }, { tag: 'b' }],
    toDOM: () => ['strong', 0],
  },
  em: {
    parseDOM: [{ tag: 'em' }, { tag: 'i' }],
    toDOM: () => ['em', 0],
  },
};

const base = new Schema({ nodes: coreNodes, marks });
const withLists = addListNodes(base.spec.nodes, 'paragraph block*', 'block');
const withTables = withLists.append(tableNodes({
  tableGroup: 'block',
  cellContent: 'block+',
  cellAttributes: {},
}));
export const schema = new Schema({ nodes: withTables, marks: base.spec.marks });

// ------------------------------------------------- manuscript data cache

// Per-target-manuscript effective data for Live views. One fetch set per
// manuscript per page load; the widget refresh button forces a reload.
const bookData = {
  cache: {},
  async load(manuscriptId, force = false) {
    if (!force && this.cache[manuscriptId]) return this.cache[manuscriptId];
    const p = (async () => {
      const mig = await fetchJSON(`api/migrations/latest?manuscript_id=${manuscriptId}`, {}, false);
      const data = await fetchJSON(`api/migrations/${mig.migration_id}/manuscript`, {}, false);
      let sugMap = {};
      try {
        const sug = await fetchJSON(`api/migrations/${mig.migration_id}/suggestions`, {}, false);
        (sug.suggestions || []).forEach(s => { sugMap[s.sentence_id] = s.text; });
      } catch (e) { /* suggestions are enhancement, not requirement */ }
      return { migration: mig, sentences: data.sentences || [], sugMap };
    })();
    this.cache[manuscriptId] = p;
    p.catch(() => { delete this.cache[manuscriptId]; });
    return p;
  },
};

// ------------------------------------------------------- book_content view

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

class BookContentView {
  constructor(node, view, getPos) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;
    this.dom = document.createElement('div');
    this.dom.className = 'bc-widget';
    this.dom.dataset.blockId = node.attrs.blockId;
    this.mode = node.attrs.refSlug ? 'live' : 'edit';
    this.build();
  }

  canonized() { return !!this.node.attrs.refSlug; }

  build() {
    const a = this.node.attrs;
    const tabs = this.canonized()
      ? [['live', 'Live'], ['snapshot', 'As canonized']]
      : [['edit', 'Edit'], ['preview', 'Preview']];
    const status = this.canonized()
      ? `#${esc(a.refSlug)} → manuscript ${a.manuscriptId}${a.label ? ` · ${esc(a.label)}` : ''}`
      : 'draft';
    this.dom.innerHTML = `
      <div class="bc-header">
        <span class="bc-status${this.canonized() ? ' bc-canonized' : ''}">Book content · ${status}</span>
        <span class="bc-tabs">${tabs.map(([k, l]) =>
          `<button type="button" data-tab="${k}" class="${k === this.mode ? 'active' : ''}">${l}</button>`).join('')}
        </span>
        <span class="bc-actions">
          ${this.canonized()
            ? `<button type="button" data-act="refresh" title="Re-resolve from the manuscript">↻</button>
               <a class="bc-open" href="index.html?manuscript_id=${a.manuscriptId}#${encodeURIComponent(a.refSlug)}" title="Open in book">Open in book ↗</a>`
            : ''}
          <button type="button" data-act="remove" title="Remove block">×</button>
        </span>
      </div>
      <div class="bc-body"></div>`;
    this.body = this.dom.querySelector('.bc-body');
    this.dom.querySelectorAll('[data-tab]').forEach(btn => {
      btn.addEventListener('click', () => this.setMode(btn.dataset.tab));
    });
    this.dom.querySelector('[data-act="remove"]').addEventListener('click', () => this.remove());
    const refresh = this.dom.querySelector('[data-act="refresh"]');
    if (refresh) refresh.addEventListener('click', () => this.renderLive(true));
    this.renderBody();
  }

  setMode(mode) {
    this.mode = mode;
    this.dom.querySelectorAll('[data-tab]').forEach(b =>
      b.classList.toggle('active', b.dataset.tab === mode));
    this.renderBody();
  }

  renderBody() {
    if (this.mode === 'edit') return this.renderEdit();
    if (this.mode === 'preview') return this.renderPreview();
    if (this.mode === 'snapshot') return this.renderSnapshot();
    return this.renderLive(false);
  }

  renderEdit() {
    this.body.innerHTML = '';
    const ta = document.createElement('textarea');
    ta.className = 'bc-text';
    ta.placeholder = 'Book content in .manuscript form — plain text, *italics*, \\n\\n section breaks, commands allowed. Canonize from the book view (+ between paragraphs).';
    ta.value = this.node.attrs.text;
    ta.rows = Math.max(6, this.node.attrs.text.split('\n').length + 2);
    const flush = () => {
      if (ta.value === this.node.attrs.text) return;
      const pos = this.getPos();
      if (pos == null) return;
      this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, null,
        { ...this.node.attrs, text: ta.value }));
    };
    let t;
    ta.addEventListener('input', () => { clearTimeout(t); t = setTimeout(flush, 400); });
    ta.addEventListener('blur', () => { clearTimeout(t); flush(); });
    this.body.appendChild(ta);
    this.ta = ta;
  }

  renderPreview() {
    this.body.innerHTML = '<div class="bc-render"></div>';
    const canon = window.WriteSysCanonicalize ? window.WriteSysCanonicalize.canonicalize : (t) => t;
    window.WriteSysScratchRender.renderText(this.body.firstChild, canon(this.node.attrs.text));
  }

  renderSnapshot() {
    const a = this.node.attrs;
    this.body.innerHTML = `<div class="bc-note">Snapshot as canonized ${esc(a.canonizedAt || '')}</div><div class="bc-render"></div>`;
    const canon = window.WriteSysCanonicalize ? window.WriteSysCanonicalize.canonicalize : (t) => t;
    window.WriteSysScratchRender.renderText(this.body.querySelector('.bc-render'), canon(a.snapshotText));
  }

  async renderLive(force) {
    const a = this.node.attrs;
    this.body.innerHTML = '<div class="bc-note">Resolving from the manuscript…</div><div class="bc-render"></div>';
    const host = this.body.querySelector('.bc-render');
    try {
      const data = await bookData.load(a.manuscriptId, force);
      const canon = window.WriteSysCanonicalize ? window.WriteSysCanonicalize.canonicalize : (t) => t;
      const res = window.WriteSysRegion.resolve(data.sentences, data.sugMap, a.refSlug, window.WriteSysCommand, canon);
      if (res.status !== 'ok') {
        // Strictness (decision 6): broken region → error + snapshot fallback.
        this.body.querySelector('.bc-note').innerHTML =
          `<span class="bc-error">Region #${esc(a.refSlug)} ${res.status === 'missing-anchor'
            ? 'not found in the effective manuscript' : 'has no matching &amp;end'} — showing the snapshot.</span>`;
        window.WriteSysScratchRender.renderText(host, canon(a.snapshotText));
        return;
      }
      this.body.querySelector('.bc-note').textContent =
        `Live from the effective manuscript (committed + your suggestions).`;
      window.WriteSysScratchRender.render(host, res.items);
    } catch (e) {
      this.body.querySelector('.bc-note').innerHTML =
        `<span class="bc-error">Could not load manuscript ${a.manuscriptId} (${esc(e.message)}) — showing the snapshot.</span>`;
      const canon = window.WriteSysCanonicalize ? window.WriteSysCanonicalize.canonicalize : (t) => t;
      window.WriteSysScratchRender.renderText(host, canon(a.snapshotText));
    }
  }

  remove() {
    const pos = this.getPos();
    if (pos == null) return;
    const label = this.canonized()
      ? `Remove this canonized block from the scratchpad? The book region #${this.node.attrs.refSlug} is NOT touched.`
      : 'Remove this draft block? Its text is only saved in scratchpad history.';
    if (!window.confirm(label)) return;
    this.view.dispatch(this.view.state.tr.delete(pos, pos + this.node.nodeSize));
    this.view.focus();
  }

  update(node) {
    if (node.type !== this.node.type) return false;
    const was = this.node.attrs;
    this.node = node;
    if (!!was.refSlug !== !!node.attrs.refSlug) {
      // Draft → canonized: rebuild the whole widget into Live mode.
      this.mode = node.attrs.refSlug ? 'live' : 'edit';
      this.build();
      return true;
    }
    if (this.ta && this.mode === 'edit' && document.activeElement !== this.ta
        && this.ta.value !== node.attrs.text) {
      this.ta.value = node.attrs.text;
    }
    return true;
  }

  stopEvent() { return true; }
  ignoreMutation() { return true; }
}

// ------------------------------------------------------------ image upload

async function uploadImage(file) {
  const fd = new FormData();
  fd.append('image', file, file.name || 'image');
  const r = await fetch('api/scratchpad-images', {
    method: 'POST',
    headers: { 'X-CSRF-Token': csrf() },
    body: fd,
  });
  if (!r.ok) throw new Error(await r.text());
  return (await r.json()).image_id;
}

// ----------------------------------------------------------------- editor

let view = null;
let currentId = null;
let saveTimer = null;
let saveState = 'saved';

function setSaveState(s) {
  saveState = s;
  const el = $('#save-status');
  if (el) el.textContent = s === 'saved' ? 'Saved' : (s === 'saving' ? 'Saving…' : 'Unsaved');
}

async function saveNow() {
  if (!view || currentId == null) return;
  clearTimeout(saveTimer);
  setSaveState('saving');
  try {
    const r = await fetch(`api/scratchpads/${currentId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() },
      body: JSON.stringify({ title: $('#pad-title').value, doc: view.state.doc.toJSON() }),
    });
    if (!r.ok) throw new Error(String(r.status));
    setSaveState('saved');
  } catch (e) {
    console.error('autosave failed', e);
    setSaveState('unsaved');
  }
}

function scheduleSave() {
  setSaveState('unsaved');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 1200);
}

// Insert a block node WITHOUT destroying a node-selected atom: replacing a
// text selection is what the user means, but "replace the widget I happen to
// have selected" never is — insert after it instead.
function insertBlockSafely(state, dispatch, node) {
  if (!node) return false;
  if (dispatch) {
    const tr = (state.selection instanceof NodeSelection)
      ? state.tr.insert(state.selection.to, node)
      : state.tr.replaceSelectionWith(node);
    dispatch(tr.scrollIntoView());
  }
  return true;
}

function cmdInsertBookContent(state, dispatch) {
  return insertBlockSafely(state, dispatch, schema.nodes.book_content.createAndFill({
    blockId: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())),
  }));
}

function cmdInsertTable(state, dispatch) {
  const { table, table_row, table_cell } = schema.nodes;
  const cell = () => table_cell.createAndFill();
  const rows = [0, 1, 2].map(() => table_row.create(null, [cell(), cell(), cell()]));
  return insertBlockSafely(state, dispatch, table.create(null, rows));
}

function markActive(state, type) {
  const { from, $from, to, empty } = state.selection;
  if (empty) return !!type.isInSet(state.storedMarks || $from.marks());
  return state.doc.rangeHasMark(from, to, type);
}

function buildToolbar(container) {
  const items = [
    { label: 'B', title: 'Bold (Ctrl-B)', run: toggleMark(schema.marks.strong), active: s => markActive(s, schema.marks.strong) },
    { label: 'I', title: 'Italic (Ctrl-I)', cls: 'i', run: toggleMark(schema.marks.em), active: s => markActive(s, schema.marks.em) },
    { sep: true },
    { label: '¶', title: 'Paragraph', run: setBlockType(schema.nodes.paragraph) },
    { label: 'H1', title: 'Heading 1', run: setBlockType(schema.nodes.heading, { level: 1 }) },
    { label: 'H2', title: 'Heading 2', run: setBlockType(schema.nodes.heading, { level: 2 }) },
    { sep: true },
    { label: '• List', title: 'Bullet list', run: wrapInList(schema.nodes.bullet_list) },
    { label: '1. List', title: 'Ordered list', run: wrapInList(schema.nodes.ordered_list) },
    { label: '❝', title: 'Blockquote', run: wrapIn(schema.nodes.blockquote) },
    { label: '—', title: 'Horizontal rule', run: (s, d) => insertBlockSafely(s, d, schema.nodes.horizontal_rule.create()) },
    { sep: true },
    { label: 'Table', title: 'Insert 3×3 table', run: cmdInsertTable },
    { label: 'Image', title: 'Insert image', run: () => { $('#image-input').click(); return true; } },
    { label: '⧉ Book content', title: 'Insert a book-content block (monospace .manuscript text; canonize it from the book view)', cls: 'bc-btn', run: cmdInsertBookContent },
    { sep: true },
    { label: '↶', title: 'Undo', run: undo },
    { label: '↷', title: 'Redo', run: redo },
  ];
  container.innerHTML = '';
  const btns = [];
  for (const it of items) {
    if (it.sep) {
      const sep = document.createElement('span');
      sep.className = 'tb-sep';
      container.appendChild(sep);
      continue;
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = it.label;
    b.title = it.title;
    if (it.cls) b.classList.add(it.cls);
    b.addEventListener('mousedown', (e) => {
      e.preventDefault();
      it.run(view.state, view.dispatch, view);
      view.focus();
    });
    b._item = it;
    container.appendChild(b);
    btns.push(b);
  }
  return () => btns.forEach(b => {
    if (b._item.active) b.classList.toggle('active', b._item.active(view.state));
  });
}

function buildEditor(docJSON) {
  const li = schema.nodes.list_item;
  const state = EditorState.create({
    doc: PMNode.fromJSON(schema, docJSON),
    plugins: [
      history(),
      keymap({
        'Mod-z': undo, 'Mod-y': redo, 'Shift-Mod-z': redo,
        'Mod-b': toggleMark(schema.marks.strong),
        'Mod-i': toggleMark(schema.marks.em),
        'Enter': splitListItem(li),
        'Tab': chainCommands(goToNextCell(1), sinkListItem(li)),
        'Shift-Tab': chainCommands(goToNextCell(-1), liftListItem(li)),
      }),
      keymap(baseKeymap),
      dropCursor(),
      gapCursor(),
      tableEditing(),
    ],
  });

  const updateToolbar = buildToolbar($('#toolbar'));

  view = new EditorView($('#editor'), {
    state,
    nodeViews: {
      book_content: (node, v, getPos) => new BookContentView(node, v, getPos),
    },
    dispatchTransaction(tr) {
      const newState = view.state.apply(tr);
      view.updateState(newState);
      if (tr.docChanged) scheduleSave();
      updateToolbar();
    },
  });
  updateToolbar();
  return view;
}

// ------------------------------------------------------------- page shell

async function loadList() {
  const listEl = $('#pad-list');
  const data = await fetchJSON('api/scratchpads', {}, false);
  const pads = data.scratchpads || [];
  listEl.innerHTML = '';
  for (const p of pads) {
    const a = document.createElement('a');
    a.className = 'pad-item' + (p.scratchpad_id === currentId ? ' active' : '');
    a.href = `scratchpad.html?scratchpad_id=${p.scratchpad_id}`;
    const when = new Date(p.updated_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    a.innerHTML = `<span class="pad-item-title">${esc(p.title)}</span><span class="pad-item-when">${when}</span>`;
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'pad-item-del';
    del.title = 'Delete scratchpad';
    del.textContent = '×';
    del.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!window.confirm(`Delete scratchpad "${p.title}"? (Soft-deleted — recoverable from the database.)`)) return;
      await fetch(`api/scratchpads/${p.scratchpad_id}`, { method: 'DELETE', headers: { 'X-CSRF-Token': csrf() } });
      if (p.scratchpad_id === currentId) { window.location.href = 'scratchpad.html'; return; }
      loadList();
    });
    a.appendChild(del);
    listEl.appendChild(a);
  }
  if (pads.length === 0) {
    listEl.innerHTML = '<div class="pad-empty">No scratchpads yet.</div>';
  }
}

async function init() {
  // Session + CSRF bootstrap: sessionStorage is per-tab, so a scratchpad
  // opened in a fresh tab must refill the token from /api/session.
  const session = await checkAuth();
  if (!session) return;
  if (session.csrf_token) sessionStorage.setItem('csrf_token', session.csrf_token);

  $('#new-pad').addEventListener('click', async () => {
    const r = await fetch('api/scratchpads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() },
      body: JSON.stringify({ title: 'Untitled' }),
    });
    if (!r.ok) return;
    const pad = await r.json();
    window.location.href = `scratchpad.html?scratchpad_id=${pad.scratchpad_id}`;
  });

  $('#image-input').addEventListener('change', async (e) => {
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
  });

  const params = new URLSearchParams(window.location.search);
  currentId = params.get('scratchpad_id') ? parseInt(params.get('scratchpad_id'), 10) : null;

  await loadList();

  if (currentId == null) {
    $('#editor-shell').hidden = true;
    $('#empty-state').hidden = false;
    return;
  }

  const data = await fetchJSON(`api/scratchpads/${currentId}`, {}, false);
  const pad = data.scratchpad;
  document.title = `${pad.title} — Scratchpad`;
  $('#pad-title').value = pad.title;
  $('#pad-title').addEventListener('input', scheduleSave);
  buildEditor(pad.doc);

  window.addEventListener('beforeunload', () => {
    if (saveState !== 'saved') saveNow();
  });

  // Test / power-user hook.
  window.WriteSysScratchpad = {
    get view() { return view; },
    schema,
    saveNow,
    insertBookContent: () => { cmdInsertBookContent(view.state, view.dispatch); },
    bookData,
    pm: { Selection, TextSelection, NodeSelection },
  };
}

init().catch(e => {
  console.error('scratchpad init failed', e);
  const el = $('#editor');
  if (el) el.innerHTML = `<p style="color:#b33b3a">Failed to load: ${esc(e.message)}</p>`;
});
