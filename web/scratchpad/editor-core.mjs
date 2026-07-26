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

// Drop nodes this schema no longer understands: pre-variations snippet
// nodes ("book_content", or "snippet" with text-in-attrs and no
// variationId). The author deleted all snippets before the rearchitecture;
// this is a belt-and-suspenders guard so a stray legacy doc still opens.
function modernizeDoc(json) {
  const clean = (n) => {
    if (!n || typeof n !== 'object') return null;
    if (n.type === 'book_content') return null;
    if (n.type === 'snippet' && !(n.attrs && n.attrs.variationId > 0)) return null;
    if (Array.isArray(n.content)) {
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

export const variationApi = {
  context: (id) => fetchJSON(`api/variations/${id}`, {}, false),
  list: (q) => fetchJSON(`api/variations?q=${encodeURIComponent(q || '')}`, {}, false),
  createNew: () => apiCall('POST', 'api/snippets', { mode: 'new' }),
  createFrom: (sourceId, freeze) => apiCall('POST', 'api/snippets',
    { mode: 'variation', source_variation_id: sourceId, freeze_source: freeze }),
  saveText: (id, text) => apiCall('PUT', `api/variations/${id}`, { text }),
  freeze: (id, frozen) => apiCall('POST', `api/variations/${id}/freeze`, { frozen }),
  link: (snippetId, manuscriptId) => apiCall('PUT', `api/snippets/${snippetId}/link`, { manuscript_id: manuscriptId }),
  canonize: (id, manuscriptId) => apiCall('POST', `api/variations/${id}/canonize`, { manuscript_id: manuscriptId }),
};

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

function renderBookText(host, text) {
  const canon = window.WriteSysCanonicalize ? window.WriteSysCanonicalize.canonicalize : (t) => t;
  window.WriteSysScratchRender.renderText(host, canon(text));
}

class SnippetView {
  constructor(node, view, getPos) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;
    this.varId = node.attrs.variationId;
    this.dom = document.createElement('div');
    this.dom.className = 'sn-widget';
    this.dom.dataset.variationId = String(this.varId);
    this.dom.innerHTML = '<div class="sn-header"><span class="sn-status">Manuscript Snippet · loading…</span></div><div class="sn-body"></div>';
    this.tab = 'self';       // 'self' | 'canon' | other variationId (number)
    this.mode = 'preview';   // self tab only: 'preview' | 'edit'
    this.peerCache = {};     // variationId → context (parent/child tabs)
    this.dirty = false;
    this.flush = async () => true;
    this.load();
  }

  async load() {
    try {
      this.ctx = await variationApi.context(this.varId);
    } catch (e) {
      this.dom.innerHTML = `
        <div class="sn-header">
          <span class="sn-status">Manuscript Snippet · unavailable</span>
          <span class="sn-tabs"></span>
          <span class="sn-actions"><button type="button" data-act="remove" class="sn-trash" title="Remove widget">${TRASH_SVG}</button></span>
        </div>
        <div class="sn-body"><div class="sn-note"><span class="sn-error">Variation ${this.varId} could not be loaded (${esc(e.message)}).</span></div></div>`;
      this.dom.querySelector('[data-act="remove"]').addEventListener('click', () => this.removeWidget(true));
      return;
    }
    this.build();
  }

  async refresh(keepTab = true) {
    const tab = this.tab;
    this.peerCache = {};
    try {
      this.ctx = await variationApi.context(this.varId);
    } catch (e) { /* keep the stale view rather than blanking */ }
    if (!keepTab) this.tab = 'self';
    else this.tab = tab;
    this.build();
  }

  canonized() { return this.ctx.snippet.canon_variation_id > 0; }
  frozen() { return this.ctx.variation.frozen; }
  letter() { return letterOf(this.ctx.variation.ordinal); }

  // Tab model: parent (with lineage icon) → self → children → Canon (blue).
  tabDefs() {
    const defs = [];
    if (this.ctx.parent) {
      defs.push({ key: this.ctx.parent.variation_id, letter: letterOf(this.ctx.parent.ordinal), parent: true });
    }
    defs.push({ key: 'self', letter: this.letter(), self: true });
    for (const c of this.ctx.children) {
      defs.push({ key: c.variation_id, letter: letterOf(c.ordinal) });
    }
    if (this.canonized()) defs.push({ key: 'canon', letter: 'Canon', canon: true });
    return defs;
  }

  build() {
    const v = this.ctx.variation;
    const sn = this.ctx.snippet;
    this.dom.classList.toggle('sn-canon', this.canonized());
    const state = this.frozen() ? 'frozen' : 'draft';
    const status = `Manuscript Snippet · ${this.letter()} · ${state}`;
    const statusHint = `Variation ${this.letter()} of snippet #${sn.snippet_id}. ` +
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
        ? `<span class="sn-tab-more"><button type="button" class="sn-more-btn" title="More variations">▾</button><span class="sn-more-list" hidden>${overflow.map(d => this.tabButtonHTML(d)).join('')}</span></span>`
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
          <button type="button" data-act="remove" class="sn-trash" title="Remove widget (the variation itself is kept)">${TRASH_SVG}</button>
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
    const active = (d.self && this.tab === 'self') || (d.canon && this.tab === 'canon') || d.key === this.tab;
    const cls = ['sn-tab', active ? 'active' : '', d.canon ? 'sn-tab-canon' : '', d.parent ? 'sn-tab-parent' : ''].filter(Boolean).join(' ');
    const title = d.canon ? 'Canon — the version placed into the book'
      : d.parent ? `Variation ${d.letter} (parent — this one was based on it)`
      : d.self ? `Variation ${d.letter} (this widget)`
      : `Variation ${d.letter} (based on this one)`;
    return `<button type="button" data-tab="${d.self ? 'self' : (d.canon ? 'canon' : d.key)}" class="${cls}" title="${title}">${d.parent ? PARENT_SVG : ''}${esc(String(d.letter))}</button>`;
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
    if (this.tab === 'self') {
      return this.mode === 'edit' ? this.renderEdit() : this.renderSelfPreview();
    }
    if (this.tab === 'canon') return this.renderCanon(false);
    return this.renderPeer(this.tab);
  }

  renderSelfPreview() {
    this.ta = null;
    const frozen = this.frozen();
    this.body.innerHTML = `<div class="sn-render${frozen ? '' : ' sn-clickable'}" title="${frozen ? 'Frozen — unfreeze (snowflake) to edit' : 'Click to edit'}"></div>`;
    const host = this.body.firstChild;
    const text = this.ctx.variation.text;
    if (text.trim()) {
      renderBookText(host, text);
    } else {
      host.innerHTML = `<div class="sn-empty">${frozen ? 'Empty (frozen) variation.' : 'Empty variation — click to write.'}</div>`;
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
    ta.value = this.ctx.variation.text;
    ta.rows = Math.max(6, this.ctx.variation.text.split('\n').length + 2);
    let t = null;
    let saveAttempt = 0;
    let retryTimer = null;
    let countdown = null;
    const clearRetry = () => { clearTimeout(retryTimer); retryTimer = null; clearInterval(countdown); countdown = null; };
    const save = async () => {
      clearTimeout(t); clearRetry();
      if (ta.value === this.ctx.variation.text) { dirtyVariations.delete(this); this.saveEl.textContent = ''; return true; }
      this.saveEl.textContent = 'saving…';
      try {
        await variationApi.saveText(this.varId, ta.value);
        const changed = this.ctx.variation.text !== ta.value;
        this.ctx.variation.text = ta.value;
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
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    autoGrow();
  }

  async renderPeer(variationId) {
    this.body.innerHTML = '<div class="sn-note">Loading variation…</div>';
    let ctx = this.peerCache[variationId];
    if (!ctx) {
      try {
        ctx = this.peerCache[variationId] = await variationApi.context(variationId);
      } catch (e) {
        this.body.innerHTML = `<div class="sn-note"><span class="sn-error">Could not load variation (${esc(e.message)}).</span></div>`;
        return;
      }
    }
    if (this.tab !== variationId) return; // switched away while loading
    const rel = this.ctx.parent && this.ctx.parent.variation_id === variationId ? 'parent of' : 'based on';
    this.body.innerHTML = `
      <div class="sn-note">Variation ${esc(letterOf(ctx.variation.ordinal))} · ${ctx.variation.frozen ? 'frozen' : 'draft'} · ${rel} ${esc(this.letter())} — read-only here (it lives in its own widget).</div>
      <div class="sn-render"></div>`;
    const host = this.body.querySelector('.sn-render');
    if (ctx.variation.text.trim()) renderBookText(host, ctx.variation.text);
    else host.innerHTML = '<div class="sn-empty">Empty variation.</div>';
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
      await variationApi.freeze(this.varId, !this.frozen());
      await this.refresh();
    } catch (e) {
      alert('Could not toggle freeze: ' + e.message);
    }
  }

  async setLink(manuscriptId) {
    try {
      await variationApi.link(this.ctx.snippet.snippet_id, manuscriptId);
      await this.refresh();
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

  removeWidget(broken) {
    const pos = this.getPos();
    if (pos == null) return;
    const label = broken
      ? 'Remove this widget?'
      : `Remove this snippet widget from the scratchpad? Variation ${this.letter()} itself is kept — still reachable from its related variations.`;
    if (!window.confirm(label)) return;
    this.view.dispatch(this.view.state.tr.delete(pos, pos + this.node.nodeSize));
    this.view.focus();
  }

  update(node) {
    if (node.type !== this.node.type) return false;
    if (node.attrs.variationId !== this.varId) return false;
    this.node = node;
    return true;
  }

  destroy() {
    this.closeLinkPicker();
    variationFlushers.delete(this.flush);
    dirtyVariations.delete(this);
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
      schema.nodes.snippet.create({ variationId: ctx.variation.variation_id }));
    close();
    view.focus();
  };

  const renderRoot = () => {
    pop.innerHTML = `
      <button type="button" class="sn-ins-new">New snippet</button>
      <button type="button" class="sn-ins-based">Based on…</button>`;
    pop.querySelector('.sn-ins-new').addEventListener('click', async () => {
      try { insertVariation(await variationApi.createNew()); }
      catch (e) { alert('Could not create snippet: ' + e.message); }
    });
    pop.querySelector('.sn-ins-based').addEventListener('click', renderPicker);
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
          <button type="button" data-vid="${r.variation_id}" data-frozen="${r.frozen}">
            <span class="sn-ins-letter">${esc(letterOf(r.ordinal))}</span>
            <span class="sn-ins-preview">${esc(r.preview || '(empty)')}</span>
          </button>`).join('')
        : '<span class="sn-linkpop-empty">No variations yet</span>';
    };
    let t;
    q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 250); });
    q.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    list.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-vid]');
      if (!b) return;
      renderFreezeChoice(parseInt(b.dataset.vid, 10), b.dataset.frozen === 'true',
        b.querySelector('.sn-ins-letter').textContent);
    });
    await load();
  };

  const renderFreezeChoice = (sourceId, alreadyFrozen, letter) => {
    const create = async (freeze) => {
      try { insertVariation(await variationApi.createFrom(sourceId, freeze)); }
      catch (e) { alert('Could not create variation: ' + e.message); }
    };
    if (alreadyFrozen) { create(false); return; }
    pop.innerHTML = `
      <div class="sn-ins-ask">Freeze variation ${esc(letter)} (the source)? Frozen variations are read-only until unfrozen.</div>
      <button type="button" class="sn-ins-freeze">Freeze it</button>
      <button type="button" class="sn-ins-nofreeze">Keep it editable</button>`;
    pop.querySelector('.sn-ins-freeze').addEventListener('click', () => create(true));
    pop.querySelector('.sn-ins-nofreeze').addEventListener('click', () => create(false));
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
    variationApi,
    get view() { return view; },
    saveNow,
    // Programmatic inserts (tests / power use): create server-side, place.
    insertSnippet: async () => {
      const ctx = await variationApi.createNew();
      insertBlockSafely(view.state, view.dispatch,
        schema.nodes.snippet.create({ variationId: ctx.variation.variation_id }));
      return ctx;
    },
    insertVariationOf: async (sourceId, freezeSource) => {
      const ctx = await variationApi.createFrom(sourceId, !!freezeSource);
      insertBlockSafely(view.state, view.dispatch,
        schema.nodes.snippet.create({ variationId: ctx.variation.variation_id }));
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
      view.destroy();
      view = null;
    },
  };
}
