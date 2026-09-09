// Marker symbols: per-user slug → shape map (settings "Markers" section).
// A &marker#slug wears its mapped shape everywhere the marker glyph
// renders — committed black, diff green/red — falling back to the
// default diamond. SHAPES keys mirror the Go handler's validation set
// (api/handlers/markers.go) — keep in lockstep. All shapes live in the
// same 9×13 box as the original lozenge so alignment CSS needs nothing new.
window.WriteSysMarkerSymbols = {
  SHAPES: {
    diamond: '<path fill="currentColor" d="M4.5 0 9 6.5 4.5 13 0 6.5z"/>',
    'triangle-down': '<path fill="currentColor" d="M0 2.5h9L4.5 11.5z"/>',
    'triangle-up': '<path fill="currentColor" d="M4.5 1.5 9 10.5H0z"/>',
    circle: '<circle fill="currentColor" cx="4.5" cy="6.5" r="4.2"/>',
    square: '<path fill="currentColor" d="M0.7 2.7h7.6v7.6H0.7z"/>',
  },
  map: {}, // slug → shape key, loaded per user

  svgFor(slug) {
    const key = (slug && this.map[slug]) || 'diamond';
    return '<svg width="9" height="13" viewBox="0 0 9 13" aria-hidden="true">'
      + (this.SHAPES[key] || this.SHAPES.diamond) + '</svg>';
  },

  async load() {
    try {
      const r = await fetch('api/marker-symbols', { credentials: 'same-origin' });
      if (r.ok) this.map = (await r.json()).symbols || {};
    } catch (e) { /* default diamonds — never block rendering */ }
  },
};
