// Must load BEFORE Paged.js so handlers apply on first run.

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
        }

        console.log(`Paged.js rendered ${pages.length} pages`);
      }
    }

    Paged.registerHandlers(WriteSysHandler);
    console.log('WriteSys Paged.js handler registered');
  }

  setupPagedJS();
})();
