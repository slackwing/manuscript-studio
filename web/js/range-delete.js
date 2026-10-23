/**
 * Range delete (shift-click): click a sentence, SHIFT-click another — every
 * sentence between them (inclusive, manuscript order) highlights as a range.
 * While the range is active:
 *   - the canonize + affordances hide (no gap-hover noise);
 *   - a button stack floats in the left gutter (✓ / copy / sketch / trash;
 *     see showTrash). The trash keeps the house mechanics: first click arms
 *     it ("click again") and turns the range red, second click applies; no
 *     second click within 2s disarms both back (the usual selection gray).
 * Applying PUTs an EMPTY suggestion on every sentence in the range — the
 * standard "clear this sentence" proposal (same as emptying it in
 * suggest-edit), one suggested delete per sentence, reviewable and revertible
 * sentence-by-sentence, committed on the next push.
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

  // The button stack (2026-10-23): ONE fixed column in the page's left
  // gutter — ✓ / copy / sketch / trash, top to bottom — that FLOATS: it
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

    // ACCEPT (✓) tops the stack (2026-10-18): accept the suggestion every
    // selected sentence shows — deletion proposals included — for "I
    // deleted a run of sentences and want to accept them too". Reviewers
    // only (manage-suggestions). House two-click, like the trash: the first
    // click arms it and greens the range; no second click within 2s
    // disarms both.
    const S = window.WriteSysSuggestions;
    if (S && S.canReview && S.acceptMany) {
      const idleTitle = `Accept the suggested edits in ${n} sentence${s}`;
      const ac = make('range-accept', idleTitle,
        window.WriteSysIcons && window.WriteSysIcons.check ? window.WriteSysIcons.check(12) : '✓');
      let acArmed = false, acTimer = null;
      ac.addEventListener('click', async (e) => {
        e.preventDefault(); e.stopPropagation();
        if (!acArmed) {
          acArmed = true;
          ac.classList.add('confirming');
          document.body.classList.add('range-accept-armed');
          ac.title = 'Click again to accept them';
          acTimer = setTimeout(() => {
            acArmed = false;
            ac.classList.remove('confirming');
            ac.title = idleTitle;
            document.body.classList.remove('range-accept-armed');
          }, 2000);
          return;
        }
        clearTimeout(acTimer);
        await this.acceptRange();
      });
      stack.appendChild(ac);
      this.acceptBtn = ac;
    }
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
    // B = editable copy, placed).
    if (window.WriteSysSketchFromSelection) {
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
    const btn = make('range-del', `Suggest deleting ${n} sentence${s}`,
      window.WriteSysIcons.trash(12)); // the house trash, never a new copy
    let armed = false, resetTimer = null;
    btn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (!armed) {
        armed = true;
        btn.classList.add('confirming');
        document.body.classList.add('range-delete-armed'); // the range turns red
        const idleTitle = btn.title;
        btn.title = 'Click again to suggest deleting the selection';
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
  // sheet's left edge; y = the screen's middle, clamped so the stack never
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
    stack.style.left = `${Math.round(sr.left - 6 - stack.offsetWidth)}px`;
    stack.style.top = `${Math.round(center - h / 2)}px`;
  },

  async acceptRange() {
    const ids = this.range.slice();
    const firstId = ids[0];
    if (this.acceptBtn) { this.acceptBtn.disabled = true; }
    const r = window.WriteSysRenderer;
    const S = window.WriteSysSuggestions;
    const res = await S.acceptMany(ids);
    this.exit();
    if (r && r.renderManuscript) await r.renderManuscript({ anchorSentenceId: firstId });
    if (window.WriteSysPush) window.WriteSysPush.refresh();
    if (res.conflicts || res.failed) {
      alert(`Accepted ${res.accepted}.`
        + (res.conflicts ? ` ${res.conflicts} sentence${res.conflicts > 1 ? 's have' : ' has'} another suggestion already accepted.` : '')
        + (res.failed ? ` ${res.failed} failed — retry.` : ''));
    }
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
    if (window.WriteSysSuggestions && r) await window.WriteSysSuggestions.loadForMigration(r.currentMigrationID);
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
    this.acceptBtn = null;
  },
  exit() {
    this.clearHighlights();
    this.removeTrash();
    this.range = [];
    document.body.classList.remove('range-delete-mode', 'range-delete-armed', 'range-accept-armed');
  },
};

if (typeof window !== 'undefined') {
  window.WriteSysRangeDelete = WriteSysRangeDelete;
  document.addEventListener('DOMContentLoaded', () => WriteSysRangeDelete.init());
}
