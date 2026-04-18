// Paged.js configuration - loaded BEFORE Paged.js processes content
// This ensures our handlers and settings apply before Paged.js runs

// Wait for Paged to be defined, then register handlers
(function() {
  function setupPagedJS() {
    if (typeof Paged === 'undefined') {
      // Paged.js not loaded yet, wait
      setTimeout(setupPagedJS, 100);
      return;
    }

    // Handler to run after Paged.js renders
    class WriteSysHandler extends Paged.Handler {
      constructor(chunker, polisher, caller) {
        super(chunker, polisher, caller);
      }

      afterRendered(pages) {
        // Apply smartquotes
        if (typeof smartquotes !== 'undefined') {
          smartquotes();
        }

        // Apply responsive scaling
        if (window.WriteSysRenderer) {
          window.WriteSysRenderer.applyResponsiveScaling();
        }

        // Insert spaces between sentence spans
        // (Paged.js strips whitespace text nodes during pagination)
        const pagedContent = document.querySelector('.pagedjs_pages');
        if (pagedContent && window.WriteSysRenderer) {
          window.WriteSysRenderer.insertSpacesBetweenSentences(pagedContent);

          // Setup click/hover handlers on the NEW sentence spans created by Paged.js
          window.WriteSysRenderer.setupSentenceHover();

          // Add rainbow bars for sentences with multiple annotations
          window.WriteSysRenderer.addRainbowBars();
        }

        console.log(`Paged.js rendered ${pages.length} pages`);
      }
    }

    // Register handler globally
    Paged.registerHandlers(WriteSysHandler);
    console.log('WriteSys Paged.js handler registered');
  }

  // Start setup
  setupPagedJS();
})();
