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
 */
import {
  Schema, Node as PMNode, Plugin,
  EditorState, NodeSelection, TextSelection, Selection,
  EditorView,
  keymap, history, undo, redo,
  baseKeymap, toggleMark, setBlockType, wrapIn, liftTarget, chainCommands,
  addListNodes, wrapInList, splitListItem, liftListItem, sinkListItem,
  dropCursor, gapCursor,
  tableNodes, tableEditing, columnResizing, goToNextCell,
  addRowAfter, deleteRow, addColumnAfter, deleteColumn, deleteTable,
} from './vendor/prosemirror.mjs';

const csrf = () => (localStorage.getItem('csrf_token') || sessionStorage.getItem('csrf_token')) || '';

// Save-failure status lines get a "log in" affordance when the failure is an
// expired session (401): clicking opens the app-wide re-login modal
// (session-guard.js) in place — no reload, pending saves then succeed on
// their normal retry tick.
function appendReloginLink(el) {
  if (!window.WriteSysSessionGuard) return;
  el.append(' · ');
  const a = document.createElement('a');
  a.href = '#';
  a.textContent = 'Session expired — log in';
  a.style.cssText = 'color:#a33;text-decoration:underline;cursor:pointer;';
  a.addEventListener('click', (e) => {
    e.preventDefault();
    window.WriteSysSessionGuard.requireLogin();
  });
  el.appendChild(a);
}

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
  // A sketch PLACEMENT (VARIATIONS_PLAN.md): atom marker for one variation.
  // All content/state lives server-side; the NodeView fetches its context.
  // LEGACY STORAGE NAME: the sketch widget's PM node is still typed
  // 'snippet' — every saved pad doc embeds it; renaming would break them.
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
//  - drop pre-variations sketch nodes ("book_content", or "snippet" without a
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
// several sketches targeting one book share fetches within a page.
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

// ------------------------------------------------------ variation API

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

// currentScratchpadId: the scratchpad a newly-created variation is homed in. The
// modal sets this when it opens a scratchpad (from #scratchpad=N).
let currentScratchpadId = 0;
export function setCurrentScratchpadId(id) { currentScratchpadId = id | 0; }

export const variationApi = {
  context: (id) => fetchJSON(`api/variations/${id}`, {}, false),
  list: (q) => fetchJSON(`api/variations?q=${encodeURIComponent(q || '')}`, {}, false),
  createNew: () => apiCall('POST', 'api/sketches', { mode: 'new', scratchpad_id: currentScratchpadId }),
  // Based on a source variation → a new sibling variation (next letter, text copied).
  // No source freezing; the source is left as-is.
  createFrom: (sourceId) => apiCall('POST', 'api/sketches',
    { mode: 'variation', source_variation_id: sourceId, scratchpad_id: currentScratchpadId }),
  // Next-letter variation seeded with raw text — "sketch from placed text".
  createFromText: (sketchId, text) => apiCall('POST', 'api/sketches',
    { mode: 'text', sketch_id: sketchId, text, scratchpad_id: currentScratchpadId }),
  // Suggestion PUT (the book's own primitive) — placement writes region
  // replacements through it, one reviewable suggestion per sentence.
  putSuggestion: (sentenceId, text) => apiCall('PUT', `api/sentences/${encodeURIComponent(sentenceId)}/suggestion`, { text }),
  saveText: (id, text) => apiCall('PUT', `api/variations/${id}`, { text }),
  // ONE lifecycle state (draft | frozen | superseded) — setting frozen or
  // superseded cancels the other (single column server-side).
  setState: (id, state) => apiCall('PUT', `api/variations/${id}/state`, { state }),
  freezeAll: (sketchId) => apiCall('POST', `api/sketches/${sketchId}/freeze-all`),
  link: (sketchId, manuscriptId) => apiCall('PUT', `api/sketches/${sketchId}/link`, { manuscript_id: manuscriptId }),
  canonize: (id, manuscriptId) => apiCall('POST', `api/variations/${id}/canonize`, { manuscript_id: manuscriptId }),
  softDelete: (id) => apiCall('DELETE', `api/variations/${id}`),
  restore: (id) => apiCall('POST', `api/variations/${id}/restore`),
  listDeleted: (q) => fetchJSON(`api/variations/deleted?q=${encodeURIComponent(q || '')}`, {}, false),
  home: (id) => fetchJSON(`api/variations/${id}/home`, {}, false),
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

// ----------------------------------------------------------- sketch view

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Tab-glyph overlay markup: shared with the suggest-edit modal (edit-pane.js).
const tabMarkupHTML = (value) => window.WriteSysEditPane.tabMarkupHTML(value);

// House icons from js/icons.js (same document — plain script, loads first).
const LINK_SVG = window.WriteSysIcons.link(11);
const TRASH_SVG = window.WriteSysIcons.trash(12);
const SNOW_SVG = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><path d="M8 1v14M1.9 4.5l12.2 7M14.1 4.5l-12.2 7M8 1l-1.8 1.8M8 1l1.8 1.8M8 15l-1.8-1.8M8 15l1.8-1.8M1.9 4.5l.6 2.4M1.9 4.5l2.4-.6M14.1 11.5l-.6-2.4M14.1 11.5l-2.4.6M14.1 4.5l-2.4-.6M14.1 4.5l-.6 2.4M1.9 11.5l2.4.6M1.9 11.5l.6-2.4"/></svg>';
// Superseded: a plain down arrow (reddens on hover / while set).
const DOWN_SVG = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3v9"/><path d="M4.5 8.5L8 12l3.5-3.5"/></svg>';
const COPY_SVG = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 3.5v-1c0-.55-.45-1-1-1H3.5c-.55 0-1 .45-1 1v6c0 .55.45 1 1 1h1"/></svg>';
// The placed pane's ↗: open the book at this group's region.
function openBookLink(sn) {
  if (!sn.linked_manuscript_id) return '';
  return `<a class="sn-open sn-open-icon" href="index.html?manuscript_id=${sn.linked_manuscript_id}#${encodeURIComponent(sn.sketch_id)}" title="Open in book">${GOTO_SVG}</a>`;
}
// Sparkles — "dazzling new": a new variation minted from this content.
const SPARK_SVG = '<svg width="13" height="13" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M8 1.6l1.35 3.45L12.8 6.4 9.35 7.75 8 11.2 6.65 7.75 3.2 6.4l3.45-1.35z"/><path d="M14.8 9.4l.85 2.15 2.15.85-2.15.85-.85 2.15-.85-2.15-2.15-.85 2.15-.85z"/><path d="M8.4 13.6l.65 1.65 1.65.65-1.65.65-.65 1.65-.65-1.65-1.65-.65 1.65-.65z"/></svg>';
const GOTO_SVG = '<svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 14L14 6M8.5 5.5H14.5V11.5"/></svg>';

// Clipboard sketch reference (the copy button on each widget writes this;
// the ⧉ Sketch ▾ → "From clipboard" option reads it back anywhere).
const VARIATION_REF_PREFIX = 'ms-variation:';
const parseVariationRef = (text) => {
  const m = /^\s*ms-variation:(\d+)\s*$/.exec(text || '');
  return m ? parseInt(m[1], 10) : null;
};
const PARENT_SVG = '<svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M8 13V3M4 7l4-4 4 4"/></svg>';


// Views with unsaved variation text register a flush here so the modal's
// close guard can flush (and refuse to close on failure). dirtyVariations
// mirrors which views still hold unsaved text — isDirty() consults it.
const variationFlushers = new Set();
const dirtyVariations = new Set();
// Every live SketchView, so a group-level change (e.g. linking a manuscript,
// which is a property of the sketch GROUP, not one variation) can refresh every
// sibling widget showing the same sketch — otherwise siblings hold a stale
// link chip (or a stale tab list) until the next reload.
const liveSketchViews = new Set();

// Refresh every EXISTING widget of the given sketch group except one (usually
// a just-created variation, which mounts fresh). Used after a group-level change so
// siblings pick it up immediately — e.g. a new related variation appearing in their
// tab bar, or a manuscript link updating their chip.
function refreshSketchSiblings(sketchId, exceptVariationId) {
  if (!sketchId) return;
  return Promise.all(Array.from(liveSketchViews)
    .filter(v => v.ctx && v.ctx.sketch && v.ctx.sketch.sketch_id === sketchId
      && v.variationId !== exceptVariationId)
    .map(v => v.refresh()));
}

function renderBookText(host, text) {
  const canon = window.WriteSysCanonicalize ? window.WriteSysCanonicalize.canonicalize : (t) => t;
  // A sketch is often a MID-CHAPTER excerpt, so a Tab typed at the very start
  // means "the first paragraph is indented". Normalize that leading \t to a
  // real \n\t marker — canonicalize preserves a single leading marker and the
  // renderer classes the paragraph 'indented' — instead of letting the prose
  // whitespace-trim eat it. Display-only: the stored variation text keeps the \t.
  let t = String(text == null ? '' : text);
  if (t.startsWith('\t')) t = '\n' + t;
  window.WriteSysScratchRender.renderText(host, canon(t));
}

// ---- Scroll flight recorder ------------------------------------------------
// Always-on ring buffer of scroll-relevant events in the pad. When the scroll
// JUMPS (>300px in one event), the whole buffer dumps to the console as
// [ms-scrolldiag] lines — copy-paste them into a bug report. Manual dump:
// window.msScrollDiag.dump(). Overhead is a few pushes per interaction.
const scrollDiag = {
  buf: [],
  t0: (typeof performance !== 'undefined' ? performance.now() : 0),
  host: null,
  push(kind, data) {
    this.buf.push({ t: Math.round(performance.now() - this.t0), kind, ...data });
    if (this.buf.length > 100) this.buf.shift();
  },
  el(e) {
    if (!e || !e.tagName) return String(e);
    const cls = String(e.className && e.className.baseVal !== undefined ? e.className.baseVal : e.className || '')
      .split(/\s+/).slice(0, 3).join('.');
    const w = e.closest && e.closest('.sn-widget');
    return e.tagName + (cls ? '.' + cls : '')
      + (e.dataset && e.dataset.noteId ? `[note=${e.dataset.noteId}]` : '')
      + (w ? `[widget=${w.dataset.variationId}]` : '');
  },
  state() {
    try {
      const v = activeView;
      const sel = v && v.state.selection.from;
      return {
        scrollTop: this.host ? Math.round(this.host.scrollTop) : null,
        selFrom: sel,
        docSize: v && v.state.doc.content.size,
        activeEl: this.el(document.activeElement),
        suspendLeft: Math.max(0, Math.round(holdSuspendUntil - performance.now())),
        holds: this.host && scrollHolds.has(this.host)
          ? { base: Math.round(scrollHolds.get(this.host).base), fns: scrollHolds.get(this.host).fns.length }
          : null,
      };
    } catch (e) { return { err: String(e) }; }
  },
  dump(reason) {
    /* eslint-disable no-console */
    console.log(`[ms-scrolldiag] ==== ${reason || 'manual dump'} ====`);
    console.log('[ms-scrolldiag] state ' + JSON.stringify(this.state()));
    this.buf.forEach((e) => console.log('[ms-scrolldiag] ' + JSON.stringify(e)));
    console.log(`[ms-scrolldiag] ==== end (${this.buf.length} events; copy everything above) ====`);
  },
  install(host) {
    if (this.host === host) return;
    this.host = host;
    this.buf = [];
    this.t0 = performance.now();
    let last = host.scrollTop;
    host.addEventListener('scroll', () => {
      const now = host.scrollTop;
      const d = now - last;
      this.push('scroll', { from: Math.round(last), to: Math.round(now) });
      const jumped = Math.abs(d) > 300;
      last = now;
      if (jumped) this.dump(`JUMP ${Math.round(d)}px`);
    });
    const overlay = host.closest('.spm-overlay') || host;
    overlay.addEventListener('mousedown', (e) => this.push('mousedown', { on: this.el(e.target) }), true);
    overlay.addEventListener('focusin', (e) => this.push('focusin', { on: this.el(e.target) }), true);
    overlay.addEventListener('focusout', (e) => this.push('focusout', { on: this.el(e.target) }), true);
    if (typeof window !== 'undefined') window.msScrollDiag = this;
  },
};

// ---- Shared scroll hold ----------------------------------------------------
// ONE pin per scroll host, shared by every widget that re-renders in the same
// window. Pinning raw scrollTop per-widget was wrong twice over: (a) when a
// widget ABOVE the viewport grows/shrinks (sibling refresh after a save), the
// content the reader is looking at shifts by the height delta even though
// scrollTop never changed — the "suddenly I'm at the top of the pad" jump —
// so the right target is base + Σ height-deltas of above-viewport widgets;
// (b) two widgets rebuilding concurrently each pinned their own snapshot and
// fought each other. holdScroll keeps one base and a list of delta functions,
// re-evaluated every frame, so late async growth (peer previews filling in
// after a fetch) is compensated for as long as any hold is active.
const scrollHolds = new Map(); // host → {base, fns, until, pin}
// While a DELIBERATE scroll is in progress (deep-link settle-scroll to a note,
// navigate-to-variation), holds must not fight it: suspended holds ABSORB the
// current position (rebase) instead of pinning, then defend the new position
// once the suspension lapses. Without this, widgets building during a pad open
// re-arm the hold and yank the settle-scroll back to the top — the deep-link
// "never lands on the note" regression.
let holdSuspendUntil = 0;
export function suspendScrollHolds(ms) {
  holdSuspendUntil = Math.max(holdSuspendUntil, performance.now() + ms);
  scrollDiag.push('suspend-holds', { ms });
}
function holdScroll(host, ms, deltaFn) {
  let h = scrollHolds.get(host);
  scrollDiag.push('hold', { fresh: !h, ms, delta: !!deltaFn, base: Math.round(h ? h.base : host.scrollTop) });
  if (!h) {
    h = { base: host.scrollTop, fns: [], until: 0 };
    h.sum = () => h.fns.reduce((s, f) => s + f(), 0);
    h.pin = () => {
      if (performance.now() < holdSuspendUntil) {
        h.base = host.scrollTop - h.sum(); // track, don't fight
        return;
      }
      const want = h.base + h.sum();
      if (host.scrollTop !== want) {
        scrollDiag.push('pin-fight', { from: Math.round(host.scrollTop), to: Math.round(want) });
        host.scrollTop = want;
      }
    };
    scrollHolds.set(host, h);
    host.addEventListener('scroll', h.pin, true);
    const step = () => {
      if (performance.now() > h.until) {
        scrollHolds.delete(host);
        host.removeEventListener('scroll', h.pin, true);
        return;
      }
      h.pin();
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  } else {
    // Re-arming an existing hold: adopt whatever position the page is at NOW
    // (a settle-scroll or the user may have moved since the hold was created)
    // rather than defending a stale base forever.
    h.base = host.scrollTop - h.sum();
  }
  h.until = Math.max(h.until, performance.now() + ms);
  if (deltaFn) h.fns.push(deltaFn);
}

class SketchView {
  constructor(node, view, getPos) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;
    this.variationId = node.attrs.variationId;
    this.dom = document.createElement('div');
    this.dom.className = 'sn-widget';
    this.dom.dataset.variationId = String(this.variationId); // PM node attr name; also the navigate-to-source target
    this.dom.innerHTML = '<div class="sn-header"><span class="sn-status">Sketch · loading…</span></div><div class="sn-body"></div>';
    this.compare = null;     // null | sibling variation_id (number) | 'canon'
    this.mode = 'preview';   // 'preview' | 'edit' (the SELF pane, split or not)
    this.peerCache = {};     // variationId → context (parent/child tabs)
    this.dirty = false;
    this.flush = async () => true;
    liveSketchViews.add(this);
    this.load();
  }

  async load() {
    try {
      this.ctx = await variationApi.context(this.variationId);
    } catch (e) {
      this.dom.innerHTML = `
        <div class="sn-header">
          <span class="sn-status">Sketch · unavailable</span>
          <span class="sn-save"></span>
          <span class="sn-actions"><button type="button" data-act="remove" class="sn-trash" title="Remove widget">${TRASH_SVG}</button></span>
        </div>
        <div class="sn-body"><div class="sn-note"><span class="sn-error">Variation ${this.variationId} could not be loaded (${esc(e.message)}).</span></div></div>`;
      this.dom.querySelector('[data-act="remove"]').addEventListener('click', () => this.removeWidget(true));
      return;
    }
    this.build();
  }

  async refresh() {
    const compare = this.compare;
    this.peerCache = {};
    try {
      this.ctx = await variationApi.context(this.variationId);
    } catch (e) { /* keep the stale view rather than blanking */ }
    // Keep the comparison open across a refresh — unless its target vanished.
    const still = compare === 'canon'
      ? this.canonized()
      : (this.ctx.siblings || []).some(x => x.variation_id === compare);
    this.compare = still ? compare : null;
    this.preserveScroll(() => this.build());
  }

  // The scrollable host for this widget (the modal body). Rebuilding the widget's
  // DOM, or focusing an element inside it, makes the browser re-anchor scroll and
  // jump — usually to the top of the widget. Everything that tears down and
  // rebuilds the widget (build/renderBody/setCompare/setVariationState) runs through
  // preserveScroll so the reader stays put. This is the single, root-cause fix
  // for "clicking a sketch scrolls me to the top."
  scrollHost() {
    return this.dom.closest('.spm-editor') || this.dom.closest('[data-scroll-host]') || null;
  }
  // Snapshot the reader's position, run fn (which may replace DOM / move focus
  // / grow a textarea), then hold it for a short window via the SHARED
  // holdScroll pin. If THIS widget sits entirely above the viewport, its height
  // change must move scrollTop with it (delta compensation) — otherwise the
  // content in view shifts by the delta and the reader lands somewhere earlier
  // in the pad. A visible widget contributes no delta: the reader is looking at
  // it, so plain position-hold is right.
  preserveScroll(fn) {
    const host = this.scrollHost();
    if (!host) return fn();
    const above = this.dom.getBoundingClientRect().bottom
      <= host.getBoundingClientRect().top + 1;
    const beforeH = this.dom.offsetHeight;
    const r = fn();
    holdScroll(host, 700, above ? () => this.dom.offsetHeight - beforeH : null);
    return r;
  }

  canonized() { return this.ctx.sketch.canon_variation_id > 0; }
  stateName() { return this.ctx.variation.state || 'draft'; }
  frozen() { return this.stateName() === 'frozen'; }
  superseded() { return this.stateName() === 'superseded'; }
  readonly() { return this.frozen() || this.superseded(); }
  letter() { return letterOf(this.ctx.variation.ordinal); }

  build() {
    const v = this.ctx.variation;
    const sn = this.ctx.sketch;
    // Identity for navigate-to-source: (sketch, ordinal). The global variation_id
    // stays as data-variation-id/data-variation-id for the PM node + back-compat.
    this.dom.dataset.sketchId = sn.sketch_id;
    if (v.ordinal != null) this.dom.dataset.ordinal = String(v.ordinal);
    this.dom.classList.toggle('sn-canon', this.canonized());
    this.dom.classList.toggle('sn-state-frozen', this.frozen());
    this.dom.classList.toggle('sn-state-superseded', this.superseded());
    const status = `Sketch ${this.letter()}`;
    const statusHint = `Variation ${this.letter()} of sketch #${sn.sketch_id}. ` +
      (this.frozen() ? 'Frozen: read-only until unfrozen (snowflake). '
        : this.superseded() ? 'Superseded: no longer the preferred variation — read-only until un-superseded (↓). '
        : 'Click the preview to edit. ') +
      `Created ${esc((v.created_at || '').slice(0, 10))}.`;

    // Link affordance (GROUP-level): THE shared manuscript chip
    // (js/manuscript-chip.js) — same component as the pad title bar and note
    // cards. Canon pins the link permanently (chip becomes read-only).
    const linkBit = '<span class="sn-linkslot"></span>';

    // (The open-in-book ↗ lives on the PLACED pane's header — renderCanon.)
    // Layout: main column (header + body) plus the letter RAIL down the right
    // edge — a symmetric "titlebar" whose top button is THIS variation's letter
    // (the upper-right corner identity), with every sibling below it and the
    // canon fleuron at the bottom. The widget always grows to fit the rail.
    // The header is TWO halves: the left half carries identity + the SELF
    // variation's actions; the right half is empty until a compare pane
    // opens, then it carries the COMPARED variation's actions — so each
    // action bar sits above the pane it applies to (the split header).
    this.dom.innerHTML = `
      <div class="sn-header${this.compare != null ? ' sn-head-split' : ''}">
        <div class="sn-head-left">
          <span class="sn-status${this.canonized() ? ' sn-canonized' : ''}" title="${statusHint}">${status}</span><span class="sn-topgap"></span>${linkBit}${this.canonized() ? '<span class="sn-placedmark" title="Placed in the manuscript">\u2766</span>' : ''}<span class="sn-save"></span>
          <span class="sn-actcluster">
            <span class="sn-actions sn-actions-main">
              <button type="button" data-act="remove" class="sn-trash" title="Delete this variation (recoverable via Restore&hellip;)">${TRASH_SVG}</button>
              <button type="button" data-act="supersede" class="sn-supersede${this.superseded() ? ' pressed' : ''}" title="${this.superseded() ? 'Superseded — click to un-supersede' : 'Supersede (mark no longer preferred; read-only)'}">${DOWN_SVG}</button>
              <button type="button" data-act="freeze" class="sn-freeze${this.frozen() ? ' pressed' : ''}" title="${this.frozen() ? 'Frozen — click to unfreeze' : 'Freeze (make read-only)'}">${SNOW_SVG}</button>
              <button type="button" data-act="copyref" class="sn-copyref" title="Copy sketch reference — start a related variation anywhere via ⧉ Sketch ▾ → From clipboard">${COPY_SVG}</button>
              <button type="button" data-act="branch" class="sn-branch" title="New variation based on this one">${SPARK_SVG}</button>
              ${this.canonized() && sn.linked_manuscript_id ? `<button type="button" data-act="place" class="sn-place" title="Place this variation into the manuscript — replaces the placed text, as suggested edits">❦</button>` : ''}
            </span>
            <span class="sn-act-label sn-selfletter st-${this.stateName()}" title="This widget is variation ${this.letter()}.">${esc(this.letter())}</span>
          </span>
        </div>
      </div>
      <div class="sn-cols">
        <div class="sn-main">
          <div class="sn-actionrow" style="display: none">
            <div class="sn-act-self"></div>
            <div class="sn-head-right"></div>
          </div>
          <div class="sn-body"></div>
        </div>
        <div class="sn-rail">${this.railHTML()}</div>
      </div>`;
    this.body = this.dom.querySelector('.sn-body');
    this.saveEl = this.dom.querySelector('.sn-save');

    this.dom.querySelectorAll('[data-compare]').forEach(btn => {
      btn.addEventListener('click', () => this.setCompare(
        btn.dataset.compare === 'canon' ? 'canon' : parseInt(btn.dataset.compare, 10)));
    });
    this.dom.querySelector('[data-act="remove"]').addEventListener('click', () => this.removeWidget(false));
    this.dom.querySelector('[data-act="freeze"]').addEventListener('click', () =>
      this.setVariationState(this.frozen() ? 'draft' : 'frozen'));
    this.dom.querySelector('[data-act="supersede"]').addEventListener('click', () =>
      this.setVariationState(this.superseded() ? 'draft' : 'superseded'));
    this.dom.querySelector('[data-act="branch"]').addEventListener('click', () => this.branchVariation(this.variationId));
    const placeBtn = this.dom.querySelector('[data-act="place"]');
    if (placeBtn) placeBtn.addEventListener('click', () => this.placeVariation(this.variationId));
    this.dom.querySelector('[data-act="copyref"]').addEventListener('click', async (e) => {
      const b = e.currentTarget;
      // The app's own record of the copy comes FIRST: some browsers
      // (Firefox in particular) later refuse the programmatic clipboard
      // READ in the ⧉ menu even though this WRITE succeeds — the menu
      // falls back to this record, so the flow works regardless.
      try { localStorage.setItem('ms_last_variation_ref', String(this.variationId)); } catch (_) { /* private mode */ }
      try {
        await navigator.clipboard.writeText(VARIATION_REF_PREFIX + this.variationId);
        b.classList.add('sn-copied');
        setTimeout(() => b.classList.remove('sn-copied'), 900);
      } catch (err) {
        // System clipboard refused — the in-app record above still makes
        // "From clipboard" work, so show the copied tick anyway.
        b.classList.add('sn-copied');
        setTimeout(() => b.classList.remove('sn-copied'), 900);
      }
    });
    // The sketch's NOTE square (026) — the exact component that fronts
    // highlighted text in the doc, minus the text — top-left, left of the
    // status word. Click opens the same note float. Green check once the
    // note (as a task) is completed.
    const noteInfo = this.ctx.note;
    if (noteInfo && window.WriteSysNoteWidget && window.WriteSysNoteWidget.buildNoteSquare) {
      const sq = window.WriteSysNoteWidget.buildNoteSquare({
        color: noteInfo.color,
        completed: !!noteInfo.completed,
        title: noteInfo.completed ? 'Sketch note — completed' : 'Sketch note — click to open',
        onClick: (a) => lockScratchpadScroll(() => openNoteFloatFor(noteInfo.note_id, a)),
      });
      sq.dataset.noteId = String(noteInfo.note_id);
      const statusEl = this.dom.querySelector('.sn-status');
      statusEl.parentNode.insertBefore(sq, statusEl);
      // Live recolor via the same registry the inline refs use.
      if (this._sqAdapter) unregisterNoteRefView(this._sqAdapter.noteId, this._sqAdapter);
      this._sqAdapter = {
        noteId: noteInfo.note_id,
        applyColor: (c) => { if (!sq.classList.contains('sn-note-done')) sq.className = 'sn-note-ref sn-note-solo color-' + (c || 'yellow'); },
      };
      registerNoteRefView(noteInfo.note_id, this._sqAdapter);
    }
    const linkSlot = this.dom.querySelector('.sn-linkslot');
    // Icon-only (the note bottom-row circle): the manuscript name reveals
    // on hover; clicking opens the picker (with the unlink row). Canonized
    // sketches have the link pinned — no picker at all.
    const chip = window.WriteSysManuscriptChip.build({
      linkedId: sn.linked_manuscript_id,
      linkedName: sn.linked_manuscript_name,
      circle: true,
      removable: !this.canonized(),
      onUnlink: this.canonized() ? null : () => this.setLink(0),
      onPick: this.canonized() ? null : (mid) => this.setLink(mid),
      extraClass: 'sn-linkchip', // context hook (tests count these)
    });
    if (chip) linkSlot.appendChild(chip);
    this.renderBody();
  }

  // The right-edge rail: self letter (top, inert identity), siblings below
  // (click = split-compare, colored by state), canon fleuron at the bottom.
  railHTML() {
    const btns = [];
    // Split open → the self letter travels to the LEFT pane's upper-right
    // corner (renderBody mounts it) and the sibling buttons shift up to
    // take its place; unsplit → self letter tops the rail as usual.
    const lastPlaced = this.ctx.sketch.placed_from_variation_id || 0;
    // The self letter never rides the rail — it sits plain in the top bar
    // (single pane) or on the left pane's corner (split).
    const others = (this.ctx.siblings || []).filter(x => x.variation_id !== this.variationId);
    for (const x of others) {
      const st = x.state || 'draft';
      const stNote = st === 'superseded' ? ' (superseded)' : st === 'frozen' ? ' (frozen)' : '';
      btns.push(`<button type="button" data-compare="${x.variation_id}" class="sn-rail-btn sn-rail-peer st-${st}${this.compare === x.variation_id ? ' active' : ''}${x.variation_id === lastPlaced ? ' sn-last-placed' : ''}" title="Compare to variation ${letterOf(x.ordinal)}.${stNote}${x.variation_id === lastPlaced ? ' (Last placed.)' : ''}">${esc(letterOf(x.ordinal))}</button>`);
    }
    if (this.canonized()) {
      btns.push(`<button type="button" data-compare="canon" class="sn-rail-btn sn-rail-canon${this.compare === 'canon' ? ' active' : ''}" title="The placed text — live from the book.">❦</button>`);
    }
    return btns.join('');
  }

  // Toggle the split-compare: same target closes it, another target swaps the
  // right half. The self pane (left) is untouched — same subcomponent, still
  // editable — so comparing never loses your place or your edit.
  setCompare(key) {
    this.compare = this.compare === key ? null : key;
    this.renderRail();
    this.renderBody();
  }

  // (Re)build the rail and bind its compare buttons — needed whenever the
  // rail's composition changes (split open/close moves the self letter).
  renderRail() {
    const rail = this.dom.querySelector('.sn-rail');
    if (!rail) return;
    rail.innerHTML = this.railHTML();
    rail.querySelectorAll('[data-compare]').forEach(btn => {
      btn.addEventListener('click', () => this.setCompare(
        btn.dataset.compare === 'canon' ? 'canon' : parseInt(btn.dataset.compare, 10)));
    });
  }

  renderBody() {
    // All body re-renders (enter edit, blur→preview, open/close compare)
    // replace DOM and may move focus; preserve the reader's scroll position so
    // none of them jump the pad to the top of the widget.
    return this.preserveScroll(() => {
      // Toolbar split: single pane keeps the actions in the full-width top
      // bar; a compare open moves them into the LEFT half of the action row
      // (physically relocating the node — handlers ride along) and the
      // RIGHT half hosts the compared pane's actions. The top bar keeps
      // only identity (note square, SKETCH X, link, save).
      const head = this.dom.querySelector('.sn-header');
      const headRight = this.dom.querySelector('.sn-actionrow .sn-head-right');
      const row = this.dom.querySelector('.sn-actionrow');
      // The action CLUSTER (buttons + pane label) is ONE node that moves
      // between the top bar (single pane) and the left half-toolbar
      // (split) — one component, so the two states can never diverge.
      // Move ONLY on an actual side change: a re-insert detaches it
      // mid-gesture and swallows in-flight clicks.
      const cluster = this.dom.querySelector('.sn-actcluster');
      if (headRight) {
        headRight.innerHTML = '';
        head.classList.toggle('sn-head-split', this.compare != null);
        if (row && cluster) {
          if (this.compare != null) {
            row.style.display = 'flex';
            const half = this.dom.querySelector('.sn-act-self');
            if (cluster.parentNode !== half) half.appendChild(cluster);
          } else {
            row.style.display = 'none';
            const headLeft = this.dom.querySelector('.sn-head-left');
            if (cluster.parentNode !== headLeft) headLeft.appendChild(cluster);
          }
        }
      }
      if (this.compare == null) {
        this.selfHost = this.body;
        this.body.innerHTML = '';
        return this.mode === 'edit' ? this.renderEdit() : this.renderSelfPreview();
      }
      // Split: LEFT = self (same subcomponent as unsplit — preview or edit),
      // RIGHT = the comparison target, read-only on a disabled background.
      this.body.innerHTML = `
        <div class="sn-split">
          <div class="sn-split-left"></div>
          <div class="sn-split-right"></div>
        </div>`;
      this.selfHost = this.body.querySelector('.sn-split-left');
      if (this.mode === 'edit') this.renderEdit(); else this.renderSelfPreview();
      const right = this.body.querySelector('.sn-split-right');
      if (this.compare === 'canon') this.renderCanon(false, right);
      else this.renderComparePeer(this.compare, right);
    });
  }

  renderSelfPreview() {
    this.ta = null;
    const target = this.selfHost || this.body;
    const ro = this.readonly();
    const roCls = this.frozen() ? ' sn-frozen' : this.superseded() ? ' sn-superseded' : ' sn-clickable';
    const roTitle = this.frozen() ? 'Frozen — unfreeze (snowflake) to edit'
      : this.superseded() ? 'Superseded — un-supersede (↓) to edit'
      : 'Click to edit';
    target.innerHTML = `<div class="sn-render${roCls}" title="${roTitle}"></div>`;
    const host = target.firstChild;
    const text = this.ctx.variation.text;
    if (text.trim()) {
      renderBookText(host, text);
    } else {
      host.innerHTML = `<div class="sn-empty">${ro ? `Empty (${this.stateName()}) variation.` : 'Click to write.'}</div>`;
    }
    // Swallow mousedown: in FIREFOX the native mousedown on a non-editable
    // island inside the contenteditable pad moves/reveals the DOM selection —
    // when ProseMirror's selection sits far away (doc start after wheel-only
    // scrolling), that reveal SCROLLS THE PAD TO THE TOP on the click that was
    // meant to start editing. preventDefault stops the native caret/selection
    // work; the click still fires and enters edit, which focuses the textarea
    // itself. (Same trick the compare peer pane uses.)
    host.addEventListener('mousedown', (e) => { e.preventDefault(); });
    host.addEventListener('click', (e) => {
      if (!this.readonly()) {
        // Anchor the CLICK POINT across the serif→mono switch: the two render
        // the same text at very different heights (mono wraps more), so a
        // scrollTop pin alone lets the clicked word drift thousands of px on
        // a long sketch. Remember the clicked SENTENCE'S TEXT (found again in
        // the raw text by normalized search — immune to smartquotes, markdown
        // markers and \n\t vs \n\n paragraph styles, which broke an earlier
        // paragraph-index mapping) + how far into it, + the viewport y.
        this._editAnchor = { y: e.clientY, f: null, needle: null, plen: 0, pf: 0 };
        const bodyR = host.getBoundingClientRect();
        this._editAnchor.f = (e.clientY - bodyR.top) / Math.max(1, bodyR.height);
        const path = e.composedPath ? e.composedPath() : [];
        const el = path.find((n) => n && n.nodeType === 1
          && ((n.classList && n.classList.contains('sentence')) || n.tagName === 'P'));
        if (el) {
          // Needle = the text AROUND the clicked line (fraction into the
          // element × its length), so the restored offset needs no
          // interpolation across long sentences.
          const txt = el.textContent || '';
          const pr = el.getBoundingClientRect();
          const pf = (e.clientY - pr.top) / Math.max(1, pr.height);
          const k = Math.max(0, Math.min(Math.round(pf * txt.length), txt.length));
          const start = Math.max(0, k - 60);
          this._editAnchor.needle = txt.slice(start, k + 60);
          this._editAnchor.mid = k - start;
        }
        this.mode = 'edit';
        this.renderBody();
        return;
      }
      // Read-only states open the raw source in a non-editable mono pane
      // (copy-paste), keeping the state's disabled background.
      this.mountReadonlyMono(host, this.ctx.variation.text,
        this.frozen() ? 'sn-frozen' : 'sn-superseded',
        () => this.renderSelfPreview());
    });
  }

  renderEdit() {
    const target = this.selfHost || this.body;
    target.innerHTML = '';
    // FIREFOX: ProseMirror's stored selection fights the widget's textarea.
    // Two observed failure modes, same root:
    //  - a fresh insert leaves a NodeSelection on this widget → the caret
    //    freezes (clicks yanked back);
    //  - the selection sits far away (e.g. doc START when the reader scrolled
    //    down without clicking prose) → entering edit makes Firefox restore/
    //    reveal that faraway DOM selection and the pad JUMPS TO THE TOP —
    //    the long-standing "scroll up on click" bug.
    // Park the PM selection just after this node, ALWAYS, before wiring the
    // editor: adjacent selection = nothing to scroll to, nothing to fight.
    const pos = this.getPos();
    if (pos != null) {
      this.view.dispatch(this.view.state.tr.setSelection(
        TextSelection.near(this.view.state.doc.resolve(pos + this.node.nodeSize), 1)));
    }
    // LOCAL DRAFT RESTORE: if a newer-than-server draft survives in
    // localStorage (saves were failing when the widget last lived — CSRF
    // skew, expiry, crash, reload), seed the editor with IT, not the stale
    // server text, and let the autosaver push it up immediately.
    const draftKey = `ms-draft-variation-${this.variationId}`;
    const draft = window.WriteSysEditPane.readDraft(draftKey);
    const serverText = this.ctx.variation.text;
    const restored = !!(draft && draft.t !== serverText
      && draft.at > Date.parse(this.ctx.variation.updated_at || 0));
    // The SHARED edit-pane machinery (edit-pane.js) — same autosave/debounce,
    // retry ladder, dirty tracking and auto-grow as the suggest-edit modal.
    const pane = window.WriteSysEditPane.createMonoEditor({
      value: restored ? draft.t : serverText,
      placeholder: 'Sketch in .manuscript form — plain text, *italics*, \\n\\n section breaks, commands allowed. Place from the book view (+ between paragraphs).',
      // Mirror the text into the overlay, rendering each tab as a faint grey
      // → glyph so invisible whitespace is visible. Everything else is neutral
      // (the textarea's own text sits transparent on top).
      overlayHTML: tabMarkupHTML,
      onInput: () => saver.poke(),
    });
    const ta = pane.textarea;
    const saver = window.WriteSysEditPane.createAutosaver({
      initialValue: serverText, // server truth — a restored draft counts as dirty
      draftKey,
      getValue: () => ta.value,
      save: (text) => variationApi.saveText(this.variationId, text),
      statusEl: this.saveEl,
      onDirty: (d) => { if (d) dirtyVariations.add(this); else dirtyVariations.delete(this); },
      onSaved: (text, changed) => {
        this.ctx.variation.text = text;
        // Blur may have flipped to preview before this save resolved —
        // re-render so the preview shows what was just saved.
        if (changed && this.mode === 'preview') this.renderBody();
      },
      // Frozen/superseded underneath us (another widget/tab) — surface it.
      onFatal: (e) => (e.status === 409 ? 'frozen — not saved' : null),
    });
    // Exactly ONE flusher per view at a time. renderEdit() runs on every
    // enter-edit / compare-toggle / rebuild, each wiring a fresh autosaver that
    // holds its OWN snapshot of the text. Without removing the previous one,
    // stale closures accumulate in variationFlushers, and the next doc-save
    // fires ALL of them at once — a race where an OLD snapshot can land last and
    // clobber current work (data-loss bug). Drop this view's prior flusher first.
    if (this.flush) variationFlushers.delete(this.flush);
    // Kill the REPLACED pane's autosaver outright: a pending debounce or
    // retry timer from it would fire later holding the detached textarea's
    // OLD text and overwrite newer saves (the stale-save family, again).
    if (this._saver) this._saver.destroy();
    this._saver = saver;
    this.flush = saver.flush;
    variationFlushers.add(saver.flush);
    ta.addEventListener('blur', () => {
      saver.flush();
      if (this.mode === 'edit') { this.mode = 'preview'; this.renderBody(); }
    });

    // Literal .manuscript editing: Tab inserts a real \t at the caret (so a
    // "\n\t" paragraph break is typeable) instead of moving focus. Shift-Tab
    // still escapes the field so the author is never trapped.
    ta.addEventListener('keydown', (e) => {
      // Escape exits the sketch edit ONLY — stopPropagation so the modal's
      // document-level Escape handler doesn't also close the whole pad.
      if (e.key === 'Escape') { e.stopPropagation(); ta.blur(); return; }
      if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        pane.insertAtCaret('\t');
      }
    });

    target.appendChild(pane.wrap);
    this.ta = ta;
    // preventScroll: focusing the textarea would otherwise scroll it into view
    // (jumping to the top of the sketch) — the main "click-to-edit scrolls me
    // up" trigger. preserveScroll (around renderBody) is the backstop.
    ta.focus({ preventScroll: true });
    pane.autoGrow();
    // Land where the reader CLICKED: map the clicked paragraph (+ fraction
    // into it) to a character offset in the raw text, put the caret there
    // (not at the end — a caret-reveal at the end would scroll away), and
    // shift the scroll so that spot sits at the SAME viewport y as the click.
    const a = this._editAnchor;
    this._editAnchor = null;
    let caret = ta.value.length;
    if (a) {
      const host = this.scrollHost();
      const overlay = pane.wrap.querySelector('.sn-text-overlay');
      let targetY = null;
      if (a.needle) {
        // Repeated phrases: prefer the occurrence nearest the click's
        // proportional position in the text.
        const hint = (a.f || 0) * ta.value.length;
        const rawStart = findNormalized(ta.value, a.needle, hint);
        if (rawStart >= 0) {
          caret = Math.min(rawStart + (a.mid || 0), ta.value.length);
          targetY = overlayYAtOffset(overlay, caret);
        }
      }
      if (targetY == null && a.f != null) {
        const r = pane.wrap.getBoundingClientRect();
        targetY = r.top + a.f * r.height;
      }
      if (host && targetY != null && Number.isFinite(targetY)) {
        host.scrollTop += targetY - a.y;
        // Re-arm the shared pin so it defends the ADJUSTED position (a fresh
        // or re-armed hold adopts the current scrollTop).
        holdScroll(host, 700, null);
      }
    }
    ta.setSelectionRange(caret, caret);
    if (restored) {
      this.saveEl.textContent = 'restored unsaved draft';
      saver.poke(); // push the recovered text up as soon as saves work
    }
  }

  // The RIGHT HALF of a split-compare: a sibling variation, read-only on a
  // disabled background, with a mini header naming it and linking to its
  // home widget.
  async renderComparePeer(variationId, pane) {
    pane.innerHTML = '<div class="sn-note">Loading variation…</div>';
    let ctx = this.peerCache[variationId];
    if (!ctx) {
      try {
        ctx = this.peerCache[variationId] = await variationApi.context(variationId);
      } catch (e) {
        pane.innerHTML = `<div class="sn-note"><span class="sn-error">Could not load variation (${esc(e.message)}).</span></div>`;
        return;
      }
    }
    if (this.compare !== variationId || !pane.isConnected) return; // switched away while loading
    const st = ctx.variation.state || 'draft';
    pane.innerHTML = '<div class="sn-render sn-peer"></div>';
    // No visible header names the peer — keep its identity inspectable.
    pane.dataset.ordinal = String(ctx.variation.ordinal);
    const sketchId = ctx.variation.sketch_id;
    const ordinal = ctx.variation.ordinal;
    // The split header's RIGHT half: this pane's own actions — go-to-source
    // (the ↗), supersede, freeze, copy reference. No trash (deleting a
    // variation belongs to its own widget).
    const headRight = this.dom.querySelector('.sn-head-right');
    if (headRight) {
      headRight.innerHTML = `
        <span class="sn-actions">
          <button type="button" data-act="peer-goto" class="sn-goto-ext" title="Go to source">${GOTO_SVG}</button>
          <button type="button" data-act="peer-branch" class="sn-branch" title="New variation based on this one">${SPARK_SVG}</button>
          ${this.canonized() && this.ctx.sketch.linked_manuscript_id ? `<button type="button" data-act="peer-place" class="sn-place" title="Place this variation into the manuscript — replaces the placed text, as suggested edits">❦</button>` : ''}
          <button type="button" data-act="peer-supersede" class="sn-supersede${st === 'superseded' ? ' pressed' : ''}" title="${st === 'superseded' ? 'Superseded — click to un-supersede' : 'Supersede (mark no longer preferred; read-only)'}">${DOWN_SVG}</button>
          <button type="button" data-act="peer-freeze" class="sn-freeze${st === 'frozen' ? ' pressed' : ''}" title="${st === 'frozen' ? 'Frozen — click to unfreeze' : 'Freeze (make read-only)'}">${SNOW_SVG}</button>
          <button type="button" data-act="peer-copyref" class="sn-copyref" title="Copy sketch reference — start a related variation anywhere via ⧉ Sketch ▾ → From clipboard">${COPY_SVG}</button>
        </span><span class="sn-act-label st-${st}" title="This pane is variation ${esc(letterOf(ctx.variation.ordinal))}.">${esc(letterOf(ctx.variation.ordinal))}</span>`;
      headRight.querySelector('[data-act="peer-goto"]').addEventListener('click', () =>
        this.gotoVariationSource(variationId, sketchId, ordinal));
      headRight.querySelector('[data-act="peer-branch"]').addEventListener('click', () => this.branchVariation(variationId));
      const peerPlace = headRight.querySelector('[data-act="peer-place"]');
      if (peerPlace) peerPlace.addEventListener('click', () => this.placeVariation(variationId));
      const applyPeerState = async (state) => {
        try {
          await variationApi.setState(variationId, state);
          await this.refresh(); // clears peerCache; keeps the compare open
          await refreshSketchSiblings(sketchId, this.variationId);
        } catch (e) { alert('Could not update variation state: ' + e.message); }
      };
      headRight.querySelector('[data-act="peer-supersede"]').addEventListener('click', () =>
        applyPeerState(st === 'superseded' ? 'draft' : 'superseded'));
      headRight.querySelector('[data-act="peer-freeze"]').addEventListener('click', () =>
        applyPeerState(st === 'frozen' ? 'draft' : 'frozen'));
      headRight.querySelector('[data-act="peer-copyref"]').addEventListener('click', async (e) => {
        const b = e.currentTarget;
        try { localStorage.setItem('ms_last_variation_ref', String(variationId)); } catch (_) { /* private mode */ }
        try { await navigator.clipboard.writeText(VARIATION_REF_PREFIX + variationId); } catch (_) { /* in-app record suffices */ }
        b.classList.add('sn-copied');
        setTimeout(() => b.classList.remove('sn-copied'), 900);
      });
    }
    const host = pane.querySelector('.sn-render');
    // Stop mousedown from REACHING ProseMirror (which would move the PM
    // selection and scroll the pad) but let the browser's default run — that
    // default is what starts a native text selection, so the read-only pane
    // stays selectable/copyable.
    host.addEventListener('mousedown', (e) => { e.stopPropagation(); });
    // Click → raw source in a read-only mono pane (easy copy-paste).
    host.addEventListener('click', () =>
      this.mountReadonlyMono(host, ctx.variation.text, 'sn-peer-ro',
        () => this.renderComparePeer(variationId, pane)));
    if (ctx.variation.text.trim()) renderBookText(host, ctx.variation.text);
    else host.innerHTML = '<div class="sn-empty">Empty variation.</div>';
  }

  // Read-only MONOSPACE view of a pane (clicking any read-only render):
  // the raw .manuscript source in the editor's mono look, selectable and
  // copyable, but NOT editable — readOnly textarea, the pane's disabled
  // background kept, no blinking caret (caret-color: transparent). Blur
  // returns to the rendered view.
  mountReadonlyMono(host, text, extraClass, onBack) {
    const ta = document.createElement('textarea');
    ta.className = 'sn-text sn-mono-ro' + (extraClass ? ' ' + extraClass : '');
    ta.readOnly = true;
    ta.spellcheck = false;
    ta.value = text;
    ta.addEventListener('mousedown', (e) => { e.stopPropagation(); });
    ta.addEventListener('blur', () => onBack());
    host.replaceWith(ta);
    ta.style.height = 'auto';
    ta.style.height = Math.max(60, ta.scrollHeight) + 'px';
    ta.focus({ preventScroll: true });
    return ta;
  }

  // New variation BASED ON an existing one (the branch icon): next letter,
  // text copied, widget inserted right after this one.
  async branchVariation(sourceId) {
    try {
      const ctx = await variationApi.createFrom(sourceId);
      const pos = this.getPos();
      if (pos != null) {
        this.view.dispatch(this.view.state.tr.insert(pos + this.node.nodeSize,
          this.view.state.schema.nodes.snippet.create({ variationId: ctx.variation.variation_id })));
      }
      await this.refresh();
      await refreshSketchSiblings(this.ctx.sketch.sketch_id, this.variationId);
    } catch (e) {
      alert('Could not create the variation: ' + e.message);
    }
  }

  // PLACE a variation into the manuscript (the canonize rethink): replace
  // the text between the group's &sketch anchors with this variation's
  // text — one reviewable suggested edit per affected sentence — then let
  // the server refresh the "as placed" snapshot and the last-placed marker.
  async placeVariation(variationId) {
    const sn = this.ctx.sketch;
    if (!sn.canon_variation_id || !sn.linked_manuscript_id) return;
    try {
      // Always a FRESH context: the widget's cached text can lag behind
      // API-side edits, and placing stale text would be silent data loss.
      const varCtx = await variationApi.context(variationId);
      const text = varCtx.variation.text.replace(/\s+$/, '');
      // SMART per-sentence plan (server-side, the migration pipeline's own
      // aligner): unchanged sentences untouched, changed ones get real
      // reviewable diffs, removals/additions in order — instead of the old
      // whole-text-on-opener + blanket-delete plan.
      let planEdits = null;
      try {
        const r = await fetch(`api/sketches/${encodeURIComponent(sn.sketch_id)}/place-plan`, {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() },
          body: JSON.stringify({ manuscript_id: sn.linked_manuscript_id, text }),
        });
        if (r.ok) {
          const d = await r.json();
          if (d.status === 'ok') planEdits = (d.plan || []).map((p) => ({ id: p.sentence_id, text: p.text }));
        }
      } catch (e) { /* legacy fallback below */ }
      if (!planEdits) {
        const data = await bookData.load(sn.linked_manuscript_id, true);
        const plan = window.WriteSysRegion.replacePlan(
          data.sentences, data.sugMap, sn.sketch_id, window.WriteSysCommand, text);
        if (plan.status !== 'ok') {
          alert(`Could not find the placed region #${sn.sketch_id} in the manuscript (${plan.status}).`);
          return;
        }
        planEdits = plan.plan;
      }
      for (const p of planEdits) await variationApi.putSuggestion(p.id, p.text);
      await variationApi.canonize(variationId, sn.linked_manuscript_id);
      delete bookData.cache[sn.linked_manuscript_id]; // region content changed
      await this.refresh();
      await refreshSketchSiblings(sn.sketch_id, this.variationId);
    } catch (e) {
      alert('Could not place the variation: ' + e.message);
    }
  }

  // Navigate to a variation's home widget: ask the server which scratchpad hosts
  // it, then set the URL hash to open that scratchpad and scroll to the widget.
  // Identity is (sketch, ordinal) — NOT the global variation_id — so the URL is
  // human-readable and stable: #scratchpad=N&sketch=ID&variation=<ordinal>.
  async gotoVariationSource(variationId, sketchId, ordinal) {
    let spID = 0;
    try { spID = (await variationApi.home(variationId)).scratchpad_id | 0; } catch (e) { /* fall through */ }
    if (spID > 0) {
      window.location.hash = `#scratchpad=${spID}&sketch=${encodeURIComponent(sketchId)}&variation=${ordinal}`;
    } else {
      alert('That variation has no home scratchpad on record yet.');
    }
  }

  // Canon truth derives from the manuscript (VARIATIONS_PLAN §2): resolve
  // the &snippet#id … &end#id region (legacy syntax name) from the effective manuscript; the
  // canon variation's text is the immutable as-canonized snapshot, used as
  // fallback and via the in-body toggle.
  async renderCanon(showSnapshot, pane) {
    const sn = this.ctx.sketch;
    // The placed pane's one action: start a NEW variation seeded with the
    // live placed text — edit what's in the book without touching it.
    const headRight = this.dom.querySelector('.sn-head-right');
    if (headRight && !headRight.childElementCount) {
      headRight.innerHTML = `<span class="sn-actions">${openBookLink(sn)}<button type="button" data-act="from-placed" class="sn-branch sn-from-placed" title="New variation from the placed text — start editing what's in the book">${SPARK_SVG}</button></span><span class="sn-act-label sn-act-label-gilt" title="The placed text.">\u2766</span>`;
      headRight.querySelector('[data-act="from-placed"]').addEventListener('click', async () => {
        try {
          const data = await bookData.load(sn.linked_manuscript_id, true);
          const seed = window.WriteSysRegion.regionRawText(
            data.sentences, data.sugMap, sn.sketch_id, window.WriteSysCommand, null);
          if (seed == null) { alert('Could not resolve the placed region.'); return; }
          const ctx = await variationApi.createFromText(sn.sketch_id, seed);
          const pos = this.getPos();
          if (pos != null) {
            this.view.dispatch(this.view.state.tr.insert(pos + this.node.nodeSize,
              this.view.state.schema.nodes.snippet.create({ variationId: ctx.variation.variation_id })));
          }
          await this.refresh();
        } catch (e) { alert('Could not sketch from the placed text: ' + e.message); }
      });
    }
    // NO explanatory bar: the live render IS the placed truth (the
    // manuscript is the source of truth — nothing else to explain). There
    // is no snapshot to fall back to (the placed variation itself is the
    // record) — a resolution failure shows an ERROR, never a stale text.
    pane.innerHTML = '<div class="sn-render sn-peer"></div>';
    const host = pane.querySelector('.sn-render');
    const anomaly = (msg) => {
      const note = document.createElement('div');
      note.className = 'sn-note';
      note.innerHTML = `<span class="sn-error">${msg}</span>`;
      pane.insertBefore(note, host);
    };
    try {
      const canon = window.WriteSysCanonicalize ? window.WriteSysCanonicalize.canonicalize : (t) => t;
      let data = await bookData.load(sn.linked_manuscript_id, false);
      let res = window.WriteSysRegion.resolve(data.sentences, data.sugMap, sn.sketch_id, window.WriteSysCommand, canon);
      if (res.status !== 'ok') {
        // The cache may predate the placement (a pad open while the region
        // was suggested elsewhere) — retry ONCE with fresh book data
        // before declaring the region missing.
        data = await bookData.load(sn.linked_manuscript_id, true);
        res = window.WriteSysRegion.resolve(data.sentences, data.sugMap, sn.sketch_id, window.WriteSysCommand, canon);
      }
      if (this.compare !== 'canon' || !pane.isConnected) return;
      if (res.status !== 'ok') {
        anomaly(`Region #${esc(sn.sketch_id)} ${res.status === 'missing-anchor'
          ? 'not found in the effective manuscript' : 'has no matching &amp;end'}.`);
        return;
      }
      window.WriteSysScratchRender.render(host, res.items);
    } catch (e) {
      anomaly(`Could not load manuscript ${sn.linked_manuscript_id} (${esc(e.message)}).`);
    }
  }

  async setVariationState(state) {
    try {
      await variationApi.setState(this.variationId, state);
      await this.refresh();
      // Sibling rails color-code THIS variation's state — update them live.
      await refreshSketchSiblings(this.ctx.sketch.sketch_id, this.variationId);
    } catch (e) {
      alert('Could not update variation state: ' + e.message);
    }
  }

  async setLink(manuscriptId) {
    const sketchId = this.ctx.sketch.sketch_id;
    try {
      await variationApi.link(sketchId, manuscriptId);
      // The link belongs to the sketch GROUP: refresh every live widget of
      // this sketch (including this one) so their chips update now, not only
      // after a reload.
      await refreshSketchSiblings(sketchId, null);
    } catch (e) {
      alert('Could not update link: ' + e.message);
    }
  }

  async removeWidget(broken) {
    const pos = this.getPos();
    if (pos == null) return;
    const label = broken
      ? 'Remove this widget?'
      : `Delete variation ${this.letter()}? It's soft-deleted — bring it back any time via the ⧉ Sketch ▾ menu → Restore…`;
    if (!window.confirm(label)) return;
    // Soft-delete the variation first (a broken widget has no live variation to
    // delete). If the delete fails, keep the widget so nothing is lost.
    if (!broken && this.variationId) {
      try {
        await variationApi.softDelete(this.variationId);
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
    if (node.attrs.variationId !== this.variationId) return false;
    this.node = node;
    return true;
  }

  destroy() {
    if (this._sqAdapter) unregisterNoteRefView(this._sqAdapter.noteId, this._sqAdapter);
    if (this._saver) this._saver.destroy();
    variationFlushers.delete(this.flush);
    dirtyVariations.delete(this);
    liveSketchViews.delete(this);
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

// LOCK the scratchpad's scroll position for a short window while `fn` runs. The
// note-float open is ASYNC (awaits a fetch) and ProseMirror may re-anchor the
// editor scroll a few frames later when a click lands on an atom node — a
// one-shot restore misses that. So we pin .spm-editor's scrollTop: any scroll in
// the next ~450ms is forced back to the snapshot, then we release. This is the
// deterministic root fix for "clicking the note jumps to the top."
// Viewport y of character `offset` inside the edit pane's mirror overlay
// (identical metrics to the textarea — see .sn-text/.sn-text-overlay). Walks
// the overlay's text nodes accumulating lengths; null when unmappable.
// Find rendered text inside raw text, tolerating the render's cosmetic
// transforms (smartquotes, stripped markdown markers, collapsed structural
// whitespace): both sides normalize to lowercase alphanumerics + single
// spaces, and an index map converts the match back to a RAW offset. -1 when
// not found.
function findNormalized(raw, needle, hintOffset) {
  const norm = (str, withIdx) => {
    const chars = [];
    const idx = withIdx ? [] : null;
    let lastSpace = true;
    for (let i = 0; i < str.length; i++) {
      const c = str[i].toLowerCase();
      if (c >= 'a' && c <= 'z' || c >= '0' && c <= '9') {
        chars.push(c);
        if (idx) idx.push(i);
        lastSpace = false;
      } else if (!lastSpace) {
        chars.push(' ');
        if (idx) idx.push(i);
        lastSpace = true;
      }
    }
    return { str: chars.join(''), idx };
  };
  const hay = norm(raw, true);
  const need = norm(needle, false).str.trim();
  if (!need) return -1;
  // All occurrences; pick the one closest to the caller's position hint
  // (prose repeats — a first-match rule anchored to the wrong copy).
  let best = -1;
  let bestDist = Infinity;
  let pos = hay.str.indexOf(need);
  while (pos >= 0) {
    const rawPos = hay.idx[pos];
    const dist = hintOffset == null ? 0 : Math.abs(rawPos - hintOffset);
    if (dist < bestDist) { bestDist = dist; best = rawPos; }
    if (hintOffset == null) break;
    pos = hay.str.indexOf(need, pos + 1);
  }
  return best;
}

function overlayYAtOffset(overlay, offset) {
  if (!overlay) return null;
  try {
    const walker = document.createTreeWalker(overlay, NodeFilter.SHOW_TEXT);
    let acc = 0;
    let node;
    while ((node = walker.nextNode())) {
      const len = node.textContent.length;
      if (acc + len >= offset) {
        const range = document.createRange();
        const local = Math.max(0, Math.min(offset - acc, len));
        range.setStart(node, local);
        range.setEnd(node, Math.min(local + 1, len));
        const r = range.getBoundingClientRect();
        return r.height > 0 || r.top !== 0 ? r.top : null;
      }
      acc += len;
    }
  } catch (e) { /* geometry race */ }
  return null;
}

function lockScratchpadScroll(fn) {
  const host = activeView && activeView.dom.closest('.spm-editor');
  if (!host) return fn();
  holdScroll(host, 450, null); // shared pin — composes with widget height deltas
  return fn();
}

// ---- Client note cache -----------------------------------------------------
// The doc stores only note_id + text; the COLOR (and body/tags/priority/flag)
// live on the note row. This cache holds the note data so the NoteRefView can
// render the right color WITHOUT a color in the doc, and so recolor is a pure
// note-row update. Keyed by note_id → { color, body, priority, task_type, impact, blocked, tags }.
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
      const cached = { color: n.color, body: n.body, priority: n.priority, task_type: n.task_type || '', impact: n.impact || 'n/a', blocked: !!n.blocked, tags: n.tags || [], manuscript_id: n.manuscript_id || null, manuscript_name: n.manuscript_name || '', sketch_id: n.sketch_id || null };
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
  // Seed the cache incl. any manuscript INHERITED from a linked pad (the server
  // returns it), so the float that opens right now shows the manuscript chip
  // without waiting for a re-fetch.
  noteCache.set(noteId, {
    color, body, priority: 'none', task_type: '', impact: 'n/a', blocked: false, tags: [],
    manuscript_id: created.manuscript_id || null,
    manuscript_name: created.manuscript_name || '',
  });
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
// The ref wrapped the originally-highlighted text (stored in attrs.text), so we
// REPLACE the ref with that text — the words come back as plain prose, exactly
// where they were (no gap, so no space-collapsing needed).
function removeNoteFromDoc(noteId) {
  const view = activeView; if (!view) return false;
  const sc = view.state.schema;
  const found = [];
  view.state.doc.descendants((node, pos) => {
    if (node.type === sc.nodes.noteRef && node.attrs.noteId === noteId) {
      found.push([pos, pos + node.nodeSize, node.attrs.text || '']);
    }
  });
  if (!found.length) return false;
  let tr = view.state.tr;
  // Right-to-left so earlier positions stay valid as we edit.
  found.sort((a, b) => b[0] - a[0]).forEach(([a, b, text]) => {
    tr = text
      ? tr.replaceWith(a, b, sc.text(text)) // restore the original highlighted text
      : tr.delete(a, b);                    // no snapshot → just remove the atom
  });
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
const TRASH_SVG_NOTE = window.WriteSysIcons.trashStroke(12);

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
    this.dom.title = 'Note — click to open';
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
    // Clicking anywhere on the ref (the square OR the highlighted text) opens
    // the note — the whole thing reads as one affordance. The trash is excluded
    // (handled below). Fully swallow the pointer sequence so ProseMirror never
    // processes a click on this atom (which would move the selection and scroll
    // .spm-editor to it — the "jumps to the top on click" bug): preventDefault +
    // stopPropagation on BOTH mousedown and click, plus a lock-the-scroll guard
    // across the async float open (the open awaits a fetch, so a one-shot
    // restore isn't enough).
    const swallow = (e) => { e.preventDefault(); e.stopPropagation(); };
    this.dom.addEventListener('mousedown', (e) => {
      if (e.target.closest('.sn-note-ref-trash')) return; // trash has its own handler
      swallow(e);
      lockScratchpadScroll(() => openNoteFloatFor(this.noteId, this.dom));
    });
    this.dom.addEventListener('click', (e) => {
      if (e.target.closest('.sn-note-ref-trash')) return;
      swallow(e);
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
  // WITHOUT update(), ProseMirror destroys+recreates this view on ANY redraw
  // of its region — e.g. typing in the same paragraph — and destroy() was
  // soft-deleting the note while its ref was still in the doc. Notes died
  // silently all week (the recreated view kept rendering the ref, so nothing
  // looked wrong). Accept same-note updates so the view is REUSED.
  update(node) {
    if (node.type !== this.node.type) return false;
    if (node.attrs.noteId !== this.noteId) return false;
    this.node = node;
    this.dom.querySelector('.sn-note-ref-text').textContent = node.attrs.text;
    return true;
  }
  destroy() {
    unregisterNoteRefView(this.noteId, this);
    if (editorTearingDown || suppressNoteDelete.has(this.noteId) || !window.WriteSysNoteAPI || !this.noteId) return;
    // Defense in depth: even when destroy fires, only soft-delete if the ref
    // is GENUINELY gone from the doc after this transaction settles — a
    // recreated view (any future update()-miss) must never kill a live note.
    const noteId = this.noteId;
    setTimeout(() => {
      if (editorTearingDown) return;
      const view = activeView;
      let still = false;
      if (view) {
        view.state.doc.descendants((n) => {
          if (still) return false;
          if (n.type.name === 'noteRef' && n.attrs.noteId === noteId) { still = true; return false; }
        });
      }
      if (!still) window.WriteSysNoteAPI.remove(noteId).catch(() => {});
    }, 0);
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
      && !(e.target.closest && e.target.closest('.sn-note-ref'))
      // The manuscript picker is a body-level popover that logically belongs to
      // the float — clicking in it must not close the float.
      && !(e.target.closest && e.target.closest('.note-linkpop'))) {
    closeNoteFloat();
  }
}

// Open the floating note for a note id, positioned below `anchorEl`. Fetches the
// CURRENT note (body/color/tags) so the reopened float always shows saved data.
// Flip every solo square of this note (sketch widget corners) to the
// green-check completed state.
function markSketchSquaresCompleted(noteId) {
  document.querySelectorAll(`.sn-note-solo[data-note-id="${noteId}"]`).forEach((el) => {
    const fresh = window.WriteSysNoteWidget.buildNoteSquare({
      completed: true, title: 'Sketch note — completed', onClick: (a) => lockScratchpadScroll(() => openNoteFloatFor(noteId, a)),
    });
    fresh.dataset.noteId = String(noteId);
    el.replaceWith(fresh);
  });
}

async function openNoteFloatFor(noteId, anchorEl) {
  closeNoteFloat();
  if (!window.WriteSysNoteWidget || !window.WriteSysNoteAPI) return;
  const api = window.WriteSysNoteAPI;
  const fetched = await ensureNoteCached(noteId);
  const cached = fetched || noteCache.get(noteId) || { color: noteColorOf(noteId), body: null, priority: 'none', task_type: '', impact: 'n/a', blocked: false, tags: [] };
  const note = {
    noteId, note_id: noteId,
    color: cached.color, body: cached.body,
    priority: cached.priority || 'none',
    task_type: cached.task_type || '', impact: cached.impact || 'n/a', blocked: !!cached.blocked,
    tags: cached.tags || [],
    manuscript_id: cached.manuscript_id || null, manuscript_name: cached.manuscript_name || '',
    sketch_id: cached.sketch_id || null,
  };
  const isSketchNote = !!note.sketch_id;
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
    onDims: (patch) => {
      Object.assign(note, patch); Object.assign(cached, patch);
      api.update(noteId, patch).catch(() => {});
      window.WriteSysNoteWidget.updateDims(float.firstChild, note);
    },
    // A sketch's note can't be deleted (it lives with the sketch); its
    // completion greys the widget square to a green check instead of
    // dissolving a doc ref. Scoring is the same everywhere.
    onDelete: isSketchNote ? null : (() => { deleteNoteViaDoc(noteId); }),
    onComplete: () => {
      api.complete(noteId);
      if (isSketchNote) { cached.completed = true; markSketchSquaresCompleted(noteId); }
      else removeNoteRefNoDelete(noteId);
      closeNoteFloat();
    },
    onScorePoints: (points) => { api.scorePoints(noteId, points).catch(() => {}); },
    // Handlers just mutate note.*; the shared widget re-renders the chips.
    onAddTag: async (name) => { try { const r = await api.addTag(noteId, name); note.tags = (r && r.tags) || note.tags; cached.tags = note.tags; } catch (e) {} },
    onRemoveTag: async (tagId) => { try { await api.removeTag(noteId, tagId); note.tags = (note.tags || []).filter(t => t.tag_id !== tagId); cached.tags = note.tags; } catch (e) {} },
    onLinkManuscript: async (mid) => { try { const r = await api.linkManuscript(noteId, mid); note.manuscript_id = r.manuscript_id || null; note.manuscript_name = r.manuscript_name || ''; } catch (e) {} },
    onUnlinkManuscript: async () => { try { await api.linkManuscript(noteId, 0); note.manuscript_id = null; note.manuscript_name = ''; } catch (e) {} },
  }, { showDelete: !isSketchNote });
  float.appendChild(widget);
  document.body.appendChild(float);
  openNoteFloat = float;
  const r = anchorEl.getBoundingClientRect();
  float.style.position = 'absolute';
  float.style.top = (window.scrollY + r.bottom + 6) + 'px';
  float.style.left = (window.scrollX + r.left) + 'px';
  // buildNoteElement auto-sized the textarea while it was still DETACHED (so
  // scrollHeight was 0 and it clipped to min-height) — re-size now that it's in
  // the DOM so the full body shows (matches the manuscript margin).
  const ta = float.querySelector('.note-input');
  if (ta) { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; }
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

function inBlockquote(state) {
  const $from = state.selection.$from;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type === schema.nodes.blockquote) return true;
  }
  return false;
}

// Blockquote is a toggle: inside a quote the button lifts one level out
// (wrapIn alone would stack quote-in-quote on every press); outside, it wraps.
function toggleBlockquote(state, dispatch) {
  const { $from, $to } = state.selection;
  const range = $from.blockRange($to, n => n.type === schema.nodes.blockquote);
  if (range) {
    const target = liftTarget(range);
    if (target == null) return false;
    if (dispatch) dispatch(state.tr.lift(range, target).scrollIntoView());
    return true;
  }
  return wrapIn(schema.nodes.blockquote)(state, dispatch);
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

// The ⧉ Sketch ▾ menu: New sketch, or Based on… (variation picker sorted
// by variation updated_at, then a freeze-the-source choice).
function buildSketchMenu(toolbarEl, getView) {
  const wrap = document.createElement('span');
  wrap.className = 'tb-tablewrap';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sn-btn';
  btn.title = 'Insert a Manuscript Sketch (new, or a variation based on an existing one)';
  btn.textContent = '⧉ Sketch ▾';
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
      schema.nodes.snippet.create({ variationId: ctx.variation.variation_id }));
    close();
    view.focus();
    // A new sibling changes the group's variation list, so every EXISTING widget of
    // the same sketch must refresh to show the new one in its tab bar (the new
    // widget just mounted fresh with the full list). Without this, related
    // widgets don't get the new tab until a reload.
    const sketchId = (ctx.sketch && ctx.sketch.sketch_id)
      || (ctx.variation && ctx.variation.sketch_id);
    refreshSketchSiblings(sketchId, ctx.variation.variation_id);
  };

  const renderRoot = () => {
    pop.innerHTML = `
      <button type="button" class="sn-ins-new">New sketch</button>
      <button type="button" class="sn-ins-based">Related to…</button>
      <button type="button" class="sn-ins-clip" disabled title="Copy a sketch reference first (the copy button on a sketch widget)">From clipboard</button>
      <button type="button" class="sn-ins-restore">Restore…</button>`;
    pop.querySelector('.sn-ins-new').addEventListener('click', async () => {
      try { insertVariation(await variationApi.createNew()); }
      catch (e) { alert('Could not create sketch: ' + e.message); }
    });
    pop.querySelector('.sn-ins-based').addEventListener('click', renderPicker);
    pop.querySelector('.sn-ins-restore').addEventListener('click', renderRestore);
    // "From clipboard" lights up only when the clipboard holds a VALID
    // sketch reference (copied via a widget's copy button) — parsed, then
    // confirmed against the API so a stale/foreign id stays disabled.
    // The check is async (clipboard read + API confirm) — spin while it
    // runs so the disabled state doesn't read as final.
    (async () => {
      const clipBtn = pop.querySelector('.sn-ins-clip');
      const spin = document.createElement('span');
      spin.className = 'sn-clip-spin';
      clipBtn.appendChild(spin);
      try {
        let id = null;
        let clipboardReadable = true;
        try {
          // Race the read against a short timeout: Firefox sometimes leaves
          // readText() PENDING (its paste prompt waiting for attention)
          // rather than rejecting — without the race the button would sit
          // disabled forever on the first menu open.
          id = parseVariationRef(await Promise.race([
            navigator.clipboard.readText(),
            new Promise((_, rej) => setTimeout(() => rej(new Error('clipboard timeout')), 700)),
          ]));
        } catch (_) {
          clipboardReadable = false; // refused OR still pending — same treatment
        }
        // Fallback ONLY when the clipboard couldn't be read at all: use the
        // app's record of the last copy-button press. A READABLE clipboard
        // holding something else means the user copied other content since —
        // respect that and stay disabled.
        if (id == null && !clipboardReadable) {
          id = parseInt(localStorage.getItem('ms_last_variation_ref') || '', 10) || null;
        }
        if (id == null) return;
        const ctx = await variationApi.context(id);
        if (!clipBtn.isConnected) return; // menu re-rendered/closed meanwhile
        const preview = ((ctx.variation && ctx.variation.text) || '').trim().slice(0, 40);
        clipBtn.disabled = false;
        clipBtn.title = `New variation related to the copied one${preview ? `: “${preview}”` : ''}`;
        clipBtn.addEventListener('click', async () => {
          try { insertVariation(await variationApi.createFrom(id)); }
          catch (err) { alert('Could not create variation: ' + err.message); }
        });
      } catch (_) { /* no clipboard access or invalid reference — stays disabled */ }
      finally { spin.remove(); }
    })();
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
        rows = (await variationApi.listDeleted(q.value.trim())).variations || [];
      } catch (e) {
        list.innerHTML = '<span class="sn-linkpop-empty">Could not load deleted variations</span>';
        return;
      }
      list.innerHTML = rows.length
        ? rows.map(r => `
          <button type="button" data-vid="${r.variation_id}">
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
        const ctx = await variationApi.restore(parseInt(b.dataset.vid, 10));
        insertVariation(ctx);
      } catch (err) { alert('Could not restore variation: ' + err.message); }
    });
    await load();
  };

  const renderPicker = async () => {
    pop.innerHTML = `
      <input type="text" class="sn-ins-q" placeholder="Search variations…" autocomplete="off">
      <div class="sn-ins-list"><span class="sn-linkpop-empty">Loading…</span></div>`;
    const q = pop.querySelector('.sn-ins-q');
    const list = pop.querySelector('.sn-ins-list');
    q.focus();
    const load = async () => {
      let rows;
      try {
        rows = (await variationApi.list(q.value.trim())).variations || [];
      } catch (e) {
        list.innerHTML = '<span class="sn-linkpop-empty">Could not load variations</span>';
        return;
      }
      list.innerHTML = rows.length
        ? rows.map(r => `
          <button type="button" data-vid="${r.variation_id}">
            <span class="sn-ins-letter">${esc(letterOf(r.ordinal))}</span>
            <span class="sn-ins-preview">${esc(r.preview || '(empty)')}</span>
          </button>`).join('')
        : '<span class="sn-linkpop-empty">No variations yet</span>';
    };
    let t;
    q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 250); });
    q.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    // Picking a source variation mints a NEW sibling variation directly (next letter,
    // text copied). No freeze dialog — the source is left as-is.
    list.addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-vid]');
      if (!b) return;
      try { insertVariation(await variationApi.createFrom(parseInt(b.dataset.vid, 10))); }
      catch (err) { alert('Could not create variation: ' + err.message); }
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

  const scheduleRetry = (authFail) => {
    clearRetry();
    retryAttempt = Math.min(retryAttempt + 1, 6);
    let secs = Math.min(60, Math.pow(2, retryAttempt)); // 2, 4, 8, …, 60
    const show = () => {
      els.statusEl.textContent = `Failed to save. Trying again in ${secs}s`;
      if (authFail) appendReloginLink(els.statusEl);
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
      if (!r.ok) {
        const err = new Error(String(r.status));
        err.status = r.status;
        throw err;
      }
      retryAttempt = 0;
      setSaveState('saved');
      return variationsOk;
    } catch (e) {
      console.error('autosave failed', e);
      saveState = 'unsaved';
      if (!destroyed) scheduleRetry(e.status === 401);
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
      label: 'H' + l, title: `Heading ${l} (Ctrl+Alt+${l})`,
      // TOGGLE: clicking the active heading reverts to a paragraph
      // (plain setBlockType is a no-op on an already-set heading — the
      // "can't unselect H2" trap).
      run: (s, d) => headingActive(s, l)
        ? setBlockType(schema.nodes.paragraph)(s, d)
        : setBlockType(schema.nodes.heading, { level: l })(s, d),
      active: s => headingActive(s, l),
    })),
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
  // Alt+D: type today's date ("Saturday, August 1") at the cursor.
  const insertDate = (state, dispatch) => {
    if (dispatch) {
      dispatch(state.tr.insertText(window.WriteSysEditPane.dateString()).scrollIntoView());
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
      // Breathing-room guarantee: every WIDGET (sketch) is followed by a
      // TEXTBLOCK, and the doc ends with a paragraph. Two consecutive
      // widgets left nowhere to click a caret between them (the gap cursor
      // is undiscoverable) — so any edit that leaves a widget butted against
      // another widget (or the doc edge) gets an empty paragraph inserted
      // after it. Same rule the doc bottom always had, generalized.
      new Plugin({
        appendTransaction(trs, _old, newState) {
          if (!trs.some(tr => tr.docChanged)) return null;
          const { doc, schema: sc } = newState;
          const inserts = [];
          doc.forEach((node, offset, index) => {
            if (node.type !== sc.nodes.snippet) return;
            const next = doc.maybeChild(index + 1);
            if (!next || next.type === sc.nodes.snippet) {
              inserts.push(offset + node.nodeSize);
            }
          });
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
      if (tr.docChanged) scheduleSave();
      updateToolbar();
    },
  });
  activeView = view;
  const diagHost = view.dom.closest('.spm-editor');
  if (diagHost) scrollDiag.install(diagHost);
  // Docs SAVED with a trailing sketch/table/image predate the trailing-node
  // plugin (which only runs on edits) — normalize once at open.
  {
    const doc0 = view.state.doc;
    const inserts0 = [];
    doc0.forEach((node, offset, index) => {
      if (node.type !== schema.nodes.snippet) return;
      const next = doc0.maybeChild(index + 1);
      if (!next || next.type === schema.nodes.snippet) inserts0.push(offset + node.nodeSize);
    });
    if (!doc0.lastChild || doc0.lastChild.type !== schema.nodes.paragraph) {
      if (!inserts0.includes(doc0.content.size)) inserts0.push(doc0.content.size);
    }
    if (inserts0.length) {
      let tr0 = view.state.tr;
      inserts0.sort((a, b) => b - a).forEach((pos) => {
        tr0 = tr0.insert(pos, schema.nodes.paragraph.create());
      });
      view.dispatch(tr0);
    }
  }
  updateToolbar();
  setSaveState('saved');

  const onTitleInput = () => scheduleSave();
  els.titleInput.addEventListener('input', onTitleInput);
  // After an in-place re-login (session-guard.js), don't sit out the rest of
  // the retry backoff — flush everything unsaved right away.
  const onSessionRestored = () => {
    if (saveState !== 'saved' || dirtyVariations.size > 0) saveNow();
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
    isDirty: () => saveState !== 'saved' || dirtyVariations.size > 0,
    async destroy() {
      await flushVariations(); // best effort; the modal's guard already ran
      destroyed = true;
      clearTimeout(saveTimer);
      clearRetry();
      els.titleInput.removeEventListener('input', onTitleInput);
      els.imageInput.removeEventListener('change', onImage);
      document.removeEventListener('ms:session-restored', onSessionRestored);
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
