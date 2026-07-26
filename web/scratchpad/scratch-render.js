/**
 * Book rendering inside the scratchpad (SCRATCHPAD_PLAN.md §6): reuses the
 * REAL pipeline — WriteSysRenderer.renderSentencesToHTML — inside a shadow
 * root that links book.css, so book typography (and the placeholder hatch
 * geometry) applies without leaking page-wide book styles into the editor.
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
    link.href = 'css/book.css?v=100';
    root.appendChild(link);
    const style = document.createElement('style');
    style.textContent = `
      /* Shadow scope: body-level book typography must be restated (body
         selectors don't match inside a shadow tree), and the interactive
         affordances are neutralized — this view is read-only. */
      .scratch-book {
        font-family: var(--book-font, Georgia, serif);
        font-size: 12pt;
        line-height: 1.6;
        color: #1a1a1a;
        background: #fff;
        padding: 14px 18px;
      }
      /* Widgets are working views, not pages: left-justify prose. */
      .scratch-book p { text-align: left; }
      .scratch-book .sentence,
      .scratch-book .sentence:not(.selected):hover {
        cursor: text;
        background: transparent !important;
      }
      .scratch-book .ph { cursor: default; }
    `;
    root.appendChild(style);
    const div = document.createElement('div');
    div.className = 'scratch-book';
    root.appendChild(div);
    return div;
  },

  // render draws pseudo-sentences [{id, text}] as book content into host's
  // shadow, then runs the placeholder hatch layout pass scoped to it.
  render(host, pseudoSentences) {
    const container = this.ensure(host);
    const r = window.WriteSysRenderer;
    container.innerHTML = r ? r.renderSentencesToHTML(pseudoSentences) : '';
    if (typeof smartquotes !== 'undefined') smartquotes.element(container);
    this.layoutPass(container);
    return container;
  },

  renderText(host, text) {
    return this.render(host, [{ id: 'scratch-preview', text: String(text || '') }]);
  },

  renderMessage(host, message) {
    const container = this.ensure(host);
    container.innerHTML = `<p style="font-family: Helvetica, sans-serif; font-size: 12px; color: #8a8378; text-align: center;">${
      String(message).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>`;
    return container;
  },

  // Placeholder hatch geometry, scoped to a shadow container (the book
  // page's WriteSysPlaceholder.layoutPass queries the paged document — a
  // shadow tree is invisible to it, so the scratchpad runs its own pass).
  layoutPass(container) {
    if (!container.querySelector('.ph')) return;
    const probeP = document.createElement('p');
    probeP.style.cssText = 'position:absolute;visibility:hidden;margin:0';
    const probe = document.createElement('span');
    probe.textContent = 'Hxg';
    probeP.appendChild(probe);
    container.appendChild(probeP);
    const lh = parseFloat(getComputedStyle(probeP).lineHeight) || 25.6;
    const pad = Math.max(0, (lh - probe.getBoundingClientRect().height) / 2);
    probeP.remove();
    container.style.setProperty('--ph-pad', pad.toFixed(2) + 'px');

    const TILE = (window.WriteSysPlaceholder && window.WriteSysPlaceholder.TILE) || 6.4;
    container.querySelectorAll('.ph').forEach(ph => {
      let sp = ph.previousElementSibling;
      if (sp && !sp.classList.contains('ph-nudge')) sp = null;
      for (let i = 0; i < 4; i++) {
        const r = Array.from(ph.getClientRects()).filter(x => x.width > 1 && x.height > 1);
        if (r.length < 2) break;
        const off = (((r[1].left - r[0].left) % TILE) + TILE) % TILE;
        if (off < 0.35 || off > TILE - 0.35) break;
        if (!sp) {
          sp = document.createElement('span');
          sp.className = 'ph-nudge';
          ph.parentNode.insertBefore(sp, ph);
        }
        const shift = off <= TILE / 2 ? off : off - TILE;
        const cur = parseFloat(sp.style.marginLeft) || 0;
        sp.style.marginLeft = (cur + shift).toFixed(2) + 'px';
      }
    });
  },
};

if (typeof window !== 'undefined') {
  window.WriteSysScratchRender = WriteSysScratchRender;
}
