/**
 * View toggles — row 3 of the manuscript chrome (2026-11-25; until then
 * the statistics pane's "markers · attention · footnotes" row):
 *
 *   [◆ markers] [∩ attention] [1 footnotes]
 *
 * Markers / footnotes: the renderer owns the state and re-paginates
 * without the hidden layer (renderer.setLayerHidden; markers start OFF,
 * footnotes on). Attention: the touch counterpart of holding Tab
 * (ATTENTION_PLAN.md §5) — click pins the envelope on, click again
 * releases. Same gates as before: markers only for eyes that can see a
 * marker glyph; attention only with see-attention. While a layer reflows
 * or the attention overlay is still building the button sits disabled
 * with a spinner (same width — the row never re-wraps).
 */
const WriteSysLayerToggles = {
  el: null,

  init() {
    this.el = document.getElementById('layer-button-container');
    if (!this.el) return;
    document.addEventListener('ms:attention-rebuilt', () => this.refresh());
    document.addEventListener('ms:layers-reflowed', () => this.sync());
    document.addEventListener('ms:session-restored', () => this.refresh());
    this.refresh();
  },

  refresh() {
    if (!this.el) return;
    const R = window.WriteSysRenderer;
    const A = window.WriteSysAttention;
    const Act = window.WriteSysActions;
    const I = window.WriteSysIcons || {};
    const icon = (name, size) => (typeof I[name] === 'function' ? I[name](size) : '');
    const attnDenied = window.currentSession && !(Act && Act.has(Act.currentManuscriptId(), 'see-attention'));
    const attnReady = !!(A && A._pages && A._pages.length);
    const attnOn = !!(A && A.pinned);
    const mkDenied = window.currentSession && !(R && (R.canSeeMarkers() || R.canSeeCommandGlyphs()));
    const hidden = (R && R.hiddenLayers) || {};
    const reflowing = (R && R.reflowingLayers) || {};
    const layer = (kind, body, title) =>
      `<button type="button" id="mc-${kind}" class="mc-btn mc-toggle" data-layer="${kind}" title="${title}" aria-label="${title}"`
      + ` aria-pressed="${!hidden[kind]}"${reflowing[kind] ? ' disabled' : ''}>${body}</button>`;
    const attn = attnDenied ? ''
      : `<button type="button" id="mc-attention" class="mc-btn mc-toggle" title="Attention" aria-label="Attention"`
      + ` aria-pressed="${attnOn}"${attnReady ? '' : ' disabled'}>${icon('bellCurve', 14)}</button>`;
    this.el.innerHTML = (mkDenied ? '' : layer('markers', icon('diamond', 12), 'Markers'))
      + attn
      + layer('footnotes', '<span class="mc-num">1</span>', 'Footnotes');
    this.wire();
  },

  wire() {
    const R = window.WriteSysRenderer;
    const attn = this.el.querySelector('#mc-attention');
    if (attn) {
      attn.addEventListener('click', () => {
        const on = window.WriteSysAttention.togglePinned();
        attn.setAttribute('aria-pressed', String(on));
      });
    }
    if (!R) return;
    this.el.querySelectorAll('.mc-toggle[data-layer]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const kind = btn.dataset.layer;
        const hide = !R.hiddenLayers[kind];
        btn.setAttribute('aria-pressed', String(!hide));
        R.setLayerHidden(kind, hide);
        this.sync();
      });
    });
  },

  // Disabled + spinner while the layer's re-pagination runs.
  sync() {
    const R = window.WriteSysRenderer;
    if (!this.el || !R) return;
    this.el.querySelectorAll('.mc-toggle[data-layer]').forEach((btn) => {
      btn.disabled = !!R.reflowingLayers[btn.dataset.layer];
    });
  },
};

if (typeof window !== 'undefined') {
  window.WriteSysLayerToggles = WriteSysLayerToggles;
  document.addEventListener('DOMContentLoaded', () => WriteSysLayerToggles.init());
}
