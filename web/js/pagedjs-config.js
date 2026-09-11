// Registers the WriteSys Paged.js handler. This file loads AFTER Paged.js in
// index.html; ordering doesn't matter because setupPagedJS polls every 100ms
// until the Paged global exists, then registers exactly once. The only hard
// requirement is that registration lands before the first `new
// Paged.Previewer()` (renderer.js renderManuscript) — renders are async and
// start well after DOMContentLoaded, which the poll comfortably beats.

(function() {
  function setupPagedJS() {
    if (typeof Paged === 'undefined') {
      setTimeout(setupPagedJS, 100);
      return;
    }

    class WriteSysHandler extends Paged.Handler {
      constructor(chunker, polisher, caller) {
        super(chunker, polisher, caller);
      }

      afterRendered(pages) {
        // Pagination-pass counter: condition-waitable signal for tests (and
        // anything else) that a paged.js render just completed — replaces
        // "sleep N ms and hope" (see tests/test-utils.js waitForPagination).
        document.body.dataset.paginated =
          String((parseInt(document.body.dataset.paginated || '0', 10) || 0) + 1);

        if (window.WriteSysTextMarkers && window.WriteSysTextMarkers.curlQuotes) {
          window.WriteSysTextMarkers.curlQuotes(document.body);
        }

        if (window.WriteSysRenderer) {
          window.WriteSysRenderer.applyResponsiveScaling();
        }

        // Attention envelope (ATTENTION_PLAN.md): pre-generate the
        // per-page overlays from the FINAL geometry — after scaling, so
        // harvested rects normalize consistently.
        if (window.WriteSysAttention) {
          window.WriteSysAttention.rebuild();
        }

        // Suppress the folio (page number) on title/part divider pages: a
        // page whose content is a &title or &part heading is a book-style
        // blank divider and must carry no number. We tag such pages so CSS can
        // hide their @bottom-right folio (paged.js renders the number into a
        // .pagedjs_margin-bottom-right box per page).
        document.querySelectorAll('.pagedjs_page').forEach(page => {
          const content = page.querySelector('.pagedjs_page_content');
          if (content && content.querySelector('.cmd-part, .cmd-title')) {
            page.classList.add('no-folio');
          }
        });

        // Re-bind handlers on the new spans. (Inter-sentence spaces live in
        // .sent-sp separator SPANS baked in at render time — elements survive
        // pagination, so no post-hoc space insertion that would re-wrap
        // already-fragmented pages.)
        const pagedContent = document.querySelector('.pagedjs_pages');
        if (pagedContent && window.WriteSysRenderer) {
          window.WriteSysRenderer.setupSentenceHover();
          window.WriteSysRenderer.addRainbowBars();
          if (window.WriteSysPlaceholder) window.WriteSysPlaceholder.layoutPass();
          if (window.WriteSysImportScratchpad) window.WriteSysImportScratchpad.refresh();
          if (window.WriteSysSuggestions && window.WriteSysSuggestions.markStaleSentences) window.WriteSysSuggestions.markStaleSentences();
          if (window.WriteSysHistory && window.WriteSysRenderer.currentMigrationID) {
            window.WriteSysHistory.loadHistory(window.WriteSysRenderer.currentMigrationID);
          }
          // Deep link from the landing Notes grid: #note-sentence=<sid>
          // scrolls to the noted sentence and opens its notes — once per
          // hash after a render; a kept-alive panel gets NEW hashes from
          // the tabs link router, followed on hashchange (below).
          followNoteDeepLink(false);
        }

        console.log(`Paged.js rendered ${pages.length} pages`);
      }
    }

    Paged.registerHandlers(WriteSysHandler);
    console.log('WriteSys Paged.js handler registered');
  }

  setupPagedJS();
})();

// #note-sentence=<sid> deep link: scroll to the sentence and open its
// notes. After a render it runs once per hash (re-renders must not yank
// the scroll back); on hashchange it always runs — the tabs link router
// sets a live panel's hash (or re-dispatches hashchange for the same one)
// when a note card is clicked again.
function followNoteDeepLink(force) {
  const R = window.WriteSysRenderer;
  const m = (window.location.hash || '').match(/[#&]note-sentence=([^&]+)/);
  if (!R || !m) return;
  if (!force && R._noteDeepLinkDone === window.location.hash) return;
  R._noteDeepLinkDone = window.location.hash;
  const sid = decodeURIComponent(m[1]);
  setTimeout(() => {
    R.scrollToSentence(sid);
    const frag = document.querySelector(`.sentence[data-sentence-id="${sid}"]`);
    if (frag && window.WriteSysNotes) frag.click(); // opens the note panel for that sentence
  }, 300);
}
window.addEventListener('hashchange', () => {
  if (document.querySelector('.pagedjs_page')) followNoteDeepLink(true);
});
