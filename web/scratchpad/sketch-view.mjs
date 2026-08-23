/**
 * SketchView (split out of editor-core.mjs — CODE_REVIEW_AUG_2026.md §1): the
 * NodeView for the sketch PLACEMENT atom (PM node type 'snippet' — legacy
 * storage name, frozen), plus its registries (variationFlushers /
 * dirtyVariations / liveSketchViews), sibling refresh, the book-pipeline
 * preview renderer, and the small shared formatters (esc, letterOf,
 * parseVariationRef) its widgets and the menus share.
 */
import { TextSelection } from './vendor/prosemirror.mjs';
import { csrf, variationApi, bookData } from './api.mjs?v=1';
import { holdScroll } from './scroll.mjs?v=1';
import {
  lockScratchpadScroll, openNoteFloatFor,
  registerNoteRefView, unregisterNoteRefView,
  findNormalized, overlayYAtOffset,
} from './pad-notes.mjs?v=1';

// letterOf(1) = 'A' — the SHARED formatter (edit-pane.js), re-exported for
// this module's importers. import-scratchpad.js (classic script) uses the
// same one, so widget rails and the book-side picker can never drift.
export const letterOf = (ordinal) => window.WriteSysEditPane.letterOf(ordinal);

// ----------------------------------------------------------- sketch view

export const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Tab-glyph overlay markup: shared with the suggest-edit modal (edit-pane.js).
const tabMarkupHTML = (value) => window.WriteSysEditPane.tabMarkupHTML(value);

// House icons from js/icons.js (same document — plain script). Deref at
// CALL time, not module-eval time — the module-eval deref was a load-order
// bomb (CODE_REVIEW_AUG_2026.md §1.1, fixed with the split).
const LINK_SVG = () => window.WriteSysIcons.link(11);
const TRASH_SVG = () => window.WriteSysIcons.trash(12);
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
export const parseVariationRef = (text) => {
  const m = /^\s*ms-variation:(\d+)\s*$/.exec(text || '');
  return m ? parseInt(m[1], 10) : null;
};
// THE copy-reference wiring (self header + compare-pane header). The app's
// own record of the copy comes FIRST: some browsers (Firefox in particular)
// later refuse the programmatic clipboard READ in the ⧉ menu even though
// this WRITE succeeds — the menu falls back to this record, so the flow
// works regardless; the copied tick shows either way.
const PARENT_SVG = '<svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M8 13V3M4 7l4-4 4 4"/></svg>';


// Views with unsaved variation text register a flush here so the modal's
// close guard can flush (and refuse to close on failure). dirtyVariations
// mirrors which views still hold unsaved text — isDirty() consults it.
export const variationFlushers = new Set();
export const dirtyVariations = new Set();
// Every live SketchView, so a group-level change (e.g. linking a manuscript,
// which is a property of the sketch GROUP, not one variation) can refresh every
// sibling widget showing the same sketch — otherwise siblings hold a stale
// link chip (or a stale tab list) until the next reload.
const liveSketchViews = new Set();

// Refresh every EXISTING widget of the given sketch group except one (usually
// a just-created variation, which mounts fresh). Used after a group-level change so
// siblings pick it up immediately — e.g. a new related variation appearing in their
// tab bar, or a manuscript link updating their chip.
export function refreshSketchSiblings(sketchId, exceptVariationId) {
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

export class SketchView {
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
          <span class="sn-actions"><button type="button" data-act="remove" class="sn-trash" title="Remove widget">${TRASH_SVG()}</button></span>
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
  // rebuilds the widget (build/renderBody/setCompare/applyState) runs through
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

    // The SHARED pane-widget shell (js/pane-widget.js, window global): the
    // LEFT pane is SELF — its rail carries this variation's identity letter
    // (the old upper-right corner letter, now in rail position). The RIGHT
    // pane is the peers — siblings + the canon fleuron — collapsed to just
    // its rail until a peer is clicked (the split-compare). Actions are
    // icon DEFINITIONS; the shell places them (header while collapsed,
    // per-pane action rows when split) and colors STATE buttons
    // (freeze-blue, supersede-red) — the old relocating .sn-actcluster and
    // .sn-head-right machinery is gone.
    this.dom.innerHTML = '';
    this.w = window.WriteSysPaneWidget.create({
      className: 'sk-widget',
      headerHTML: `<span class="sn-status${this.canonized() ? ' sn-canonized' : ''}" title="${statusHint}">${status}</span><span class="sn-topgap"></span>${linkBit}${this.canonized() ? '<span class="sn-placedmark" title="Placed in the manuscript">\u2766</span>' : ''}`,
      left: {
        rail: () => [{
          key: 'self',
          label: this.letter(),
          className: 'sn-rail-self st-' + this.stateName(),
          color: this.stateColor(this.stateName()),
          title: `This widget is variation ${this.letter()}.`,
        }],
        actions: () => this.selfActionDefs(),
      },
      right: {
        rail: () => this.peerEntries(),
        onChange: (key) => { this.compare = key; this.renderBody(); },
        actions: (key) => this.peerActionDefs(key),
        openByDefault: false,
      },
      // ‹ i/n › across the pad's sketch widgets — flip and flash.
      nav: {
        info: () => this.padNavInfo(),
        prev: () => this.padNav(-1),
        next: () => this.padNav(+1),
      },
    });
    if (this.compare != null) this.w.rightKey = this.compare; // refresh() keeps an open compare
    this.dom.appendChild(this.w.el);
    this.body = this.w.leftContent;
    this.saveEl = this.dom.querySelector('.sn-save');
    this.w.refresh();
    // Sibling widgets' ‹ i/n › counts include this newcomer — refresh them
    // (cheap: the shell signature-diffs, only the nav text changes).
    for (const v of liveSketchViews) {
      if (v !== this && v.w) v.w.refresh();
    }

    this.dom.querySelector('[data-act="remove"]')?.addEventListener('click', () => this.removeWidget(false));
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

  // Rail + action DEFINITIONS for the shared shell (pane-widget.js) —
  // domain data in, geometry out. State coloring is generalized: one color
  // per state, tinting both the rail letter and the state button.
  stateColor(st) {
    return st === 'frozen' ? '#2a6fb0' : st === 'superseded' ? '#b04038' : null;
  }

  peerEntries() {
    const lastPlaced = this.ctx.sketch.placed_from_variation_id || 0;
    const entries = (this.ctx.siblings || [])
      .filter((x) => x.variation_id !== this.variationId)
      .map((x) => {
        const st = x.state || 'draft';
        const stNote = st === 'superseded' ? ' (superseded)' : st === 'frozen' ? ' (frozen)' : '';
        return {
          key: x.variation_id,
          label: letterOf(x.ordinal),
          className: `sn-rail-peer st-${st}${x.variation_id === lastPlaced ? ' sn-last-placed' : ''}`,
          color: this.stateColor(st),
          data: { compare: String(x.variation_id) },
          title: `Compare to variation ${letterOf(x.ordinal)}.${stNote}${x.variation_id === lastPlaced ? ' (Last placed.)' : ''}`,
        };
      });
    if (this.canonized()) {
      entries.push({
        key: 'canon', label: '\u2766', className: 'sn-rail-canon',
        data: { compare: 'canon' },
        title: 'The placed text — live from the book.',
      });
    }
    return entries;
  }

  copyRefDef(variationId) {
    return {
      icon: COPY_SVG, className: 'sn-copyref',
      title: 'Copy sketch reference — start a related variation anywhere via \u29c9 Sketch \u25be \u2192 From clipboard',
      onClick: async (btn) => {
        try { localStorage.setItem('ms_last_variation_ref', String(variationId)); } catch (_) { /* private mode */ }
        try { await navigator.clipboard.writeText(VARIATION_REF_PREFIX + variationId); } catch (_) { /* in-app record suffices */ }
        btn.classList.add('sn-copied');
        setTimeout(() => btn.classList.remove('sn-copied'), 900);
      },
    };
  }

  selfActionDefs() {
    const sn = this.ctx.sketch;
    const defs = [
      { icon: TRASH_SVG(), className: 'sn-trash', title: 'Delete this variation (recoverable via Restore\u2026)', onClick: () => this.removeWidget(false) },
      { icon: DOWN_SVG, className: 'sn-supersede', color: '#b04038', active: () => this.superseded(),
        title: this.superseded() ? 'Superseded — click to un-supersede' : 'Supersede (mark no longer preferred; read-only)',
        onClick: () => this.applyState(this.variationId, this.superseded() ? 'draft' : 'superseded') },
      { icon: SNOW_SVG, className: 'sn-freeze', color: '#2a6fb0', active: () => this.frozen(),
        title: this.frozen() ? 'Frozen — click to unfreeze' : 'Freeze (make read-only)',
        onClick: () => this.applyState(this.variationId, this.frozen() ? 'draft' : 'frozen') },
      this.copyRefDef(this.variationId),
      { icon: SPARK_SVG, className: 'sn-branch', title: 'New variation based on this one', onClick: () => this.branchVariation(this.variationId) },
    ];
    if (this.canonized() && sn.linked_manuscript_id) {
      defs.push({ icon: '\u2766', className: 'sn-place', title: 'Place this variation into the manuscript — replaces the placed text, as suggested edits', onClick: () => this.placeVariation(this.variationId) });
    }
    return defs;
  }

  peerActionDefs(key) {
    if (key == null) return [];
    const sn = this.ctx.sketch;
    if (key === 'canon') {
      return [
        { icon: GOTO_SVG, className: 'sn-goto-ext', title: 'Open in book',
          onClick: () => {
            if (sn.linked_manuscript_id) window.location.href = `index.html?manuscript_id=${sn.linked_manuscript_id}#${encodeURIComponent(sn.sketch_id)}`;
          } },
        { icon: SPARK_SVG, className: 'sn-branch sn-from-placed', title: "New variation from the placed text — start editing what's in the book", onClick: () => this.newFromPlaced() },
      ];
    }
    const ctx = this.peerCache[key];
    if (!ctx) return []; // still loading — renderComparePeer refreshes once ready
    const st = ctx.variation.state || 'draft';
    return [
      { icon: GOTO_SVG, className: 'sn-goto-ext', title: 'Go to source', onClick: () => this.gotoVariationSource(key, ctx.variation.sketch_id, ctx.variation.ordinal) },
      { icon: SPARK_SVG, className: 'sn-branch', title: 'New variation based on this one', onClick: () => this.branchVariation(key) },
      ...(this.canonized() && sn.linked_manuscript_id ? [{ icon: '\u2766', className: 'sn-place', title: 'Place this variation into the manuscript — replaces the placed text, as suggested edits', onClick: () => this.placeVariation(key) }] : []),
      { icon: DOWN_SVG, className: 'sn-supersede', color: '#b04038', active: () => st === 'superseded',
        title: st === 'superseded' ? 'Superseded — click to un-supersede' : 'Supersede (mark no longer preferred; read-only)',
        onClick: () => this.applyState(key, st === 'superseded' ? 'draft' : 'superseded') },
      { icon: SNOW_SVG, className: 'sn-freeze', color: '#2a6fb0', active: () => st === 'frozen',
        title: st === 'frozen' ? 'Frozen — click to unfreeze' : 'Freeze (make read-only)',
        onClick: () => this.applyState(key, st === 'frozen' ? 'draft' : 'frozen') },
      this.copyRefDef(key),
    ];
  }

  // Pad-level nav (the shell's ‹ i/n › flippers): this widget's position
  // among the pad's sketches, and flip-to-neighbor with the flash cue.
  padWidgets() {
    const host = this.scrollHost();
    return host ? [...host.querySelectorAll('.sn-widget')] : [];
  }
  padNavInfo() {
    const ws = this.padWidgets();
    const i = ws.indexOf(this.dom);
    return { i: i >= 0 ? i + 1 : null, n: ws.length };
  }
  padNav(step) {
    const ws = this.padWidgets();
    const i = ws.indexOf(this.dom);
    const t = ws[(i < 0 ? 0 : i) + step];
    if (!t) return;
    t.scrollIntoView({ behavior: 'smooth', block: 'center' });
    t.classList.remove('sn-flash');
    void t.offsetWidth;
    t.classList.add('sn-flash');
  }

  // Toggle the split-compare (kept for callers + tests): same target
  // closes it, another target swaps. The shell owns the geometry now.
  setCompare(key) {
    if (this.compare === key) this.w.closeRight(); else this.w.openRight(key);
  }

  renderBody() {
    // All body re-renders (enter edit, blur→preview, open/close compare)
    // replace DOM and may move focus; preserve the reader's scroll position so
    // none of them jump the pad to the top of the widget.
    return this.preserveScroll(() => {
      this.selfHost = this.w.leftContent;
      this.selfHost.innerHTML = '';
      if (this.mode === 'edit') this.renderEdit(); else this.renderSelfPreview();
      if (this.compare != null) {
        const right = this.w.rightContent;
        if (this.compare === 'canon') this.renderCanon(false, right);
        else this.renderComparePeer(this.compare, right);
      }
      this.w.refresh();
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
        // If the whole widget is on screen, entering edit needs NO scroll
        // compensation at all — everything stays visible, and any adjustment
        // reads as a jump. The anchor mapping below exists for LONG sketches
        // where the serif→mono height change would drift the clicked word
        // hundreds of px.
        const scroller = this.scrollHost();
        if (scroller) {
          const wr = this.dom.getBoundingClientRect();
          const hr = scroller.getBoundingClientRect();
          this._editAnchor.fullyVisible = wr.top >= hr.top - 1 && wr.bottom <= hr.bottom + 1;
        }
        const path = e.composedPath ? e.composedPath() : [];
        let el = path.find((n) => n && n.nodeType === 1
          && ((n.classList && n.classList.contains('sentence')) || n.tagName === 'P'));
        if (!el && host.shadowRoot) {
          // The click landed on serif padding — typically the GAP between two
          // paragraphs — so composedPath holds no text element. The old
          // behavior fell through to the proportional fallback, which scrolls
          // by f × (mono − serif height delta) even for tiny sketches (the
          // 22px "click between paragraphs nudges the pad" regression). Snap
          // to the nearest paragraph instead so the mapping stays exact; ties
          // (dead center in a gap) go to the FOLLOWING paragraph — a click in
          // a gap reads as "the start of the next paragraph".
          let bestD = Infinity;
          host.shadowRoot.querySelectorAll('.scratch-book p').forEach((b) => {
            if (!(b.textContent || '').trim()) return;
            const br = b.getBoundingClientRect();
            if (!br.height) return;
            const d = e.clientY < br.top ? (br.top - e.clientY)
              : e.clientY > br.bottom ? (e.clientY - br.bottom) + 0.75 : 0;
            if (d < bestD) { bestD = d; el = b; }
          });
        }
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
      // fullyVisible: the whole widget was on screen at click time — the
      // caret mapping above still applies, but the scroll must NOT move
      // (nothing can drift out of view, and any adjustment reads as a jump).
      if (host && targetY != null && Number.isFinite(targetY) && !a.fullyVisible) {
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
    // Peer actions render in the right pane's action row (peerActionDefs);
    // the ctx just loaded, so rebuild them.
    this.w.refresh();
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
        // Same one-forced-retry discipline as renderCanon: a transient
        // book-data failure (the suggestions fetch is tolerated-but-required
        // here — the region often exists only as a suggestion) resolves the
        // region against incomplete data and reports missing-anchor. Retry
        // once fully fresh before declaring the region gone.
        let plan = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          const data = await bookData.load(sn.linked_manuscript_id, true);
          plan = window.WriteSysRegion.replacePlan(
            data.sentences, data.sugMap, sn.sketch_id, window.WriteSysCommand, text);
          if (plan.status === 'ok') break;
        }
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


  // Start a NEW variation seeded with the live placed text — edit what's
  // in the book without touching it (the placed pane's sparkle action).
  async newFromPlaced() {
    const sn = this.ctx.sketch;
    try {
      // One forced retry, like renderCanon/placeVariation — a transient
      // fetch failure must not read as "region gone".
      let seed = null;
      for (let attempt = 0; attempt < 2 && seed == null; attempt++) {
        const data = await bookData.load(sn.linked_manuscript_id, true);
        seed = window.WriteSysRegion.regionRawText(
          data.sentences, data.sugMap, sn.sketch_id, window.WriteSysCommand, null);
      }
      if (seed == null) { alert('Could not resolve the placed region.'); return; }
      const ctx = await variationApi.createFromText(sn.sketch_id, seed);
      const pos = this.getPos();
      if (pos != null) {
        this.view.dispatch(this.view.state.tr.insert(pos + this.node.nodeSize,
          this.view.state.schema.nodes.snippet.create({ variationId: ctx.variation.variation_id })));
      }
      await this.refresh();
    } catch (e) { alert('Could not sketch from the placed text: ' + e.message); }
  }

  // THE state toggle (self buttons + compare-pane buttons): set the state,
  // refresh this widget (clears peerCache; keeps an open compare), then the
  // siblings — their rails color-code every variation's state live.
  async applyState(variationId, state) {
    try {
      await variationApi.setState(variationId, state);
      await this.refresh();
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
    liveSketchViews.delete(this);
    for (const v of liveSketchViews) {
      if (v.w) v.w.refresh(); // pad nav counts shrink with this widget
    }
    if (this._sqAdapter) unregisterNoteRefView(this._sqAdapter.noteId, this._sqAdapter);
    if (this._saver) this._saver.destroy();
    variationFlushers.delete(this.flush);
    dirtyVariations.delete(this);
    liveSketchViews.delete(this);
  }
  stopEvent() { return true; }
  ignoreMutation() { return true; }
}
