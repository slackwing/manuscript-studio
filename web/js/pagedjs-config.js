// Must load BEFORE Paged.js processes content so handlers apply on first run.

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

        // Paged.js strips whitespace text nodes during pagination, so we
        // re-insert the spaces between sentence spans ourselves.
        const pagedContent = document.querySelector('.pagedjs_pages');
        if (pagedContent && window.WriteSysRenderer) {
          window.WriteSysRenderer.insertSpacesBetweenSentences(pagedContent);

          // Re-bind handlers on the new sentence spans produced by pagination.
          window.WriteSysRenderer.setupSentenceHover();
          window.WriteSysRenderer.addRainbowBars();
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
