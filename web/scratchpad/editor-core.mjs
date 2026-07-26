/**
 * Scratchpad editor CORE (HOME_PLAN.md): the embeddable component. The old
 * scratchpad page died; the singleton modal (modal.mjs) is the only host.
 *
 * ProseMirror (vendored bundle — scripts/vendor-prosemirror.sh) drives the
 * SCRATCHPAD surface only. Book content is NEVER edited with PM — a
 * snippet node's text is plain .manuscript source in a monospace
 * textarea, previewed/lived through the real book pipeline
 * (scratch-render.js → renderer.js in a shadow root with book.css).
 */
import {
  Schema, Node as PMNode,
  EditorState, NodeSelection, TextSelection, Selection,
  EditorView,
  keymap, history, undo, redo,
  baseKeymap, toggleMark, setBlockType, wrapIn, chainCommands,
  addListNodes, wrapInList, splitListItem, liftListItem, sinkListItem,
  dropCursor, gapCursor,
  tableNodes, tableEditing, columnResizing, goToNextCell,
  addRowAfter, deleteRow, addColumnAfter, deleteColumn, deleteTable,
} from './vendor/prosemirror.mjs';

const csrf = () => sessionStorage.getItem('csrf_token') || '';

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
    parseDOM: [1, 2, 3, 4].map(l => ({ tag: 'h' + l, attrs: { level: l } })),
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
  // The bridge into the book (SCRATCHPAD_PLAN.md §2/§3). Atom: PM never
  // looks inside; the NodeView owns everything. Named "snippet" — docs
  // saved before the rename carry "book_content" and are converted on
  // load (modernizeDoc); the server accepts both names.
  snippet: {
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
      // When the snippet was first created (writing-time provenance).
      // Snippets from before this field get NOW backfilled on load —
      // approximate, but ensures every snippet carries a timestamp.
      createdAt: { default: '' },
      // Optional link pinning this snippet to ONE manuscript: it can only
      // be canonized there, and its draft words count toward that
      // manuscript's wordcount history. 0/'' = unlinked. Canonizing
      // auto-links (stamped server-side).
      linkedManuscriptId: { default: 0 },
      linkedManuscriptName: { default: '' },
    },
    parseDOM: [
      { tag: 'div[data-snippet]', getAttrs: () => ({}) },
      { tag: 'div[data-book-content]', getAttrs: () => ({}) },
    ],
    toDOM: n => ['div', { 'data-snippet': n.attrs.blockId }],
  },
  text: { group: 'inline' },
  hard_break: {
    group: 'inline', inline: true, selectable: false,
    parseDOM: [{ tag: 'br' }],
    toDOM: () => ['br'],
  },
};

const marks = {
  strong: { parseDOM: [{ tag: 'strong' }, { tag: 'b' }], toDOM: () => ['strong', 0] },
  em: { parseDOM: [{ tag: 'em' }, { tag: 'i' }], toDOM: () => ['em', 0] },
};

const base = new Schema({ nodes: coreNodes, marks });
const withLists = addListNodes(base.spec.nodes, 'paragraph block*', 'block');
const withTables = withLists.append(tableNodes({
  tableGroup: 'block',
  cellContent: 'block+',
  cellAttributes: {},
}));
export const schema = new Schema({ nodes: withTables, marks: base.spec.marks });

// Docs saved before the snippet rename store nodes as "book_content".
// Convert in place before Node.fromJSON; the doc self-heals on next save.
function modernizeDoc(json) {
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'book_content') n.type = 'snippet';
    if (n.type === 'snippet' && n.attrs && !n.attrs.createdAt) {
      n.attrs.createdAt = new Date().toISOString();
    }
    (n.content || []).forEach(walk);
  };
  walk(json);
  return json;
}

// ------------------------------------------------- manuscript data cache

// Per-target-manuscript effective data for Live views; module-level so
// several snippets targeting one book share fetches within a page.
export const bookData = {
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

// ----------------------------------------------------------- snippet view

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const LINK_SVG = '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6.2 9.8l3.6-3.6"/><path d="M7.3 4.3l1.4-1.4a2.75 2.75 0 013.9 3.9l-1.4 1.4"/><path d="M8.7 11.7l-1.4 1.4a2.75 2.75 0 01-3.9-3.9l1.4-1.4"/></svg>';

// The user's accessible manuscripts, for the link picker. One fetch per
// page life; failure resets so a retry can succeed.
let manuscriptsPromise = null;
function listManuscripts() {
  if (!manuscriptsPromise) {
    manuscriptsPromise = fetchJSON('api/home', {}, false).then(d =>
      (d.manuscripts || []).map(m => ({ id: m.manuscript_id, name: m.display_name || m.name })));
    manuscriptsPromise.catch(() => { manuscriptsPromise = null; });
  }
  return manuscriptsPromise;
}

const TRASH_SVG = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M6.2 1.5h3.6l.5 1.1H13V4H3V2.6h2.7l.5-1.1zM4.1 5.2h7.8l-.55 8.4c-.06.85-.77 1.5-1.62 1.5H6.27c-.85 0-1.56-.65-1.62-1.5L4.1 5.2zm2.35 1.7l.3 6.3h.9l-.25-6.3h-.95zm3.1 0l-.25 6.3h.9l.3-6.3h-.95z"/></svg>';

class SnippetView {
  constructor(node, view, getPos) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;
    this.dom = document.createElement('div');
    this.dom.className = 'sn-widget';
    this.dom.dataset.blockId = node.attrs.blockId;
    // Preview-first: a snippet always shows its rendered form; a single
    // click on a draft's preview flips it into the monospace editor.
    this.mode = node.attrs.refSlug ? 'live' : 'preview';
    this.build();
  }

  canonized() { return !!this.node.attrs.refSlug; }

  build() {
    const a = this.node.attrs;
    this.dom.classList.toggle('sn-canon', this.canonized());
    const status = this.canonized()
      ? `Manuscript Snippet · Canon · #${esc(a.refSlug)}${a.label ? ` · ${esc(a.label)}` : ''}`
      : 'Manuscript Snippet · draft';
    const created = a.createdAt ? ` Created ${esc(a.createdAt.slice(0, 10))}.` : '';
    const statusHint = (this.canonized()
      ? `This snippet's text was placed into manuscript ${a.manuscriptId} as region #${a.refSlug}. Live follows the book (including your pending suggestions); Snapshot is the text as it was when placed.`
      : 'Draft: plain .manuscript text. Click the preview to edit. From the book view, use + between paragraphs (or a placeholder) to place it into a manuscript.') + created;
    const tabs = this.canonized() ? [['live', 'Live'], ['snapshot', 'Snapshot']] : [];
    // Link affordance, right of the status: unlinked drafts get the link
    // button; linked snippets a chip (draft chips carry the unlink ×; a
    // canonized snippet's link is permanent).
    let linkBit = '';
    if (a.linkedManuscriptId) {
      const unlink = this.canonized() ? ''
        : `<button type="button" class="sn-unlink" title="Unlink from ${esc(a.linkedManuscriptName)}">×</button>`;
      linkBit = `<span class="sn-linkchip" title="Linked to ${esc(a.linkedManuscriptName)} — this snippet can only be canonized into that manuscript.">${LINK_SVG}<span class="sn-linkname">${esc(a.linkedManuscriptName)}</span>${unlink}</span>`;
    } else if (!this.canonized()) {
      linkBit = `<button type="button" class="sn-linkbtn" title="Link to manuscript">${LINK_SVG}</button>`;
    }
    this.dom.innerHTML = `
      <div class="sn-header">
        <span class="sn-status${this.canonized() ? ' sn-canonized' : ''}" title="${statusHint}">${status}</span>${linkBit}
        <span class="sn-tabs">${tabs.map(([k, l]) =>
          `<button type="button" data-tab="${k}" class="${k === this.mode ? 'active' : ''}">${l}</button>`).join('')}
        </span>
        <span class="sn-actions">
          ${this.canonized()
            ? `<button type="button" data-act="refresh" title="Re-resolve from the manuscript">↻</button>
               <a class="sn-open" href="index.html?manuscript_id=${a.manuscriptId}#${encodeURIComponent(a.refSlug)}" title="Open in book">Open in book ↗</a>`
            : ''}
          <button type="button" data-act="remove" class="sn-trash" title="Remove snippet">${TRASH_SVG}</button>
        </span>
      </div>
      <div class="sn-body"></div>`;
    this.body = this.dom.querySelector('.sn-body');
    this.dom.querySelectorAll('[data-tab]').forEach(btn => {
      btn.addEventListener('click', () => this.setMode(btn.dataset.tab));
    });
    this.dom.querySelector('[data-act="remove"]').addEventListener('click', () => this.remove());
    const refresh = this.dom.querySelector('[data-act="refresh"]');
    if (refresh) refresh.addEventListener('click', () => this.renderLive(true));
    const linkBtn = this.dom.querySelector('.sn-linkbtn');
    if (linkBtn) linkBtn.addEventListener('click', () => this.openLinkPicker());
    const unlinkBtn = this.dom.querySelector('.sn-unlink');
    if (unlinkBtn) unlinkBtn.addEventListener('click', () => this.setLink(0, ''));
    this.renderBody();
  }

  setLink(id, name) {
    const pos = this.getPos();
    if (pos == null) return;
    this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, null,
      { ...this.node.attrs, linkedManuscriptId: id, linkedManuscriptName: name }));
  }

  async openLinkPicker() {
    this.closeLinkPicker();
    const pop = document.createElement('div');
    pop.className = 'sn-linkpop';
    pop.innerHTML = `
      <input type="text" class="sn-linkpop-q" placeholder="Search manuscripts…" autocomplete="off">
      <div class="sn-linkpop-list"><span class="sn-linkpop-empty">Loading…</span></div>`;
    this.dom.querySelector('.sn-header').appendChild(pop);
    this.linkPop = pop;
    this._outside = (e) => { if (!pop.contains(e.target)) this.closeLinkPicker(); };
    setTimeout(() => document.addEventListener('mousedown', this._outside, true), 0);
    const q = pop.querySelector('.sn-linkpop-q');
    const list = pop.querySelector('.sn-linkpop-list');
    q.focus();
    let all;
    try {
      all = await listManuscripts();
    } catch (e) {
      list.innerHTML = '<span class="sn-linkpop-empty">Could not load manuscripts</span>';
      return;
    }
    if (!this.linkPop) return; // closed while loading
    const renderList = () => {
      const needle = q.value.trim().toLowerCase();
      const hits = all.filter(m => m.name.toLowerCase().includes(needle));
      list.innerHTML = hits.length
        ? hits.map(m => `<button type="button" data-mid="${m.id}" data-name="${esc(m.name)}">${esc(m.name)}</button>`).join('')
        : '<span class="sn-linkpop-empty">No matches</span>';
    };
    renderList();
    q.addEventListener('input', renderList);
    q.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.closeLinkPicker();
      if (e.key === 'Enter') {
        const first = list.querySelector('button[data-mid]');
        if (first) first.click();
      }
    });
    list.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-mid]');
      if (!b) return;
      this.setLink(parseInt(b.dataset.mid, 10), b.dataset.name);
      this.closeLinkPicker();
    });
  }

  closeLinkPicker() {
    if (this._outside) {
      document.removeEventListener('mousedown', this._outside, true);
      this._outside = null;
    }
    if (this.linkPop) {
      this.linkPop.remove();
      this.linkPop = null;
    }
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
    ta.className = 'sn-text';
    ta.placeholder = 'Snippet in .manuscript form — plain text, *italics*, \\n\\n section breaks, commands allowed. Canonize from the book view (+ between paragraphs).';
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
    ta.addEventListener('blur', () => {
      clearTimeout(t);
      flush();
      // Leaving the editor returns the snippet to its resting preview.
      if (this.mode === 'edit') this.setMode('preview');
    });
    ta.addEventListener('keydown', (e) => { if (e.key === 'Escape') ta.blur(); });
    this.body.appendChild(ta);
    this.ta = ta;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }

  renderPreview() {
    this.ta = null;
    this.body.innerHTML = '<div class="sn-render sn-clickable" title="Click to edit"></div>';
    const host = this.body.firstChild;
    const text = this.node.attrs.text;
    if (text.trim()) {
      const canon = window.WriteSysCanonicalize ? window.WriteSysCanonicalize.canonicalize : (t) => t;
      window.WriteSysScratchRender.renderText(host, canon(text));
    } else {
      host.innerHTML = '<div class="sn-empty">Empty snippet — click to write.</div>';
    }
    host.addEventListener('click', () => { if (!this.canonized()) this.setMode('edit'); });
  }

  renderSnapshot() {
    const a = this.node.attrs;
    this.body.innerHTML = `<div class="sn-note" title="The text as it was at the moment it was placed into the book — kept forever, even as the book moves on.">Snapshot from ${esc((a.canonizedAt || '').slice(0, 10))}</div><div class="sn-render"></div>`;
    const canon = window.WriteSysCanonicalize ? window.WriteSysCanonicalize.canonicalize : (t) => t;
    window.WriteSysScratchRender.renderText(this.body.querySelector('.sn-render'), canon(a.snapshotText));
  }

  async renderLive(force) {
    const a = this.node.attrs;
    this.body.innerHTML = '<div class="sn-note">Resolving from the manuscript…</div><div class="sn-render"></div>';
    const host = this.body.querySelector('.sn-render');
    try {
      const data = await bookData.load(a.manuscriptId, force);
      const canon = window.WriteSysCanonicalize ? window.WriteSysCanonicalize.canonicalize : (t) => t;
      const res = window.WriteSysRegion.resolve(data.sentences, data.sugMap, a.refSlug, window.WriteSysCommand, canon);
      if (res.status !== 'ok') {
        // Strictness (SCRATCHPAD_PLAN decision 6): broken → snapshot fallback.
        this.body.querySelector('.sn-note').innerHTML =
          `<span class="sn-error">Region #${esc(a.refSlug)} ${res.status === 'missing-anchor'
            ? 'not found in the effective manuscript' : 'has no matching &amp;end'} — showing the snapshot.</span>`;
        window.WriteSysScratchRender.renderText(host, canon(a.snapshotText));
        return;
      }
      this.body.querySelector('.sn-note').textContent =
        `Live from the effective manuscript (committed + your suggestions).`;
      window.WriteSysScratchRender.render(host, res.items);
    } catch (e) {
      this.body.querySelector('.sn-note').innerHTML =
        `<span class="sn-error">Could not load manuscript ${a.manuscriptId} (${esc(e.message)}) — showing the snapshot.</span>`;
      const canon = window.WriteSysCanonicalize ? window.WriteSysCanonicalize.canonicalize : (t) => t;
      window.WriteSysScratchRender.renderText(host, canon(a.snapshotText));
    }
  }

  remove() {
    const pos = this.getPos();
    if (pos == null) return;
    const label = this.canonized()
      ? `Remove this canonized snippet from the scratchpad? The book region #${this.node.attrs.refSlug} is NOT touched.`
      : 'Remove this draft snippet? Its text is only saved in scratchpad history.';
    if (!window.confirm(label)) return;
    this.view.dispatch(this.view.state.tr.delete(pos, pos + this.node.nodeSize));
    this.view.focus();
  }

  update(node) {
    if (node.type !== this.node.type) return false;
    const was = this.node.attrs;
    this.node = node;
    if (!!was.refSlug !== !!node.attrs.refSlug) {
      this.mode = node.attrs.refSlug ? 'live' : 'preview';
      this.closeLinkPicker();
      this.build();
      return true;
    }
    if (was.linkedManuscriptId !== node.attrs.linkedManuscriptId
        || was.linkedManuscriptName !== node.attrs.linkedManuscriptName) {
      this.closeLinkPicker();
      this.build();
      return true;
    }
    if (this.mode === 'edit' && this.ta && document.activeElement !== this.ta
        && this.ta.value !== node.attrs.text) {
      this.ta.value = node.attrs.text;
    } else if (this.mode === 'preview' && was.text !== node.attrs.text) {
      this.renderBody();
    }
    return true;
  }

  destroy() { this.closeLinkPicker(); }
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

// ---------------------------------------------------------------- helpers

// Insert a block node WITHOUT destroying a node-selected atom.
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

function cmdInsertSnippet(state, dispatch) {
  return insertBlockSafely(state, dispatch, schema.nodes.snippet.createAndFill({
    blockId: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())),
    createdAt: new Date().toISOString(),
  }));
}

function insertTableOfSize(state, dispatch, rows, cols) {
  const { table, table_row, table_cell } = schema.nodes;
  const mkRow = () => table_row.create(null,
    Array.from({ length: cols }, () => table_cell.createAndFill()));
  return insertBlockSafely(state, dispatch,
    table.create(null, Array.from({ length: rows }, mkRow)));
}

function markActive(state, type) {
  const { from, $from, to, empty } = state.selection;
  if (empty) return !!type.isInSet(state.storedMarks || $from.marks());
  return state.doc.rangeHasMark(from, to, type);
}

function headingActive(state, level) {
  const n = state.selection.$from.parent;
  return n.type === schema.nodes.heading && n.attrs.level === level;
}

// tableNodes stamps tableRole into each node spec — the robust "am I in a
// table?" check, independent of node names.
function inTable(state) {
  const $from = state.selection.$from;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.spec.tableRole === 'table') return true;
  }
  return false;
}

// SVG toolbar glyphs (text labels read as buttons, not tools).
const ICON_UL = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="2.5" cy="3.5" r="1.4"/><circle cx="2.5" cy="8" r="1.4"/><circle cx="2.5" cy="12.5" r="1.4"/><rect x="6" y="2.7" width="9" height="1.6" rx="0.8"/><rect x="6" y="7.2" width="9" height="1.6" rx="0.8"/><rect x="6" y="11.7" width="9" height="1.6" rx="0.8"/></svg>';
const ICON_OL = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><text x="0" y="5.4" font-size="5.4" font-family="Helvetica,Arial,sans-serif">1.</text><text x="0" y="10.4" font-size="5.4" font-family="Helvetica,Arial,sans-serif">2.</text><text x="0" y="15.4" font-size="5.4" font-family="Helvetica,Arial,sans-serif">3.</text><rect x="6" y="2.7" width="9" height="1.6" rx="0.8"/><rect x="6" y="7.2" width="9" height="1.6" rx="0.8"/><rect x="6" y="11.7" width="9" height="1.6" rx="0.8"/></svg>';

// The Word-style rows×cols grid dropdown behind the Table button.
function buildTablePicker(toolbarEl, getView) {
  const MAX = 8;
  const wrap = document.createElement('span');
  wrap.className = 'tb-tablewrap';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.title = 'Insert table';
  btn.textContent = 'Table ▾';
  const pop = document.createElement('div');
  pop.className = 'tb-grid';
  pop.hidden = true;
  const label = document.createElement('div');
  label.className = 'tb-grid-label';
  const cellsHost = document.createElement('div');
  cellsHost.className = 'tb-grid-cells';
  cellsHost.style.gridTemplateColumns = `repeat(${MAX}, 1fr)`;
  const cells = [];
  for (let r = 1; r <= MAX; r++) {
    for (let c = 1; c <= MAX; c++) {
      const cell = document.createElement('span');
      cell.className = 'tb-grid-cell';
      cell.dataset.r = r;
      cell.dataset.c = c;
      cell.addEventListener('mouseenter', () => {
        cells.forEach(el =>
          el.classList.toggle('on', +el.dataset.r <= r && +el.dataset.c <= c));
        label.textContent = `${c} × ${r}`;
      });
      cell.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const view = getView();
        insertTableOfSize(view.state, view.dispatch, r, c);
        close();
        view.focus();
      });
      cellsHost.appendChild(cell);
      cells.push(cell);
    }
  }
  pop.append(label, cellsHost);
  wrap.append(btn, pop);

  const reset = () => {
    cells.forEach(el => el.classList.remove('on'));
    label.textContent = 'Table size';
  };
  reset();
  const onDocDown = (e) => { if (!wrap.contains(e.target)) close(); };
  const close = () => {
    pop.hidden = true;
    document.removeEventListener('mousedown', onDocDown, true);
    reset();
  };
  btn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    if (pop.hidden) {
      pop.hidden = false;
      document.addEventListener('mousedown', onDocDown, true);
    } else {
      close();
    }
  });
  toolbarEl.appendChild(wrap);
}

// ----------------------------------------------------------- the instance

/**
 * createScratchpadEditor(els, scratchpadId): loads the pad, mounts PM, and
 * returns the instance. els = {titleInput, statusEl, toolbarEl, editorEl,
 * imageInput}. destroy() flushes any unsaved changes.
 */
export async function createScratchpadEditor(els, scratchpadId) {
  const data = await fetchJSON(`api/scratchpads/${scratchpadId}`, {}, false);
  const pad = data.scratchpad;
  els.titleInput.value = pad.title;

  let view = null;
  let saveTimer = null;
  let saveState = 'saved';
  let destroyed = false;

  // Failed saves retry on exponential backoff (2s → 60s cap) with a live
  // countdown in the status slot; any success resets the ladder. The modal
  // refuses to close while unsaved (saveNow returns false), so a dead
  // server never eats work.
  let retryTimer = null;
  let countdownTimer = null;
  let retryAttempt = 0;

  const clearRetry = () => {
    clearTimeout(retryTimer); retryTimer = null;
    clearInterval(countdownTimer); countdownTimer = null;
  };

  const setSaveState = (s) => {
    saveState = s;
    els.statusEl.textContent = s === 'saved' ? 'Saved' : (s === 'saving' ? 'Saving…' : 'Unsaved');
  };

  const scheduleRetry = () => {
    clearRetry();
    retryAttempt = Math.min(retryAttempt + 1, 6);
    let secs = Math.min(60, Math.pow(2, retryAttempt)); // 2, 4, 8, …, 60
    const show = () => {
      els.statusEl.textContent = `Failed to save. Trying again in ${secs}s`;
    };
    show();
    countdownTimer = setInterval(() => { secs -= 1; if (secs > 0) show(); }, 1000);
    retryTimer = setTimeout(() => { clearRetry(); saveNow(); }, secs * 1000);
  };

  const saveNow = async () => {
    if (!view) return false;
    clearTimeout(saveTimer);
    clearRetry();
    setSaveState('saving');
    try {
      const r = await fetch(`api/scratchpads/${scratchpadId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() },
        body: JSON.stringify({ title: els.titleInput.value, doc: view.state.doc.toJSON() }),
      });
      if (!r.ok) throw new Error(String(r.status));
      retryAttempt = 0;
      setSaveState('saved');
      return true;
    } catch (e) {
      console.error('autosave failed', e);
      saveState = 'unsaved';
      if (!destroyed) scheduleRetry();
      return false;
    }
  };

  const scheduleSave = () => {
    clearRetry();
    setSaveState('unsaved');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 1200);
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
      label: 'H' + l, title: 'Heading ' + l,
      run: setBlockType(schema.nodes.heading, { level: l }),
      active: s => headingActive(s, l),
    })),
    { sep: true },
    { html: ICON_UL, title: 'Bullet list', run: wrapInList(schema.nodes.bullet_list) },
    { html: ICON_OL, title: 'Numbered list', run: wrapInList(schema.nodes.ordered_list) },
    { sep: true },
    { label: '❝', title: 'Blockquote', run: wrapIn(schema.nodes.blockquote) },
    { label: '—', title: 'Horizontal rule', run: (s, d) => insertBlockSafely(s, d, schema.nodes.horizontal_rule.create()) },
    { sep: true },
    { table: true },
    { label: 'Image', title: 'Insert image', run: () => { els.imageInput.click(); return true; } },
    { label: '⧉ Snippet', title: 'Insert a Manuscript Snippet (monospace .manuscript text; canonize it from the book view)', cls: 'sn-btn', run: cmdInsertSnippet },
    { sep: true, show: showInTable },
    { label: '+ Row', title: 'Add row below', run: addRowAfter, show: showInTable },
    { label: '− Row', title: 'Delete row', run: deleteRow, show: showInTable },
    { label: '+ Col', title: 'Add column right', run: addColumnAfter, show: showInTable },
    { label: '− Col', title: 'Delete column', run: deleteColumn, show: showInTable },
    { label: '✕ Table', title: 'Delete table', run: deleteTable, show: showInTable },
    { sep: true },
    { label: '↶', title: 'Undo', run: undo },
    { label: '↷', title: 'Redo', run: redo },
  ];
  els.toolbarEl.innerHTML = '';
  const btns = [];
  const dyn = []; // anything with a show() — buttons and separators alike
  for (const it of items) {
    if (it.table) {
      buildTablePicker(els.toolbarEl, () => view);
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
  };

  // ---- editor ----
  const li = schema.nodes.list_item;
  const state = EditorState.create({
    doc: PMNode.fromJSON(schema, modernizeDoc(pad.doc)),
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
      columnResizing(),
      tableEditing(),
    ],
  });

  view = new EditorView(els.editorEl, {
    state,
    nodeViews: {
      snippet: (node, v, getPos) => new SnippetView(node, v, getPos),
    },
    dispatchTransaction(tr) {
      if (destroyed) return;
      const newState = view.state.apply(tr);
      view.updateState(newState);
      if (tr.docChanged) scheduleSave();
      updateToolbar();
    },
  });
  updateToolbar();
  setSaveState('saved');

  const onTitleInput = () => scheduleSave();
  els.titleInput.addEventListener('input', onTitleInput);
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
    get view() { return view; },
    saveNow,
    insertSnippet: () => { cmdInsertSnippet(view.state, view.dispatch); },
    pm: { Selection, TextSelection, NodeSelection },
    isDirty: () => saveState !== 'saved',
    async destroy() {
      destroyed = true;
      clearTimeout(saveTimer);
      clearRetry();
      els.titleInput.removeEventListener('input', onTitleInput);
      els.imageInput.removeEventListener('change', onImage);
      if (saveState !== 'saved') await saveNow();
      view.destroy();
      view = null;
    },
  };
}
