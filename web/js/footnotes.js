// Footnotes (FOOTNOTES_PLAN.md): numbering after pagination.
//
// Paged.js floats each .fn-body (float: footnote, book.css) into its
// page's footnote area and leaves a [data-footnote-call] at the call site;
// call and body share one data-ref value (data-footnote-call on the call,
// data-footnote-marker on the body). Paged's own counters number
// continuously; we relabel by the book's policy — the &meta settings land
// on <body> as data-footnote-marks (numbers | symbols) and
// data-footnote-reset (page | chapter | never) — writing data-fn-mark on
// both ends; book.css prints it. Per-chapter resets happen at the chapter
// heading itself, in reading order, because a chapter may start mid-page.
// Marks only get shorter than Paged's continuous numbers, never longer, so
// no re-pagination. Re-runs on any setting change (renderer applySettings).
window.WriteSysFootnotes = {
  // Chicago order; past six the browser convention doubles, then triples.
  SYMBOLS: ['*', '†', '‡', '§', '‖', '¶'],
  symbolFor(n) {
    const S = this.SYMBOLS;
    const i = (n - 1) % S.length;
    const reps = Math.floor((n - 1) / S.length) + 1;
    return S[i].repeat(reps);
  },

  relabel() {
    const pages = document.querySelectorAll('.pagedjs_pages .pagedjs_page');
    if (!pages.length) return;
    const marks = document.body.getAttribute('data-footnote-marks') || 'numbers';
    const reset = document.body.getAttribute('data-footnote-reset') || 'chapter';
    const markOf = (n) => (marks === 'symbols' ? this.symbolFor(n) : String(n));
    const bodies = new Map(); // ref → [body pieces] (a split note has two)
    document.querySelectorAll('.pagedjs_pages [data-footnote-marker]').forEach((b) => {
      const ref = b.getAttribute('data-footnote-marker');
      if (!bodies.has(ref)) bodies.set(ref, []);
      bodies.get(ref).push(b);
    });
    let n = 0;
    pages.forEach((page) => {
      if (reset === 'page') n = 0;
      const content = page.querySelector('.pagedjs_page_content') || page;
      content.querySelectorAll('.cmd-chapter, [data-footnote-call]').forEach((el) => {
        if (el.classList.contains('cmd-chapter')) {
          if (reset === 'chapter') n = 0;
          return;
        }
        n += 1;
        const mark = markOf(n);
        el.setAttribute('data-fn-mark', mark);
        const bs = bodies.get(el.getAttribute('data-footnote-call')) || [];
        bs.forEach((b) => b.setAttribute('data-fn-mark', mark));
        // Paged clones the body's CLASS list onto the call (not its data
        // attributes): make the call a fragment of the host sentence — its
        // id, its own class — so hover/click on the mark act on the sentence.
        if (bs.length && bs[0].dataset.sentenceId) el.setAttribute('data-sentence-id', bs[0].dataset.sentenceId);
        el.classList.remove('fn-body');
        el.classList.add('sentence', 'fn-call');
      });
    });
  },
};
