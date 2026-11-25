/**
 * Book rendering inside the scratchpad (SCRATCHPAD_PLAN.md §6): reuses the
 * REAL pipeline — WriteSysRenderer.renderSentencesToHTML — inside a shadow
 * root that links book.css, so book typography applies without leaking
 * page-wide book styles into the editor.
 * No pagination: the container grows with the content. No suggested-edit
 * features: spans render but nothing binds handlers (read-only view).
 */
const WriteSysScratchRender = {
  // ensure returns the shadow root's content container for a host element.
  ensure(host) {
    if (host.shadowRoot) return host.shadowRoot.querySelector('.scratch-book');
    const root = host.attachShadow({ mode: 'open' });
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'css/book.css?v=244';
    root.appendChild(link);
    const style = document.createElement('style');
    style.textContent = `
      /* Shadow scope: body-level book typography must be restated (body
         selectors don't match inside a shadow tree), and the interactive
         affordances are neutralized — this view is read-only. */
      .scratch-book {
        font-family: var(--book-font, Georgia, serif);
        /* Fixed (not viewport-fluid), but smaller than the book's 12pt so a
           sketch reads as a compact working excerpt inside the pad. */
        font-size: 10.5pt;
        line-height: 1.6;
        color: #1a1a1a;
        background: transparent;   /* let the host's bg show (white for self,
                                      darker grey for a disabled peer preview) */
        padding: 14px 18px;
      }
      /* Widgets are working views, not pages: left-justify prose. */
      .scratch-book p { text-align: left; }
      /* Pre-rendered diff HTML (renderHTML) shares the book typography. */
      .scratch-diff { white-space: pre-wrap; overflow-wrap: break-word; }
      /* Faint →/↵ glyphs painted OVER the real whitespace (zero layout
         impact — absolute inside a relative shell), mirroring the mono
         overlay's markers. */
      .sd-tab, .sd-nl { position: relative; }
      .sd-g {
        position: absolute;
        left: 0;
        top: 0;
        color: #b8b0a0;
        font-size: 0.85em;
        pointer-events: none;
        user-select: none;
      }
      .scratch-diff del { color: #b03030; text-decoration: line-through; text-decoration-thickness: 1px; }
      .scratch-diff strong { color: #2e7d32; font-weight: 600; }
      /* Structural markers in a diff (renderStructuralMarkers' ¶/§ and the
         paragraph-indent box). book.css styles these for the PAGE under
         .sentence; a diff mounted here has no .sentence ancestor, so the
         indent box collapsed to the width of its single nbsp and a
         previewed paragraph break sat flush with the prose (owner's
         report, 2026-09-27). Restated here, next to the del/strong colors
         the same pipeline relies on, so the modal's preview indents like
         the book does. 2em of the shadow tree's own font size. */
      .scratch-diff .suggested-pindent {
        display: inline-block;
        width: 2em;
        text-indent: 0;
        white-space: pre;
      }
      /* The glyph inherits the diff color (green in an insert, struck red in
         a deletion) — only the un-diffed case needs the muted grey. */
      .scratch-diff .suggested-marker { font-weight: normal; }
      /* Footnotes (FOOTNOTES_PLAN.md): nothing paginates in here, so a
         note body shows inline, bracketed; a note ADDED or REMOVED whole by
         a suggestion shows as the diff-colored command icon instead
         (suggestions.js emits both; the page does the opposite). */
      .scratch-book .fn-body { font-size: 0.85em; color: #57503f; }
      .scratch-book .fn-body::before { content: " ⟦"; color: #a8a08c; }
      .scratch-book .fn-body::after { content: "⟧ "; color: #a8a08c; }
      .scratch-book .fn-body.fn-added, .scratch-book .fn-body.fn-removed { display: none; }
      .scratch-book .cmd-diamond { display: inline-block; line-height: 0; cursor: default; }
      .scratch-book .cmd-diamond svg { display: inline-block; vertical-align: middle; }
      .scratch-book .sentence,
      .scratch-book .sentence:not(.selected):hover {
        cursor: text;
        background: transparent !important;
      }
      .scratch-book .ph { cursor: default; }
      /* Mobile (matches scratchpad.css's widget block): serif render 20%
         smaller, text padding halved. Media queries are viewport-based, so
         they work inside the shadow tree. */
      @media (max-width: 640px) {
        .scratch-book { font-size: 8.5pt; padding: 7px 9px; }
      }
    `;
    root.appendChild(style);
    const div = document.createElement('div');
    div.className = 'scratch-book';
    root.appendChild(div);
    return div;
  },

  // render draws pseudo-sentences [{id, text}] as book content into host's
  // shadow.
  render(host, pseudoSentences) {
    const container = this.ensure(host);
    const r = window.WriteSysRenderer;
    container.innerHTML = r ? r.renderSentencesToHTML(pseudoSentences) : '';
    if (typeof smartquotes !== 'undefined') smartquotes.element(container);
    return container;
  },

  // renderHTML: PRE-RENDERED inline HTML (e.g. a red/green word diff) in
  // the same .scratch-book chrome/typography as render() — the one font
  // truth, so a diff view can never drift from the plain view.
  renderHTML(host, html) {
    const container = this.ensure(host);
    container.innerHTML = `<div class="scratch-diff">${html}</div>`;
    return container;
  },

  renderText(host, text) {
    return this.render(host, [{ id: 'scratch-preview', text: String(text || '') }]);
  },

  renderMessage(host, message) {
    const container = this.ensure(host);
    // escapeHTML: the app-wide escaper (text-markers.js, loaded before this
    // file on every page) — this had a private 2-entity copy that drifted.
    container.innerHTML = `<p style="font-family: Helvetica, sans-serif; font-size: 12px; color: #8a8378; text-align: center;">${
      escapeHTML(message)}</p>`;
    return container;
  },

};

if (typeof window !== 'undefined') {
  window.WriteSysScratchRender = WriteSysScratchRender;
}
