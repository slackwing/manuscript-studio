/**
 * Range delete (shift-click): click a sentence, SHIFT-click another — every
 * sentence between them (inclusive, manuscript order) highlights as a range.
 * While the range is active:
 *   - the canonize + affordances hide (no gap-hover noise);
 *   - a persistent RED trash circle shows in the left gutter at the range's
 *     first line. House trash mechanics: first click arms it ("click again"),
 *     second click applies.
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

  csrf() { return (localStorage.getItem('csrf_token') || sessionStorage.getItem('csrf_token')) || ''; },

  init() {
    if (!document.getElementById('manuscript-content')) return; // book page only
    // Capture phase: sentence spans live inside paged.js content; suggestion
    // click handlers also listen — we only act on shift-clicks, and swallow
    // them so the suggest-edit modal doesn't also fire.
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
    });
    document.body.classList.add('range-delete-mode');
    this.showTrash();
  },

  showTrash() {
    this.removeTrash();
    const first = document.querySelector('.sentence.range-selected');
    if (!first) return;
    const pageArea = first.closest('.pagedjs_page_content');
    const host = first.closest('p') || first.parentElement;
    if (!host || !pageArea) return;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'range-trash';
    btn.title = `Suggest deleting ${this.range.length} sentence${this.range.length > 1 ? 's' : ''}`;
    btn.innerHTML = '🗑';
    let armed = false, resetTimer = null;
    btn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (!armed) {
        armed = true;
        btn.classList.add('confirming');
        btn.title = 'Click again to suggest deleting the selection';
        resetTimer = setTimeout(() => { armed = false; btn.classList.remove('confirming'); }, 2000);
        return;
      }
      clearTimeout(resetTimer);
      this.apply();
    });
    host.appendChild(btn);
    this.btn = btn;
  },

  async apply() {
    const ids = this.range.slice();
    const firstId = ids[0];
    if (this.btn) { this.btn.disabled = true; this.btn.innerHTML = '…'; }
    try {
      for (const id of ids) {
        const resp = await fetch(`api/sentences/${encodeURIComponent(id)}/suggestion`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrf() },
          credentials: 'same-origin',
          body: JSON.stringify({ text: '' }),
        });
        if (!resp.ok) throw new Error(`delete-suggestion failed on ${id} (${resp.status})`);
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
    if (this.btn) { this.btn.remove(); this.btn = null; }
    document.querySelectorAll('.range-trash').forEach((el) => el.remove());
  },
  exit() {
    this.clearHighlights();
    this.removeTrash();
    this.range = [];
    document.body.classList.remove('range-delete-mode');
  },
};

if (typeof window !== 'undefined') {
  window.WriteSysRangeDelete = WriteSysRangeDelete;
  document.addEventListener('DOMContentLoaded', () => WriteSysRangeDelete.init());
}
