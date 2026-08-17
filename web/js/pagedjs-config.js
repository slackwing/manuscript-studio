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

        if (typeof smartquotes !== 'undefined') {
          smartquotes();
        }

        if (window.WriteSysRenderer) {
          window.WriteSysRenderer.applyResponsiveScaling();
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

        // Re-insert spaces between sentence spans (Paged.js strips whitespace
        // text nodes during pagination) and re-bind handlers on the new spans.
        const pagedContent = document.querySelector('.pagedjs_pages');
        if (pagedContent && window.WriteSysRenderer) {
          window.WriteSysRenderer.insertSpacesBetweenSentences(pagedContent);

          window.WriteSysRenderer.setupSentenceHover();
          window.WriteSysRenderer.addRainbowBars();
          if (window.WriteSysPlaceholder) window.WriteSysPlaceholder.layoutPass();
          if (window.WriteSysImportScratchpad) window.WriteSysImportScratchpad.refresh();
          if (window.WriteSysHistory && window.WriteSysRenderer.currentMigrationID) {
            window.WriteSysHistory.loadHistory(window.WriteSysRenderer.currentMigrationID);
          }
          // Deep link from the landing Notes grid: #note-sentence=<sid> scrolls
          // to the noted sentence and opens its notes (once, on first render).
          if (!window.WriteSysRenderer._noteDeepLinkDone) {
            const m = (window.location.hash || '').match(/[#&]note-sentence=([^&]+)/);
            if (m) {
              window.WriteSysRenderer._noteDeepLinkDone = true;
              const sid = decodeURIComponent(m[1]);
              setTimeout(() => {
                window.WriteSysRenderer.scrollToSentence(sid);
                const frag = document.querySelector(`.sentence[data-sentence-id="${sid}"]`);
                if (frag && window.WriteSysNotes) {
                  frag.click(); // opens the note panel for that sentence
                }
              }, 300);
            }
          }
        }

        console.log(`Paged.js rendered ${pages.length} pages`);
      }
    }

    Paged.registerHandlers(WriteSysHandler);
    console.log('WriteSys Paged.js handler registered');
  }

  setupPagedJS();
})();
