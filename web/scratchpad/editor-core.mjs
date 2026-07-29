/**
 * Scratchpad editor CORE (HOME_PLAN.md): the embeddable component. The old
 * scratchpad page died; the singleton modal (modal.mjs) is the only host.
 *
 * ProseMirror (vendored bundle — scripts/vendor-prosemirror.sh) drives the
 * SCRATCHPAD surface only. Snippet content is NEVER edited with PM — since
 * VARIATIONS_PLAN.md a snippet node is a PLACEMENT marker {variationId};
 * the text lives in the variation tables and is edited in a monospace
 * textarea, previewed through the real book pipeline (scratch-render.js →
 * renderer.js in a shadow root with book.css).
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
  // A snippet PLACEMENT (VARIATIONS_PLAN.md): atom marker for one variation.
  // All content/state lives server-side; the NodeView fetches its context.
  snippet: {
    group: 'block', atom: true, selectable: true,
    attrs: { variationId: { default: 0 } },
    parseDOM: [{
      tag: 'div[data-variation-id]',
      getAttrs: dom => ({ variationId: parseInt(dom.getAttribute('data-variation-id'), 10) || 0 }),
    }],
    toDOM: n => ['div', { 'data-variation-id': String(n.attrs.variationId) }],
  },
  // A note REFERENCE (NOTES_PLAN.md Phase 2, atomic rework): ONE inline atom that
  // holds the whole noted run — a small colored square + the (verbatim, snapshot)
  // highlighted text. The doc stores ONLY the note_id and the text; the COLOR is
  // NOT in the doc — the NodeView sources it from the note data (client cache),
  // so recoloring a note is a pure note-row update with no doc edit. This node
  // IS the anchor (deleting it soft-deletes the note). The text is uneditable
  // (it's an atom); it looks like normal highlighted prose.
  noteRef: {
    group: 'inline', inline: true, atom: true, selectable: false,
    attrs: { noteId: { default: 0 }, text: { default: '' } },
    parseDOM: [{
      tag: 'span[data-note-ref]',
      getAttrs: dom => ({
        noteId: parseInt(dom.getAttribute('data-note-ref'), 10) || 0,
        text: dom.getAttribute('data-note-text') || dom.textContent || '',
      }),
    }],
    // toDOM is the persistence/copy form (color not encoded); the live look is
    // rendered by NoteRefView.
    toDOM: n => ['span', {
      'data-note-ref': String(n.attrs.noteId),
      'data-note-text': n.attrs.text,
      class: 'sn-note-ref',
    }, n.attrs.text],
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
  // (The old noteHighlight mark is gone — the noteRef atom now carries the whole
  // noted run and sources its color from the note data, so color is no longer
  // stored in the doc.)
};

const base = new Schema({ nodes: coreNodes, marks });
const withLists = addListNodes(base.spec.nodes, 'paragraph block*', 'block');
const withTables = withLists.append(tableNodes({
  tableGroup: 'block',
  cellContent: 'block+',
  cellAttributes: {},
}));
export const schema = new Schema({ nodes: withTables, marks: base.spec.marks });

// Bring a stored doc up to the current schema so it always opens:
//  - drop pre-variations snippet nodes ("book_content", or "snippet" without a
//    positive variationId).
//  - CONVERT the pre-atomic note representation (a `noteAnchor` inline node +
//    a `noteHighlight` mark on the following text, both tagged with noteId)
//    into the current atomic `noteRef {noteId, text}` node. Without this, a doc
//    saved by the old build throws "Unknown node type: noteAnchor" on load.
function modernizeDoc(json) {
  // Rewrite one inline-content array: fold legacy anchor + highlighted text into
  // a single noteRef; strip any orphan noteHighlight mark.
  const convertInline = (content) => {
    if (!Array.isArray(content)) return content;
    const out = [];
    for (let i = 0; i < content.length; i++) {
      const node = content[i];
      if (node && node.type === 'noteAnchor') {
        const noteId = (node.attrs && node.attrs.noteId) || 0;
        // Gather the run of following text nodes carrying this note's highlight.
        let text = '';
        while (i + 1 < content.length) {
          const nxt = content[i + 1];
          const hl = nxt && nxt.type === 'text' && (nxt.marks || []).find(
            m => m.type === 'noteHighlight' && (m.attrs && m.attrs.noteId) === noteId);
          if (!hl) break;
          text += nxt.text || '';
          i++;
        }
        if (noteId > 0) out.push({ type: 'noteRef', attrs: { noteId, text } });
        else if (text) out.push({ type: 'text', text }); // no id → just keep the text
        continue;
      }
      // A stray text node with a noteHighlight mark but no anchor: drop the mark.
      if (node && node.type === 'text' && Array.isArray(node.marks)) {
        const marks = node.marks.filter(m => m.type !== 'noteHighlight');
        out.push(marks.length ? { ...node, marks } : { ...node, marks: undefined });
        continue;
      }
      out.push(node);
    }
    return out;
  };

  const clean = (n) => {
    if (!n || typeof n !== 'object') return null;
    if (n.type === 'book_content') return null;
    if (n.type === 'snippet' && !(n.attrs && n.attrs.variationId > 0)) return null;
    if (Array.isArray(n.content)) {
      // Convert legacy note representation within this node's inline content
      // first, then recurse into children.
      if (n.content.some(c => c && (c.type === 'noteAnchor'
          || (c.type === 'text' && (c.marks || []).some(m => m.type === 'noteHighlight'))))) {
        n.content = convertInline(n.content);
      }
      n.content = n.content.map(clean).filter(Boolean);
    }
    return n;
  };
  return clean(json) || { type: 'doc', content: [{ type: 'paragraph' }] };
}

// ------------------------------------------------- manuscript data cache

// Per-target-manuscript effective data for Canon views; module-level so
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

// ------------------------------------------------------ sketch API

async function apiCall(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) {
    const msg = (await r.text()).trim();
    const err = new Error(msg || String(r.status));
    err.status = r.status;
    throw err;
  }
  return r.status === 204 ? null : r.json();
}

// currentScratchpadId: the scratchpad a newly-created sketch is homed in. The
// modal sets this when it opens a scratchpad (from #scratchpad=N).
let currentScratchpadId = 0;
export function setCurrentScratchpadId(id) { currentScratchpadId = id | 0; }

export const sketchApi = {
  context: (id) => fetchJSON(`api/sketches/${id}`, {}, false),
  list: (q) => fetchJSON(`api/sketches?q=${encodeURIComponent(q || '')}`, {}, false),
  createNew: () => apiCall('POST', 'api/snippets', { mode: 'new', scratchpad_id: currentScratchpadId }),
  // Based on a source sketch → a new sibling sketch (next letter, text copied).
  // No source freezing; the source is left as-is.
  createFrom: (sourceId) => apiCall('POST', 'api/snippets',
    { mode: 'sketch', source_sketch_id: sourceId, scratchpad_id: currentScratchpadId }),
  saveText: (id, text) => apiCall('PUT', `api/sketches/${id}`, { text }),
  freeze: (id, frozen) => apiCall('POST', `api/sketches/${id}/freeze`, { frozen }),
  freezeAll: (snippetId) => apiCall('POST', `api/snippets/${snippetId}/freeze-all`),
  link: (snippetId, manuscriptId) => apiCall('PUT', `api/snippets/${snippetId}/link`, { manuscript_id: manuscriptId }),
  canonize: (id, manuscriptId) => apiCall('POST', `api/sketches/${id}/canonize`, { manuscript_id: manuscriptId }),
  softDelete: (id) => apiCall('DELETE', `api/sketches/${id}`),
  restore: (id) => apiCall('POST', `api/sketches/${id}/restore`),
  listDeleted: (q) => fetchJSON(`api/sketches/deleted?q=${encodeURIComponent(q || '')}`, {}, false),
  home: (id) => fetchJSON(`api/sketches/${id}/home`, {}, false),
};

// fmtDeleted renders a deleted_at ISO timestamp as a short local date for the
// Restore… list (e.g. "Jul 26"). Empty/invalid → ''.
function fmtDeleted(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// letterOf(1) = 'A'. The ordinal is an integer so a future cap lift can
// render AA/AB — for now the server refuses past Z.
export const letterOf = (ordinal) => ordinal ? String.fromCharCode(64 + ordinal) : '·';

// ----------------------------------------------------------- snippet view

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// tabMarkupHTML mirrors a textarea's raw value into overlay HTML, rendering
// each literal tab as a faint grey → glyph so \t whitespace is visible. The
// span keeps the REAL tab character (so it consumes exactly one tab stop —
// identical width to the textarea's own tab, given the shared tab-size) and
// draws the → via CSS ::before with zero advance width, so alignment is exact
// with no scroll sync (the editor never scrolls; see renderEdit). A trailing
// newline gets a zero-width space so the overlay's last line keeps height.
const tabMarkupHTML = (value) => {
  const withNL = value.endsWith('\n') ? value + '​' : value;
  return esc(withNL).replace(/\t/g, '<span class="sn-tab">\t</span>');
};

const LINK_SVG = '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6.2 9.8l3.6-3.6"/><path d="M7.3 4.3l1.4-1.4a2.75 2.75 0 013.9 3.9l-1.4 1.4"/><path d="M8.7 11.7l-1.4 1.4a2.75 2.75 0 01-3.9-3.9l1.4-1.4"/></svg>';
const TRASH_SVG = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M6.2 1.5h3.6l.5 1.1H13V4H3V2.6h2.7l.5-1.1zM4.1 5.2h7.8l-.55 8.4c-.06.85-.77 1.5-1.62 1.5H6.27c-.85 0-1.56-.65-1.62-1.5L4.1 5.2zm2.35 1.7l.3 6.3h.9l-.25-6.3h-.95zm3.1 0l-.25 6.3h.9l.3-6.3h-.95z"/></svg>';
const SNOW_SVG = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><path d="M8 1v14M1.9 4.5l12.2 7M14.1 4.5l-12.2 7M8 1l-1.8 1.8M8 1l1.8 1.8M8 15l-1.8-1.8M8 15l1.8-1.8M1.9 4.5l.6 2.4M1.9 4.5l2.4-.6M14.1 11.5l-.6-2.4M14.1 11.5l-2.4.6M14.1 4.5l-2.4-.6M14.1 4.5l-.6 2.4M1.9 11.5l2.4.6M1.9 11.5l.6-2.4"/></svg>';
const PARENT_SVG = '<svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M8 13V3M4 7l4-4 4 4"/></svg>';

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

// Views with unsaved variation text register a flush here so the modal's
// close guard can flush (and refuse to close on failure). dirtyVariations
// mirrors which views still hold unsaved text — isDirty() consults it.
const variationFlushers = new Set();
const dirtyVariations = new Set();
// Every live SnippetView, so a group-level change (e.g. linking a manuscript,
// which is a property of the snippet GROUP, not one sketch) can refresh every
// sibling widget showing the same snippet — otherwise siblings hold a stale
// link chip (or a stale tab list) until the next reload.
const liveSnippetViews = new Set();

// Refresh every EXISTING widget of the given snippet group except one (usually
// a just-created sketch, which mounts fresh). Used after a group-level change so
// siblings pick it up immediately — e.g. a new related sketch appearing in their
// tab bar, or a manuscript link updating their chip.
function refreshSnippetSiblings(snippetId, exceptSketchId) {
  if (!snippetId) return;
  return Promise.all(Array.from(liveSnippetViews)
    .filter(v => v.ctx && v.ctx.snippet && v.ctx.snippet.snippet_id === snippetId
      && v.sketchId !== exceptSketchId)
    .map(v => v.refresh()));
}

function renderBookText(host, text) {
  const canon = window.WriteSysCanonicalize ? window.WriteSysCanonicalize.canonicalize : (t) => t;
  window.WriteSysScratchRender.renderText(host, canon(text));
}

class SnippetView {
  constructor(node, view, getPos) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;
    this.sketchId = node.attrs.variationId;
    this.dom = document.createElement('div');
    this.dom.className = 'sn-widget';
    this.dom.dataset.variationId = String(this.sketchId); // legacy attr (PM node)
    this.dom.dataset.sketchId = String(this.sketchId);     // navigate-to-source target
    this.dom.innerHTML = '<div class="sn-header"><span class="sn-status">Snippet · loading…</span></div><div class="sn-body"></div>';
    this.tab = 'self';       // 'self' | 'canon' | other variationId (number)
    this.mode = 'preview';   // self tab only: 'preview' | 'edit'
    this.peerCache = {};     // variationId → context (parent/child tabs)
    this.dirty = false;
    this.flush = async () => true;
    liveSnippetViews.add(this);
    this.load();
  }

  async load() {
    try {
      this.ctx = await sketchApi.context(this.sketchId);
    } catch (e) {
      this.dom.innerHTML = `
        <div class="sn-header">
          <span class="sn-status">Snippet · unavailable</span>
          <span class="sn-tabs"></span>
          <span class="sn-actions"><button type="button" data-act="remove" class="sn-trash" title="Remove widget">${TRASH_SVG}</button></span>
        </div>
        <div class="sn-body"><div class="sn-note"><span class="sn-error">Sketch ${this.sketchId} could not be loaded (${esc(e.message)}).</span></div></div>`;
      this.dom.querySelector('[data-act="remove"]').addEventListener('click', () => this.removeWidget(true));
      return;
    }
    this.build();
  }

  async refresh(keepTab = true) {
    const tab = this.tab;
    this.peerCache = {};
    try {
      this.ctx = await sketchApi.context(this.sketchId);
    } catch (e) { /* keep the stale view rather than blanking */ }
    if (!keepTab) this.tab = 'self';
    else this.tab = tab;
    this.preserveScroll(() => this.build());
  }

  // The scrollable host for this widget (the modal body). Rebuilding the widget's
  // DOM, or focusing an element inside it, makes the browser re-anchor scroll and
  // jump — usually to the top of the widget. Everything that tears down and
  // rebuilds the widget (build/renderBody/setTab/toggleFreeze) runs through
  // preserveScroll so the reader stays put. This is the single, root-cause fix
  // for "clicking a snippet scrolls me to the top."
  scrollHost() {
    return this.dom.closest('.spm-editor') || this.dom.closest('[data-scroll-host]') || null;
  }
  // Snapshot scrollTop, run fn (which may replace DOM / move focus), then restore
  // the scroll position — both synchronously and once more after layout settles,
  // since focus()/textarea auto-grow can nudge it a frame later.
  preserveScroll(fn) {
    const host = this.scrollHost();
    if (!host) return fn();
    const top = host.scrollTop;
    const r = fn();
    const restore = () => { if (host.scrollTop !== top) host.scrollTop = top; };
    restore();
    requestAnimationFrame(restore);
    return r;
  }

  canonized() { return this.ctx.snippet.canon_sketch_id > 0; }
  frozen() { return this.ctx.sketch.frozen; }
  letter() { return letterOf(this.ctx.sketch.ordinal); }

  // Tab model: THIS sketch first, a separator, then the other sibling sketches
  // (by letter), then Canon (blue) if any. Sketches are flat siblings — no
  // lineage — and each widget's home sketch is shown first so you always see
  // "which one this is".
  tabDefs() {
    const defs = [];
    defs.push({ key: 'self', letter: this.letter(), self: true });
    const others = (this.ctx.siblings || []).filter(s => s.sketch_id !== this.sketchId);
    if (others.length) defs.push({ label: 'Related:' });
    for (const s of others) {
      defs.push({ key: s.sketch_id, ordinal: s.ordinal, letter: letterOf(s.ordinal) });
    }
    if (this.canonized()) defs.push({ key: 'canon', letter: 'Canon', canon: true });
    return defs;
  }

  build() {
    const v = this.ctx.sketch;
    const sn = this.ctx.snippet;
    // Identity for navigate-to-source: (snippet, ordinal). The global sketch_id
    // stays as data-variation-id/data-sketch-id for the PM node + back-compat.
    this.dom.dataset.snippetId = sn.snippet_id;
    if (v.ordinal != null) this.dom.dataset.ordinal = String(v.ordinal);
    this.dom.classList.toggle('sn-canon', this.canonized());
    const state = this.frozen() ? 'frozen' : 'draft';
    const status = `Snippet · ${this.letter()} · ${state}`;
    const statusHint = `Sketch ${this.letter()} of snippet #${sn.snippet_id}. ` +
      (this.frozen() ? 'Frozen: read-only until unfrozen (snowflake). ' : 'Click the preview to edit. ') +
      `Created ${esc((v.created_at || '').slice(0, 10))}.`;

    // Link affordance (GROUP-level): unlinked gets the link button; linked
    // a chip (unlink × until canonized — canon pins the link permanently).
    let linkBit = '';
    if (sn.linked_manuscript_id) {
      const unlink = this.canonized() ? ''
        : `<button type="button" class="sn-unlink" title="Unlink from ${esc(sn.linked_manuscript_name)}">×</button>`;
      linkBit = `<span class="sn-linkchip" title="Linked to ${esc(sn.linked_manuscript_name)} — this snippet can only be canonized into that manuscript.">${LINK_SVG}<span class="sn-linkname">${esc(sn.linked_manuscript_name)}</span>${unlink}</span>`;
    } else {
      linkBit = `<button type="button" class="sn-linkbtn" title="Link to manuscript">${LINK_SVG}</button>`;
    }

    // Tabs: letters; overflow beyond 8 collapses into a ▾ dropdown.
    const defs = this.tabDefs();
    const MAXTABS = 8;
    const shown = defs.length > MAXTABS ? defs.slice(0, MAXTABS - 1) : defs;
    const overflow = defs.length > MAXTABS ? defs.slice(MAXTABS - 1) : [];
    const tabHtml = shown.map(d => this.tabButtonHTML(d)).join('') +
      (overflow.length
        ? `<span class="sn-tab-more"><button type="button" class="sn-more-btn" title="More sketches">▾</button><span class="sn-more-list" hidden>${overflow.map(d => this.tabButtonHTML(d)).join('')}</span></span>`
        : '');

    const openBook = this.canonized() && sn.linked_manuscript_id
      ? `<a class="sn-open" href="index.html?manuscript_id=${sn.linked_manuscript_id}#${encodeURIComponent(sn.snippet_id)}" title="Open in book">Open in book ↗</a>`
      : '';
    this.dom.innerHTML = `
      <div class="sn-header">
        <span class="sn-status${this.canonized() ? ' sn-canonized' : ''}" title="${statusHint}">${status}</span>${linkBit}<span class="sn-save"></span>
        <span class="sn-tabs">${tabHtml}</span>
        <span class="sn-actions">
          ${openBook}
          <button type="button" data-act="freeze" class="sn-freeze${this.frozen() ? ' pressed' : ''}" title="${this.frozen() ? 'Frozen — click to unfreeze' : 'Freeze (make read-only)'}">${SNOW_SVG}</button>
          <button type="button" data-act="remove" class="sn-trash" title="Delete this sketch (recoverable via Restore&hellip;)">${TRASH_SVG}</button>
        </span>
      </div>
      <div class="sn-body"></div>`;
    this.body = this.dom.querySelector('.sn-body');
    this.saveEl = this.dom.querySelector('.sn-save');

    this.dom.querySelectorAll('[data-tab]').forEach(btn => {
      btn.addEventListener('click', () => this.setTab(btn.dataset.tab));
    });
    const more = this.dom.querySelector('.sn-more-btn');
    if (more) {
      more.addEventListener('click', () => {
        const list = this.dom.querySelector('.sn-more-list');
        list.hidden = !list.hidden;
      });
    }
    this.dom.querySelector('[data-act="remove"]').addEventListener('click', () => this.removeWidget(false));
    this.dom.querySelector('[data-act="freeze"]').addEventListener('click', () => this.toggleFreeze());
    const linkBtn = this.dom.querySelector('.sn-linkbtn');
    if (linkBtn) linkBtn.addEventListener('click', () => this.openLinkPicker());
    const unlinkBtn = this.dom.querySelector('.sn-unlink');
    if (unlinkBtn) unlinkBtn.addEventListener('click', () => this.setLink(0));
    this.renderBody();
  }

  tabButtonHTML(d) {
    // On mobile the label text is hidden via CSS and a "|" separator shown
    // instead (the ::before on .sn-tab-label), so keep the real text here.
    if (d.label) return `<span class="sn-tab-label" data-sep="|">${esc(d.label)}</span>`;
    const active = (d.self && this.tab === 'self') || (d.canon && this.tab === 'canon') || d.key === this.tab;
    const isPeer = !d.self && !d.canon;
    const cls = ['sn-tab', active ? 'active' : '', d.canon ? 'sn-tab-canon' : '',
      d.self ? 'sn-tab-self' : '', isPeer ? 'sn-tab-peer' : ''].filter(Boolean).join(' ');
    const title = d.canon ? 'Canon — the version placed into the book'
      : d.self ? `Sketch ${d.letter} (this widget's sketch)`
      : `Sketch ${d.letter} (preview; click to view)`;
    return `<button type="button" data-tab="${d.self ? 'self' : (d.canon ? 'canon' : d.key)}" class="${cls}" title="${title}">${esc(String(d.letter))}</button>`;
  }

  setTab(key) {
    this.tab = key === 'self' || key === 'canon' ? key : parseInt(key, 10);
    this.mode = 'preview';
    this.dom.querySelectorAll('[data-tab]').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === String(key));
    });
    this.renderBody();
  }

  renderBody() {
    // All body re-renders (enter edit, blur→preview, switch tab, peer preview)
    // replace DOM and may move focus; preserve the reader's scroll position so
    // none of them jump the pad to the top of the widget.
    return this.preserveScroll(() => {
      if (this.tab === 'self') {
        return this.mode === 'edit' ? this.renderEdit() : this.renderSelfPreview();
      }
      if (this.tab === 'canon') return this.renderCanon(false);
      return this.renderPeer(this.tab);
    });
  }

  renderSelfPreview() {
    this.ta = null;
    const frozen = this.frozen();
    this.body.innerHTML = `<div class="sn-render${frozen ? ' sn-frozen' : ' sn-clickable'}" title="${frozen ? 'Frozen — unfreeze (snowflake) to edit' : 'Click to edit'}"></div>`;
    const host = this.body.firstChild;
    const text = this.ctx.sketch.text;
    if (text.trim()) {
      renderBookText(host, text);
    } else {
      host.innerHTML = `<div class="sn-empty">${frozen ? 'Empty (frozen) variation.' : 'Click to write.'}</div>`;
    }
    host.addEventListener('click', () => {
      if (!this.frozen()) { this.mode = 'edit'; this.renderBody(); }
    });
  }

  renderEdit() {
    this.body.innerHTML = '';
    const ta = document.createElement('textarea');
    ta.className = 'sn-text';
    ta.placeholder = 'Snippet in .manuscript form — plain text, *italics*, \\n\\n section breaks, commands allowed. Canonize from the book view (+ between paragraphs).';
    ta.value = this.ctx.sketch.text;
    ta.rows = Math.max(6, this.ctx.sketch.text.split('\n').length + 2);
    let t = null;
    let saveAttempt = 0;
    let retryTimer = null;
    let countdown = null;
    const clearRetry = () => { clearTimeout(retryTimer); retryTimer = null; clearInterval(countdown); countdown = null; };
    const save = async () => {
      clearTimeout(t); clearRetry();
      if (ta.value === this.ctx.sketch.text) { dirtyVariations.delete(this); this.saveEl.textContent = ''; return true; }
      this.saveEl.textContent = 'saving…';
      try {
        await sketchApi.saveText(this.sketchId, ta.value);
        const changed = this.ctx.sketch.text !== ta.value;
        this.ctx.sketch.text = ta.value;
        dirtyVariations.delete(this);
        saveAttempt = 0;
        this.saveEl.textContent = '';
        // Blur may have flipped to preview before this save resolved —
        // re-render so the preview shows what was just saved.
        if (changed && this.tab === 'self' && this.mode === 'preview') this.renderBody();
        return true;
      } catch (e) {
        if (e.status === 409) {
          // Frozen underneath us (another widget/tab) — surface it.
          this.saveEl.textContent = 'frozen — not saved';
          return false;
        }
        saveAttempt = Math.min(saveAttempt + 1, 6);
        let secs = Math.min(60, Math.pow(2, saveAttempt));
        const show = () => { this.saveEl.textContent = `Failed to save. Trying again in ${secs}s`; };
        show();
        countdown = setInterval(() => { secs -= 1; if (secs > 0) show(); }, 1000);
        retryTimer = setTimeout(() => { clearRetry(); save(); }, secs * 1000);
        return false;
      }
    };
    this.flush = save;
    variationFlushers.add(save);
    ta.addEventListener('input', () => {
      dirtyVariations.add(this);
      clearTimeout(t); clearRetry();
      t = setTimeout(save, 600);
    });
    ta.addEventListener('blur', () => {
      save();
      if (this.tab === 'self' && this.mode === 'edit') { this.mode = 'preview'; this.renderBody(); }
    });

    // Literal .manuscript editing: Tab inserts a real \t at the caret (so a
    // "\n\t" paragraph break is typeable) instead of moving focus. Shift-Tab
    // still escapes the field so the author is never trapped.
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { ta.blur(); return; }
      if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        const s = ta.selectionStart, en = ta.selectionEnd;
        ta.value = ta.value.slice(0, s) + '\t' + ta.value.slice(en);
        ta.selectionStart = ta.selectionEnd = s + 1;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });

    // The editor never scrolls internally — it grows to fit its content (the
    // dialog body scrolls instead). This also makes the tab-marker overlay
    // trivial: no scroll position to sync, just matched static geometry.
    const wrap = document.createElement('div');
    wrap.className = 'sn-text-wrap';
    const overlay = document.createElement('div');
    overlay.className = 'sn-text-overlay';
    overlay.setAttribute('aria-hidden', 'true');
    const autoGrow = () => {
      ta.style.height = 'auto';
      ta.style.height = ta.scrollHeight + 'px';
      // Mirror the text into the overlay, rendering each tab as a faint grey
      // → glyph so invisible whitespace is visible. Everything else is neutral
      // (the textarea's own text sits transparent on top).
      overlay.innerHTML = tabMarkupHTML(ta.value);
    };
    ta.addEventListener('input', autoGrow);
    wrap.appendChild(overlay);
    wrap.appendChild(ta);
    this.body.appendChild(wrap);
    this.ta = ta;
    // preventScroll: focusing the textarea would otherwise scroll it into view
    // (jumping to the top of the snippet) — the main "click-to-edit scrolls me
    // up" trigger. preserveScroll (around renderBody) is the backstop.
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(ta.value.length, ta.value.length);
    autoGrow();
  }

  // A sibling sketch shown as a READ-ONLY preview (its real home widget is
  // elsewhere). Disabled-looking, no caret; a link navigates to its source.
  async renderPeer(sketchId) {
    this.body.innerHTML = '<div class="sn-note">Loading sketch…</div>';
    let ctx = this.peerCache[sketchId];
    if (!ctx) {
      try {
        ctx = this.peerCache[sketchId] = await sketchApi.context(sketchId);
      } catch (e) {
        this.body.innerHTML = `<div class="sn-note"><span class="sn-error">Could not load sketch (${esc(e.message)}).</span></div>`;
        return;
      }
    }
    if (this.tab !== sketchId) return; // switched away while loading
    const letter = esc(letterOf(ctx.sketch.ordinal));
    this.body.innerHTML = `
      <div class="sn-note"><strong>Previewing sketch ${letter}.</strong> <a href="#" class="sn-goto-source">Click here to navigate to source.</a></div>
      <div class="sn-render sn-peer"></div>`;
    const snippetId = ctx.sketch.snippet_id;
    const ordinal = ctx.sketch.ordinal;
    this.body.querySelector('.sn-goto-source').addEventListener('click', (e) => {
      e.preventDefault();
      this.gotoSketchSource(sketchId, snippetId, ordinal);
    });
    const host = this.body.querySelector('.sn-render');
    // Swallow mousedown so a click doesn't place a caret / fall through to the
    // ProseMirror editor behind the widget (which would move the PM selection
    // and scroll the pad). Text stays selectable via drag (that's mousemove).
    host.addEventListener('mousedown', (e) => { e.preventDefault(); });
    if (ctx.sketch.text.trim()) renderBookText(host, ctx.sketch.text);
    else host.innerHTML = '<div class="sn-empty">Empty sketch.</div>';
  }

  // Navigate to a sketch's home widget: ask the server which scratchpad hosts
  // it, then set the URL hash to open that scratchpad and scroll to the widget.
  // Identity is (snippet, ordinal) — NOT the global sketch_id — so the URL is
  // human-readable and stable: #scratchpad=N&snippet=ID&sketch=<ordinal>.
  async gotoSketchSource(sketchId, snippetId, ordinal) {
    let spID = 0;
    try { spID = (await sketchApi.home(sketchId)).scratchpad_id | 0; } catch (e) { /* fall through */ }
    if (spID > 0) {
      window.location.hash = `#scratchpad=${spID}&snippet=${encodeURIComponent(snippetId)}&sketch=${ordinal}`;
    } else {
      alert('That sketch has no home scratchpad on record yet.');
    }
  }

  // Canon truth derives from the manuscript (VARIATIONS_PLAN §2): resolve
  // the &snippet#id … &end#id region from the effective manuscript; the
  // canon variation's text is the immutable as-canonized snapshot, used as
  // fallback and via the in-body toggle.
  async renderCanon(showSnapshot) {
    const sn = this.ctx.snippet;
    const snap = this.ctx.canon ? this.ctx.canon.text : '';
    const canonizedOn = this.ctx.canon ? (this.ctx.canon.created_at || '').slice(0, 10) : '';
    if (showSnapshot) {
      this.body.innerHTML = `
        <div class="sn-note">As canonized (${esc(canonizedOn)}) — the text at the moment it entered the book. <a href="#" class="sn-canonswap">Show live</a></div>
        <div class="sn-render"></div>`;
      this.body.querySelector('.sn-canonswap').addEventListener('click', (e) => { e.preventDefault(); this.renderCanon(false); });
      renderBookText(this.body.querySelector('.sn-render'), snap);
      return;
    }
    this.body.innerHTML = '<div class="sn-note">Resolving from the manuscript…</div><div class="sn-render"></div>';
    const host = this.body.querySelector('.sn-render');
    try {
      const data = await bookData.load(sn.linked_manuscript_id, false);
      const canon = window.WriteSysCanonicalize ? window.WriteSysCanonicalize.canonicalize : (t) => t;
      const res = window.WriteSysRegion.resolve(data.sentences, data.sugMap, sn.snippet_id, window.WriteSysCommand, canon);
      if (this.tab !== 'canon') return;
      if (res.status !== 'ok') {
        this.body.querySelector('.sn-note').innerHTML =
          `<span class="sn-error">Region #${esc(sn.snippet_id)} ${res.status === 'missing-anchor'
            ? 'not found in the effective manuscript' : 'has no matching &amp;end'} — showing the as-canonized snapshot.</span>`;
        renderBookText(host, snap);
        return;
      }
      this.body.querySelector('.sn-note').innerHTML =
        `Live from the effective manuscript (committed + your suggestions). <a href="#" class="sn-canonswap">Show as-canonized</a>`;
      this.body.querySelector('.sn-canonswap').addEventListener('click', (e) => { e.preventDefault(); this.renderCanon(true); });
      window.WriteSysScratchRender.render(host, res.items);
    } catch (e) {
      this.body.querySelector('.sn-note').innerHTML =
        `<span class="sn-error">Could not load manuscript ${sn.linked_manuscript_id} (${esc(e.message)}) — showing the snapshot.</span>`;
      renderBookText(host, snap);
    }
  }

  async toggleFreeze() {
    try {
      await sketchApi.freeze(this.sketchId, !this.frozen());
      await this.refresh();
    } catch (e) {
      alert('Could not toggle freeze: ' + e.message);
    }
  }

  async setLink(manuscriptId) {
    const snippetId = this.ctx.snippet.snippet_id;
    try {
      await sketchApi.link(snippetId, manuscriptId);
      // The link belongs to the snippet GROUP: refresh every live widget of
      // this snippet (including this one) so their chips update now, not only
      // after a reload.
      await refreshSnippetSiblings(snippetId, null);
    } catch (e) {
      alert('Could not update link: ' + e.message);
    }
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
        ? hits.map(m => `<button type="button" data-mid="${m.id}">${esc(m.name)}</button>`).join('')
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
      this.setLink(parseInt(b.dataset.mid, 10));
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

  async removeWidget(broken) {
    const pos = this.getPos();
    if (pos == null) return;
    const label = broken
      ? 'Remove this widget?'
      : `Delete variation ${this.letter()}? It's soft-deleted — bring it back any time via the ⧉ Snippet ▾ menu → Restore…`;
    if (!window.confirm(label)) return;
    // Soft-delete the variation first (a broken widget has no live variation to
    // delete). If the delete fails, keep the widget so nothing is lost.
    if (!broken && this.sketchId) {
      try {
        await sketchApi.softDelete(this.sketchId);
      } catch (e) {
        alert('Could not delete variation: ' + e.message);
        return;
      }
    }
    const freshPos = this.getPos();
    if (freshPos == null) return;
    this.view.dispatch(this.view.state.tr.delete(freshPos, freshPos + this.node.nodeSize));
    this.view.focus();
  }

  update(node) {
    if (node.type !== this.node.type) return false;
    if (node.attrs.variationId !== this.sketchId) return false;
    this.node = node;
    return true;
  }

  destroy() {
    this.closeLinkPicker();
    variationFlushers.delete(this.flush);
    dirtyVariations.delete(this);
    liveSnippetViews.delete(this);
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

// ---- Scratchpad notes (NOTES_PLAN.md Phase 2, atomic) --------------------
// Creating a note from a selection replaces the selected text with ONE atomic
// noteRef node (square + verbatim text). The doc stores note_id + text only —
// the COLOR is sourced from the note data (client cache), so recolor is a pure
// note-row update with no doc edit, and there's one source of truth.

const NOTE_COLORS = ['yellow', 'green', 'blue', 'purple', 'red', 'orange'];

// The active editor view (set in createScratchpadEditor) so the module-level
// note helpers can read/edit the doc.
let activeView = null;

// ---- Client note cache -----------------------------------------------------
// The doc stores only note_id + text; the COLOR (and body/tags/priority/flag)
// live on the note row. This cache holds the note data so the NoteRefView can
// render the right color WITHOUT a color in the doc, and so recolor is a pure
// note-row update. Keyed by note_id → { color, body, priority, flagged, tags }.
const noteCache = new Map();
// note_id → Set of NoteRefView instances, so a recolor re-renders every view of
// that note instantly.
const noteRefViews = new Map();
function registerNoteRefView(noteId, view) {
  if (!noteRefViews.has(noteId)) noteRefViews.set(noteId, new Set());
  noteRefViews.get(noteId).add(view);
}
function unregisterNoteRefView(noteId, view) {
  const s = noteRefViews.get(noteId);
  if (s) { s.delete(view); if (!s.size) noteRefViews.delete(noteId); }
}
function noteColorOf(noteId) {
  const n = noteCache.get(noteId);
  return (n && n.color) || 'yellow';
}
// Ensure the cache has this note; fetch it if missing. Returns the cached note.
async function ensureNoteCached(noteId) {
  if (noteCache.get(noteId)) return noteCache.get(noteId);
  try {
    const n = await window.WriteSysNoteAPI.get(noteId);
    if (n) {
      const cached = { color: n.color, body: n.body, priority: n.priority, flagged: n.flagged, tags: n.tags || [] };
      noteCache.set(noteId, cached);
      return cached;
    }
  } catch (e) { /* fall through */ }
  return noteCache.get(noteId) || null;
}

// Create a scratchpad note from the current selection in `color`.
async function createNoteFromSelection(color) {
  const view = activeView;
  if (!view || !window.WriteSysNoteAPI) return;
  const { from, to, empty } = view.state.selection;
  if (empty) return; // nothing selected → no-op (buttons are disabled anyway)
  // Snapshot the highlighted text: it becomes BOTH the note body (so the note
  // shows what it's about, incl. on the landing page) AND the verbatim text the
  // atomic noteRef renders inline. The snapshot doesn't re-sync on doc edits.
  const snapshot = view.state.doc.textBetween(from, to, ' ');
  const trimmed = snapshot.trim();
  const body = trimmed || null;
  let created;
  try {
    created = await window.WriteSysNoteAPI.create({ color, body, ctx: { scratchpad_id: currentScratchpadId } });
  } catch (e) { console.error('create scratchpad note failed', e); return; }
  const noteId = created && created.note_id;
  if (!noteId) return;
  noteCache.set(noteId, { color, body, priority: 'none', flagged: false, tags: [] });
  const sc = view.state.schema;
  // Replace the selected text with ONE atomic noteRef holding the snapshot text.
  const ref = sc.nodes.noteRef.create({ noteId, text: snapshot });
  const tr = view.state.tr.replaceRangeWith(from, to, ref);
  view.dispatch(tr);
  view.focus();
  // Open the float on the just-inserted ref.
  requestAnimationFrame(() => {
    const el = view.dom.querySelector(`.sn-note-ref[data-note-id="${noteId}"]`);
    if (el) openNoteFloatFor(noteId, el);
  });
}

// Recolor a note: update the note row + cache, then re-render every noteRef view
// of it. NO doc edit — the color isn't in the doc.
function recolorNote(noteId, color) {
  const cached = noteCache.get(noteId) || {};
  cached.color = color;
  noteCache.set(noteId, cached);
  if (window.WriteSysNoteAPI) window.WriteSysNoteAPI.update(noteId, { color }).catch(() => {});
  const s = noteRefViews.get(noteId);
  if (s) s.forEach(v => v.applyColor(color));
}

// Remove a note's ref node from the doc. Returns true if found. Removing the
// node triggers its NodeView destroy() (which soft-deletes unless suppressed).
function removeNoteFromDoc(noteId) {
  const view = activeView; if (!view) return false;
  const sc = view.state.schema;
  const ranges = [];
  view.state.doc.descendants((node, pos) => {
    if (node.type === sc.nodes.noteRef && node.attrs.noteId === noteId) ranges.push([pos, pos + node.nodeSize]);
  });
  if (!ranges.length) return false;
  let tr = view.state.tr;
  ranges.sort((a, b) => b[0] - a[0]).forEach(([a, b]) => { tr = tr.delete(a, b); });
  view.dispatch(tr);
  return true;
}

// Delete a note via the doc — removing the ref triggers destroy() → soft-delete.
function deleteNoteViaDoc(noteId) {
  removeNoteFromDoc(noteId);
  closeNoteFloat();
}

// Set true while the editor is being torn down (modal close) so ref
// NodeView.destroy() does NOT soft-delete the notes.
let editorTearingDown = false;
// Note ids whose ref is being removed for a reason OTHER than deletion (e.g.
// "complete"). destroy() consults this and skips the soft-delete.
const suppressNoteDelete = new Set();
function removeNoteRefNoDelete(noteId) {
  suppressNoteDelete.add(noteId);
  removeNoteFromDoc(noteId);
  setTimeout(() => suppressNoteDelete.delete(noteId), 0);
}

// The red trash glyph, reused from the sticky-note widget for visual consistency.
const TRASH_SVG_NOTE = '<svg width="12" height="12" viewBox="0 0 20 20"><path d="M6 2h8M3 5h14M5 5l1 12h8l1-12M8 8v6M12 8v6" stroke="currentColor" fill="none" stroke-width="1.5" stroke-linecap="round"/></svg>';

// NodeView for the atomic noteRef: a colored square + the verbatim highlighted
// text, looking like normal highlighted prose but UNEDITABLE (atom). The COLOR
// comes from the note cache (not the doc). Clicking the square opens the float;
// hovering reveals a floating red trash (two-click confirm). Deletion is
// deterministic: destroy() fires when the node leaves the doc.
class NoteRefView {
  constructor(node, view, getPos) {
    this.node = node;
    this.noteId = node.attrs.noteId;
    this.dom = document.createElement('span');
    this.dom.className = 'sn-note-ref color-' + noteColorOf(this.noteId);
    this.dom.dataset.noteId = String(this.noteId);
    this.dom.contentEditable = 'false';
    this.dom.title = 'Note — click the square to open';
    this.dom.innerHTML =
      '<span class="sn-note-ref-sq"></span>' +
      '<span class="sn-note-ref-text"></span>' +
      '<span class="sn-note-ref-trash" title="Delete note">' + TRASH_SVG_NOTE + '</span>';
    // Text via textContent (never innerHTML) — XSS-safe.
    this.dom.querySelector('.sn-note-ref-text').textContent = node.attrs.text;
    registerNoteRefView(this.noteId, this);
    // If the color isn't cached yet (e.g. doc loaded from disk), fetch + apply.
    if (!noteCache.get(this.noteId)) {
      ensureNoteCached(this.noteId).then(n => { if (n) this.applyColor(n.color); });
    }
    this.dom.querySelector('.sn-note-ref-sq').addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation();
      openNoteFloatFor(this.noteId, this.dom);
    });
    // Two-click confirm on the trash.
    const trash = this.dom.querySelector('.sn-note-ref-trash');
    let clickCount = 0, resetTimer = null;
    trash.addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (clickCount === 0) {
        trash.classList.add('confirming'); trash.title = 'Click again to delete'; clickCount = 1;
        resetTimer = setTimeout(() => { trash.classList.remove('confirming'); trash.title = 'Delete note'; clickCount = 0; }, 2000);
      } else {
        clearTimeout(resetTimer);
        deleteNoteViaDoc(this.noteId);
      }
    });
  }
  applyColor(color) {
    this.dom.className = 'sn-note-ref color-' + (color || 'yellow');
  }
  destroy() {
    unregisterNoteRefView(this.noteId, this);
    if (!editorTearingDown && !suppressNoteDelete.has(this.noteId) && window.WriteSysNoteAPI && this.noteId) {
      window.WriteSysNoteAPI.remove(this.noteId).catch(() => {});
    }
  }
  stopEvent() { return true; }
  ignoreMutation() { return true; }
}

// ---- The floating note (only one open at a time) ---------------------------
let openNoteFloat = null;
function closeNoteFloat() {
  if (openNoteFloat) { openNoteFloat.remove(); openNoteFloat = null; }
  document.removeEventListener('mousedown', onFloatOutside, true);
}
function onFloatOutside(e) {
  if (openNoteFloat && !openNoteFloat.contains(e.target)
      && !(e.target.closest && e.target.closest('.sn-note-ref'))) {
    closeNoteFloat();
  }
}

// Open the floating note for a note id, positioned below `anchorEl`. Fetches the
// CURRENT note (body/color/tags) so the reopened float always shows saved data.
async function openNoteFloatFor(noteId, anchorEl) {
  closeNoteFloat();
  if (!window.WriteSysNoteWidget || !window.WriteSysNoteAPI) return;
  const api = window.WriteSysNoteAPI;
  const fetched = await ensureNoteCached(noteId);
  const cached = fetched || noteCache.get(noteId) || { color: noteColorOf(noteId), body: null, priority: 'none', flagged: false, tags: [] };
  const note = {
    noteId, note_id: noteId,
    color: cached.color, body: cached.body,
    priority: cached.priority || 'none', flagged: !!cached.flagged, tags: cached.tags || [],
  };
  if (openNoteFloat) return; // a newer open superseded us while fetching
  const float = document.createElement('div');
  float.className = 'sn-note-float';
  const widget = window.WriteSysNoteWidget.buildNoteElement(note, {
    onSaveText: (text) => { note.body = text.trim() || null; cached.body = note.body; api.update(noteId, { body: note.body }); },
    onColor: (color) => {
      note.color = color;
      recolorNote(noteId, color); // updates row + cache + all ref views (no doc edit)
      openNoteFloatFor(noteId, anchorEl); // re-render palette (shows other 5)
    },
    onPriority: (p) => { note.priority = note.priority === p ? 'none' : p; cached.priority = note.priority; api.update(noteId, { priority: note.priority }); window.WriteSysNoteWidget.updatePriorityFlagUI(float.firstChild, note); },
    onFlag: () => { note.flagged = !note.flagged; cached.flagged = note.flagged; api.update(noteId, { flagged: note.flagged }); window.WriteSysNoteWidget.updatePriorityFlagUI(float.firstChild, note); },
    onDelete: () => { deleteNoteViaDoc(noteId); },
    onComplete: () => { api.complete(noteId); removeNoteRefNoDelete(noteId); closeNoteFloat(); },
    onAddTag: async (name) => { try { const r = await api.addTag(noteId, name); note.tags = (r && r.tags) || note.tags; cached.tags = note.tags; } catch (e) {} },
    onRemoveTag: async (tagId) => { try { await api.removeTag(noteId, tagId); note.tags = (note.tags || []).filter(t => t.tag_id !== tagId); cached.tags = note.tags; } catch (e) {} },
  }, {});
  float.appendChild(widget);
  document.body.appendChild(float);
  openNoteFloat = float;
  const r = anchorEl.getBoundingClientRect();
  float.style.position = 'absolute';
  float.style.top = (window.scrollY + r.bottom + 6) + 'px';
  float.style.left = (window.scrollX + r.left) + 'px';
  setTimeout(() => document.addEventListener('mousedown', onFloatOutside, true), 0);
}

// The right-aligned 6-color note bar. Each square creates a note from the
// current selection; all are disabled when nothing is selected. Registers the
// group in `dyn` so updateToolbar() can toggle the disabled state per state.
// Module list of note-color groups; updateToolbar() toggles their disabled look
// (empty selection → can't create a note).
const noteColorGroups = [];
function buildNoteColorBar(toolbarEl, getView) {
  const group = document.createElement('span');
  group.className = 'sn-note-colorbar';
  NOTE_COLORS.forEach(color => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sn-note-colorbtn color-' + color;
    btn.title = 'Note (' + color + ') — select text first';
    btn.style.backgroundColor = 'var(--highlight-' + color + ')';
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (getView().state.selection.empty) return;
      createNoteFromSelection(color);
    });
    group.appendChild(btn);
  });
  toolbarEl.appendChild(group);
  group._getView = getView;
  noteColorGroups.push(group);
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

// The ⧉ Snippet ▾ menu: New snippet, or Based on… (variation picker sorted
// by variation updated_at, then a freeze-the-source choice).
function buildSnippetMenu(toolbarEl, getView) {
  const wrap = document.createElement('span');
  wrap.className = 'tb-tablewrap';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sn-btn';
  btn.title = 'Insert a Manuscript Snippet (new, or a variation based on an existing one)';
  btn.textContent = '⧉ Snippet ▾';
  const pop = document.createElement('div');
  pop.className = 'sn-insertpop';
  pop.hidden = true;
  wrap.append(btn, pop);

  const onDocDown = (e) => { if (!wrap.contains(e.target)) close(); };
  const close = () => {
    pop.hidden = true;
    document.removeEventListener('mousedown', onDocDown, true);
  };

  const insertVariation = (ctx) => {
    const view = getView();
    insertBlockSafely(view.state, view.dispatch,
      schema.nodes.snippet.create({ variationId: ctx.sketch.sketch_id }));
    close();
    view.focus();
    // A new sibling changes the group's sketch list, so every EXISTING widget of
    // the same snippet must refresh to show the new one in its tab bar (the new
    // widget just mounted fresh with the full list). Without this, related
    // widgets don't get the new tab until a reload.
    const snippetId = (ctx.snippet && ctx.snippet.snippet_id)
      || (ctx.sketch && ctx.sketch.snippet_id);
    refreshSnippetSiblings(snippetId, ctx.sketch.sketch_id);
  };

  const renderRoot = () => {
    pop.innerHTML = `
      <button type="button" class="sn-ins-new">New snippet</button>
      <button type="button" class="sn-ins-based">Related to…</button>
      <button type="button" class="sn-ins-restore">Restore…</button>`;
    pop.querySelector('.sn-ins-new').addEventListener('click', async () => {
      try { insertVariation(await sketchApi.createNew()); }
      catch (e) { alert('Could not create snippet: ' + e.message); }
    });
    pop.querySelector('.sn-ins-based').addEventListener('click', renderPicker);
    pop.querySelector('.sn-ins-restore').addEventListener('click', renderRestore);
  };

  // Restore… picker: soft-deleted variations, newest deletion first. Selecting
  // one un-deletes it and inserts its widget.
  const renderRestore = async () => {
    pop.innerHTML = `
      <input type="text" class="sn-ins-q" placeholder="Search deleted variations…" autocomplete="off">
      <div class="sn-ins-list"><span class="sn-linkpop-empty">Loading…</span></div>`;
    const q = pop.querySelector('.sn-ins-q');
    const list = pop.querySelector('.sn-ins-list');
    q.focus();
    const load = async () => {
      let rows;
      try {
        rows = (await sketchApi.listDeleted(q.value.trim())).sketches || [];
      } catch (e) {
        list.innerHTML = '<span class="sn-linkpop-empty">Could not load deleted variations</span>';
        return;
      }
      list.innerHTML = rows.length
        ? rows.map(r => `
          <button type="button" data-vid="${r.sketch_id}">
            <span class="sn-ins-letter">${esc(letterOf(r.ordinal))}</span>
            <span class="sn-ins-preview">${esc(r.preview || '(empty)')}</span>
            <span class="sn-ins-deleted">${esc(fmtDeleted(r.deleted_at))}</span>
          </button>`).join('')
        : '<span class="sn-linkpop-empty">No deleted variations</span>';
    };
    let t;
    q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 250); });
    q.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    list.addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-vid]');
      if (!b) return;
      try {
        const ctx = await sketchApi.restore(parseInt(b.dataset.vid, 10));
        insertVariation(ctx);
      } catch (err) { alert('Could not restore variation: ' + err.message); }
    });
    await load();
  };

  const renderPicker = async () => {
    pop.innerHTML = `
      <input type="text" class="sn-ins-q" placeholder="Search sketches…" autocomplete="off">
      <div class="sn-ins-list"><span class="sn-linkpop-empty">Loading…</span></div>`;
    const q = pop.querySelector('.sn-ins-q');
    const list = pop.querySelector('.sn-ins-list');
    q.focus();
    const load = async () => {
      let rows;
      try {
        rows = (await sketchApi.list(q.value.trim())).sketches || [];
      } catch (e) {
        list.innerHTML = '<span class="sn-linkpop-empty">Could not load sketches</span>';
        return;
      }
      list.innerHTML = rows.length
        ? rows.map(r => `
          <button type="button" data-vid="${r.sketch_id}">
            <span class="sn-ins-letter">${esc(letterOf(r.ordinal))}</span>
            <span class="sn-ins-preview">${esc(r.preview || '(empty)')}</span>
          </button>`).join('')
        : '<span class="sn-linkpop-empty">No sketches yet</span>';
    };
    let t;
    q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 250); });
    q.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    // Picking a source sketch mints a NEW sibling sketch directly (next letter,
    // text copied). No freeze dialog — the source is left as-is.
    list.addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-vid]');
      if (!b) return;
      try { insertVariation(await sketchApi.createFrom(parseInt(b.dataset.vid, 10))); }
      catch (err) { alert('Could not create sketch: ' + err.message); }
    });
    await load();
  };

  btn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    if (pop.hidden) {
      pop.hidden = false;
      renderRoot();
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
 * imageInput}. destroy() flushes any unsaved changes (doc AND variations).
 */
export async function createScratchpadEditor(els, scratchpadId) {
  const data = await fetchJSON(`api/scratchpads/${scratchpadId}`, {}, false);
  const pad = data.scratchpad;
  els.titleInput.value = pad.title;
  // Fresh per editor instance (the modal can open/close repeatedly).
  noteColorGroups.length = 0;
  closeNoteFloat();

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

  // Flush any widget textareas with unsaved variation text.
  const flushVariations = async () => {
    const results = await Promise.all([...variationFlushers].map(f => f().catch(() => false)));
    return results.every(Boolean);
  };

  const saveNow = async () => {
    if (!view) return false;
    clearTimeout(saveTimer);
    clearRetry();
    setSaveState('saving');
    const variationsOk = await flushVariations();
    try {
      const r = await fetch(`api/scratchpads/${scratchpadId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() },
        body: JSON.stringify({ title: els.titleInput.value, doc: view.state.doc.toJSON() }),
      });
      if (!r.ok) throw new Error(String(r.status));
      retryAttempt = 0;
      setSaveState('saved');
      return variationsOk;
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
    { snippetMenu: true },
    { sep: true, show: showInTable },
    { label: '+ Row', title: 'Add row below', run: addRowAfter, show: showInTable },
    { label: '− Row', title: 'Delete row', run: deleteRow, show: showInTable },
    { label: '+ Col', title: 'Add column right', run: addColumnAfter, show: showInTable },
    { label: '− Col', title: 'Delete column', run: deleteColumn, show: showInTable },
    { label: '✕ Table', title: 'Delete table', run: deleteTable, show: showInTable },
    { sep: true },
    { label: '↶', title: 'Undo', run: undo },
    { label: '↷', title: 'Redo', run: redo },
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
    if (it.snippetMenu) {
      buildSnippetMenu(els.toolbarEl, () => view);
      continue;
    }
    if (it.noteColors) {
      buildNoteColorBar(els.toolbarEl, () => view, dyn);
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
      noteRef: (node, v, getPos) => new NoteRefView(node, v, getPos),
    },
    dispatchTransaction(tr) {
      if (destroyed) return;
      const newState = view.state.apply(tr);
      view.updateState(newState);
      if (tr.docChanged) scheduleSave();
      updateToolbar();
    },
  });
  activeView = view;
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
    sketchApi,
    get view() { return view; },
    saveNow,
    // Programmatic inserts (tests / power use): create server-side, place.
    insertSnippet: async () => {
      const ctx = await sketchApi.createNew();
      insertBlockSafely(view.state, view.dispatch,
        schema.nodes.snippet.create({ variationId: ctx.sketch.sketch_id }));
      return ctx;
    },
    // Based-on: mint a new sibling sketch (next letter) and place it.
    insertSketchOf: async (sourceId) => {
      const ctx = await sketchApi.createFrom(sourceId);
      insertBlockSafely(view.state, view.dispatch,
        schema.nodes.snippet.create({ variationId: ctx.sketch.sketch_id }));
      // Existing siblings must show the new sketch in their tab bar now.
      const snippetId = (ctx.snippet && ctx.snippet.snippet_id)
        || (ctx.sketch && ctx.sketch.snippet_id);
      await refreshSnippetSiblings(snippetId, ctx.sketch.sketch_id);
      return ctx;
    },
    pm: { Selection, TextSelection, NodeSelection },
    isDirty: () => saveState !== 'saved' || dirtyVariations.size > 0,
    async destroy() {
      await flushVariations(); // best effort; the modal's guard already ran
      destroyed = true;
      clearTimeout(saveTimer);
      clearRetry();
      els.titleInput.removeEventListener('input', onTitleInput);
      els.imageInput.removeEventListener('change', onImage);
      if (saveState !== 'saved') await saveNow();
      closeNoteFloat();
      // Anchor NodeViews destroy() during view.destroy(); don't let that
      // soft-delete the notes (the doc persists them).
      editorTearingDown = true;
      if (activeView === view) activeView = null;
      view.destroy();
      editorTearingDown = false;
      view = null;
    },
  };
}
