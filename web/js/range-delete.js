/**
 * Range delete (shift-click): click a sentence, SHIFT-click another — every
 * sentence between them (inclusive, manuscript order) highlights as a range.
 * While the range is active:
 *   - the canonize + affordances hide (no gap-hover noise);
 *   - a button stack floats in the left gutter (copy / sketch / trash; see
 *     showTrash). The trash keeps the house mechanics: first click arms it
 *     ("click again") and turns the range red, second click applies; no
 *     second click within 2s disarms both back (the usual selection gray).
 * A SINGLE selected sentence (plain click) gets the stack too — copy +
 * trash (2026-11-09); its second click still opens suggest-edit.
 * Applying PUTs an EMPTY suggestion on every sentence in the range — the
 * standard "clear this sentence" proposal (same as emptying it in
 * suggest-edit), one suggested delete per sentence, revertible
 * sentence-by-sentence, committed on the next push. A reviewer's deletions
 * are ACCEPTED on the spot (2026-11-09): the trash's two clicks are the
 * confirmation — the old select-them-again-and-✓ step is gone.
 * Escape or a plain (unshifted) click anywhere exits the mode.
 */
const WriteSysRangeDelete = {
  anchorId: null,   // last plain-clicked sentence (range start candidate)
  range: [],        // sentence ids currently selected
  btn: null,

  init() {
    if (!document.getElementById('manuscript-content')) return; // book page only
    // Capture phase: sentence spans live inside paged.js content; suggestion
    // click handlers also listen — we only act on shift-clicks, and swallow
    // them so the suggest-edit modal doesn't also fire.
    // Native shift-click selection starts at MOUSEDOWN — before our click
    // handler can act — and sweeps from wherever the browser's caret last
    // was, even across the outline. Swallow it for shift-clicks in the book
    // so only our range highlight shows.
    document.addEventListener('mousedown', (e) => {
      if (!e.shiftKey) return;
      if (!(e.target.closest && e.target.closest('.pagedjs_pages'))) return;
      e.preventDefault();
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) sel.removeAllRanges();
    }, true);
    document.addEventListener('click', (e) => {
      const span = e.target.closest && e.target.closest('.sentence[data-sentence-id]');
      if (!span) {
        // Plain click somewhere else exits the mode (but not clicks on our
        // own trash button).
        if (!e.shiftKey && !(e.target.closest && e.target.closest('.range-trash'))) this.exit();
        return;
      }
      const id = span.dataset.sentenceId;
      if (e.shiftKey && this.anchorId && this.anchorId !== id) {
        e.preventDefault();
        e.stopPropagation();
        this.select(this.anchorId, id);
        return;
      }
      // Plain click on a sentence: new anchor, mode exits.
      this.exit();
      this.anchorId = id;
    }, true);
    // Bubble phase — after the sentence's own click-select: a plain click
    // that leaves ONE sentence selected shows the stack for it (a re-click
    // that opened suggest-edit doesn't).
    document.addEventListener('click', (e) => {
      if (e.shiftKey) return;
      const span = e.target.closest && e.target.closest('.sentence[data-sentence-id]');
      if (!span) return;
      const id = span.dataset.sentenceId;
      const R = window.WriteSysRenderer;
      if (!R || R.currentSelectedSentenceId !== id || !span.classList.contains('selected')) return;
      if (document.getElementById('suggestion-modal')) return;
      this.showSingle(id);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.range.length) this.exit();
    });
  },

  orderedIds() {
    const r = window.WriteSysRenderer;
    return (r && r.currentSentences ? r.currentSentences : []).map((s) => s.sentence_id || s.id);
  },

  select(aId, bId) {
    const ids = this.orderedIds();
    let a = ids.indexOf(aId), b = ids.indexOf(bId);
    if (a < 0 || b < 0) return;
    if (a > b) { const t = a; a = b; b = t; }
    this.clearHighlights();
    this.range = ids.slice(a, b + 1);
    // The range REPLACES the single click-select: drop it from the
    // renderer too, or a later click on the anchor reads as a re-click
    // and opens suggest-edit on a sentence that no longer looks selected.
    const R = window.WriteSysRenderer;
    if (R) R.currentSelectedSentenceId = null;
    const set = new Set(this.range);
    document.querySelectorAll('.sentence[data-sentence-id]').forEach((el) => {
      if (set.has(el.dataset.sentenceId)) el.classList.add('range-selected');
      // The app's own click-select may have grayed a sentence under the
      // pointer (wrapped spans have big hitboxes) — the range is the only
      // selection visual while the mode is on.
      el.classList.remove('selected');
    });
    document.body.classList.add('range-delete-mode');
    this.showTrash();
  },

  // One sentence, selected by the renderer's plain click: the same stack,
  // copy + trash. No range mode (affordances and native text selection
  // stay); range-selected only so the stack can measure it and an armed
  // trash can red it.
  showSingle(id) {
    this.range = [id];
    document.querySelectorAll(`.sentence[data-sentence-id="${CSS.escape(id)}"]`)
      .forEach((el) => el.classList.add('range-selected'));
    this.showTrash();
  },

  // The button stack (2026-10-23): ONE fixed column in the page's left
  // gutter — copy / sketch / trash, top to bottom — that FLOATS: it
  // holds the middle of the screen while the selection spans it, and pegs
  // to the selection's top or bottom edge once you scroll past either.
  // (It used to be pinned beside the selection's first page — a long or
  // low-starting range left most of the stack off screen: "only the ✓".)
  showTrash() {
    this.removeTrash();
    if (!document.querySelector('.sentence.range-selected')) return;
    const stack = document.createElement('div');
    stack.className = 'range-stack';
    const make = (cls, title, html) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `range-trash ${cls}`;
      b.title = title;
      b.innerHTML = html;
      return b;
    };
    const n = this.range.length;
    const s = n > 1 ? 's' : '';

    // COPY: the selection's text with every suggestion applied
    // (copy-selection.js).
    if (window.WriteSysCopySelection) {
      const C = window.WriteSysCopySelection;
      const cp = make('range-copy', C.titleFor(this.range), C.buttonHTML());
      cp.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        C.copy(this.range.slice(), cp);
      });
      stack.appendChild(cp);
      this.copyBtn = cp;
    }
    // SKETCH: rework this selection through sketches (A = frozen original,
    // B = editable copy, placed). Ranges only.
    if (n > 1 && window.WriteSysSketchFromSelection) {
      const sk = make('range-sketch', `Sketch from ${n} selected sentence${s}`,
        window.WriteSysSketchFromSelection.buttonHTML());
      sk.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        window.WriteSysSketchFromSelection.open(this.range.slice());
      });
      stack.appendChild(sk);
      this.sketchBtn = sk;
    }
    // TRASH (range-del) at the bottom: house two-click — the first click
    // arms it and reds the range; no second click within 2s disarms both.
    // A reviewer's delete is accepted on the spot (apply); anyone else's
    // stays a suggestion.
    const S = window.WriteSysSuggestions;
    const verb = S && S.canReview ? 'Delete' : 'Suggest deleting';
    const btn = make('range-del', `${verb} ${n} sentence${s}`,
      window.WriteSysIcons.trash(12)); // the house trash, never a new copy
    let armed = false, resetTimer = null;
    btn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (!armed) {
        armed = true;
        btn.classList.add('confirming');
        document.body.classList.add('range-delete-armed'); // the range turns red
        const idleTitle = btn.title;
        btn.title = `Click again to ${verb.toLowerCase()} the selection`;
        resetTimer = setTimeout(() => {
          armed = false;
          btn.classList.remove('confirming');
          btn.title = idleTitle;
          document.body.classList.remove('range-delete-armed');
        }, 2000);
        return;
      }
      clearTimeout(resetTimer);
      this.apply();
    });
    stack.appendChild(btn);
    this.btn = btn;

    document.body.appendChild(stack);
    this.stack = stack;
    this._place = () => this.placeStack();
    window.addEventListener('scroll', this._place, { capture: true, passive: true });
    window.addEventListener('resize', this._place);
    this.placeStack();
  },

  // Where the stack goes, measured live (viewport coordinates, so it works
  // at any page scale and inside a split-pane frame): x = just off the
  // sheet's left edge (never off screen); y = the screen's middle, clamped so the stack never
  // leaves the selection's vertical extent.
  placeStack() {
    const stack = this.stack;
    if (!stack) return;
    const sel = document.querySelectorAll('.sentence.range-selected');
    let top = Infinity, bottom = -Infinity, sheet = null;
    sel.forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.height === 0) return;
      if (r.top < top) { top = r.top; sheet = el.closest('.pagedjs_sheet') || el.closest('.pagedjs_page'); }
      bottom = Math.max(bottom, r.bottom);
    });
    if (!sheet || top === Infinity) return;
    const h = stack.offsetHeight;
    const mid = window.innerHeight / 2;
    let center;
    if (bottom - top <= h) center = (top + bottom) / 2;
    else center = Math.min(Math.max(mid, top + h / 2), bottom - h / 2);
    const sr = sheet.getBoundingClientRect();
    // Phones have no gutter: the stack stays on screen, over the page's
    // own margin.
    stack.style.left = `${Math.max(4, Math.round(sr.left - 6 - stack.offsetWidth))}px`;
    stack.style.top = `${Math.round(center - h / 2)}px`;
  },

  async apply() {
    const ids = this.range.slice();
    const firstId = ids[0];
    if (this.btn) { this.btn.disabled = true; this.btn.innerHTML = '…'; }
    try {
      // The shared write path (WriteSysSuggestions.putSuggestion) handles
      // CSRF + 401. Mid-range failure aborts the loop: earlier PUTs stand,
      // later sentences are never attempted; the refetch below reflects the
      // partial state.
      for (const id of ids) {
        try {
          await window.WriteSysSuggestions.putSuggestion(id, '');
        } catch (e) {
          throw new Error(`delete-suggestion failed on ${id} (${e.status || e.message})`);
        }
      }
    } catch (err) {
      alert(err.message + ' — some sentences may already carry the suggestion; review and retry.');
    }
    this.exit();
    const r = window.WriteSysRenderer;
    if (r) r.currentSelectedSentenceId = null; // the re-render drops the gray
    const S = window.WriteSysSuggestions;
    if (S && r) await S.loadForMigration(r.currentMigrationID);
    // A reviewer's deletions are accepted right away — the viewer's own
    // empty suggestion on each sentence (failed PUTs have none to accept).
    if (S && S.canReview && S.acceptMany) {
      const res = await S.acceptMany(ids, S.viewer);
      if (res.conflicts || res.failed) {
        alert(`Deleted ${res.accepted}.`
          + (res.conflicts ? ` ${res.conflicts} sentence${res.conflicts > 1 ? 's have' : ' has'} another edit already accepted — left as a suggestion.` : '')
          + (res.failed ? ` ${res.failed} failed to accept — retry from the edit.` : ''));
      }
    }
    if (r && r.renderManuscript) await r.renderManuscript({ anchorSentenceId: firstId });
    if (window.WriteSysPush) window.WriteSysPush.refresh();
  },

  clearHighlights() {
    document.querySelectorAll('.sentence.range-selected').forEach((el) => el.classList.remove('range-selected'));
  },
  removeTrash() {
    if (this._place) {
      window.removeEventListener('scroll', this._place, { capture: true });
      window.removeEventListener('resize', this._place);
      this._place = null;
    }
    if (this.stack) { this.stack.remove(); this.stack = null; }
    document.querySelectorAll('.range-stack, .range-trash').forEach((el) => el.remove());
    this.btn = null;
    this.sketchBtn = null;
    this.copyBtn = null;
  },
  exit() {
    this.clearHighlights();
    this.removeTrash();
    this.range = [];
    document.body.classList.remove('range-delete-mode', 'range-delete-armed');
  },
};

if (typeof window !== 'undefined') {
  window.WriteSysRangeDelete = WriteSysRangeDelete;
  document.addEventListener('DOMContentLoaded', () => WriteSysRangeDelete.init());
}
