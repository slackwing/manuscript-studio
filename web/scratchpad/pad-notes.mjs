/**
 * Scratchpad NOTES (split out of editor-core.mjs — CODE_REVIEW_AUG_2026.md §1):
 * the atomic noteRef subsystem — active-view registry, note cache + ref-view
 * registry, note CRUD via the doc, NoteRefView, the floating note, the toolbar
 * color bar, and the teardown flags (editorTearingDown / suppressNoteDelete)
 * that keep destroy() from soft-deleting live notes (invariants §1.2#2–3).
 *
 * Module-boundary state (activeView, editorTearingDown) is shared through
 * exported getter/setter FUNCTIONS, not mutable exported bindings — the
 * setters are synchronous, so the editor-core teardown bracket
 * (setEditorTearingDown(true) strictly around view.destroy()) keeps its exact
 * old semantics.
 */
import { getCurrentScratchpadId } from './api.mjs?v=1';
import { holdScroll } from './scroll.mjs?v=1';

// ---- Scratchpad notes (NOTES_PLAN.md Phase 2, atomic) --------------------
// Creating a note from a selection replaces the selected text with ONE atomic
// noteRef node (square + verbatim text). The doc stores note_id + text only —
// the COLOR is sourced from the note data (client cache), so recolor is a pure
// note-row update with no doc edit, and there's one source of truth.

const NOTE_COLORS = ['yellow', 'green', 'blue', 'purple', 'red', 'orange'];

// The active editor view (set in createScratchpadEditor) so the module-level
// note helpers can read/edit the doc.
let activeView = null;
// Getter/setter seam (module split): editor-core sets the view on mount and
// clears it in destroy(); scroll.mjs reads it for diagnostics. Synchronous —
// semantics identical to the old module-global assignment.
export function getActiveView() { return activeView; }
export function setActiveView(v) { activeView = v; }

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
export function findNormalized(raw, needle, hintOffset) {
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

export function overlayYAtOffset(overlay, offset) {
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

export function lockScratchpadScroll(fn) {
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
export const noteCache = new Map();
// note_id → Set of NoteRefView instances, so a recolor re-renders every view of
// that note instantly.
const noteRefViews = new Map();
export function registerNoteRefView(noteId, view) {
  if (!noteRefViews.has(noteId)) noteRefViews.set(noteId, new Set());
  noteRefViews.get(noteId).add(view);
}
export function unregisterNoteRefView(noteId, view) {
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
    created = await window.WriteSysNoteAPI.create({ color, body, ctx: { scratchpad_id: getCurrentScratchpadId() } });
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
// Setter seam (module split): editor-core brackets view.destroy() with
// setEditorTearingDown(true/false) — synchronous, the exact old bracket
// semantics (invariant §1.2#2).
export function setEditorTearingDown(v) { editorTearingDown = v; }
// Note ids whose ref is being removed for a reason OTHER than deletion (e.g.
// "complete"). destroy() consults this and skips the soft-delete.
const suppressNoteDelete = new Set();
function removeNoteRefNoDelete(noteId) {
  suppressNoteDelete.add(noteId);
  removeNoteFromDoc(noteId);
  setTimeout(() => suppressNoteDelete.delete(noteId), 0);
}

// The red trash glyph, reused from the sticky-note widget for visual
// consistency. Deref at CALL time, not module-eval time (load-order bomb —
// CODE_REVIEW_AUG_2026.md §1.1, fixed with the split).
const TRASH_SVG_NOTE = () => window.WriteSysIcons.trashStroke(12);

// NodeView for the atomic noteRef: a colored square + the verbatim highlighted
// text, looking like normal highlighted prose but UNEDITABLE (atom). The COLOR
// comes from the note cache (not the doc). Clicking the square opens the float;
// hovering reveals a floating red trash (two-click confirm). Deletion is
// deterministic: destroy() fires when the node leaves the doc.
export class NoteRefView {
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
      '<span class="sn-note-ref-trash" title="Delete note">' + TRASH_SVG_NOTE() + '</span>';
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
export function closeNoteFloat() {
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

export async function openNoteFloatFor(noteId, anchorEl) {
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
// current selection. Registers the group in the module-level noteColorGroups
// list (reset per editor instance), which updateToolbar() walks to toggle the
// disabled look (empty selection → can't create a note).
export const noteColorGroups = [];
export function buildNoteColorBar(toolbarEl, getView) {
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
