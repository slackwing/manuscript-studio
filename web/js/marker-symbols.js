// Marker symbols: per-user slug → shape map (settings "Markers" section).
// A &marker#slug wears its mapped shape everywhere the marker glyph
// renders — committed black, diff green/red — falling back to the
// default diamond. SHAPES keys mirror the Go handler's validation set
// (api/handlers/markers.go) — keep in lockstep. All shapes live in the
// same 9×13 box as the original lozenge so alignment CSS needs nothing new.
window.WriteSysMarkerSymbols = {
  // 'default' — the ※ reference mark — is the ONE universal default
  // (ATTENTION_PLAN.md §3): unconfigured markers wear it, new settings
  // rows start on it, and generic unknown commands use the same drawing
  // (UNKNOWN below). Listed first so the picker leads with it.
  SHAPES: {
    'default': '<g stroke="currentColor" stroke-width="1.4" stroke-linecap="round" fill="none">'
      + '<path d="M1.7 3.7 7.3 9.3M7.3 3.7 1.7 9.3"/></g>'
      + '<g fill="currentColor"><circle cx="4.5" cy="1.4" r="1"/><circle cx="4.5" cy="11.6" r="1"/>'
      + '<circle cx="0.9" cy="6.5" r="0.9"/><circle cx="8.1" cy="6.5" r="0.9"/></g>',
    diamond: '<path fill="currentColor" d="M4.5 0 9 6.5 4.5 13 0 6.5z"/>',
    'triangle-down': '<path fill="currentColor" d="M0 2.5h9L4.5 11.5z"/>',
    'triangle-up': '<path fill="currentColor" d="M4.5 1.5 9 10.5H0z"/>',
    circle: '<circle fill="currentColor" cx="4.5" cy="6.5" r="4.2"/>',
    square: '<path fill="currentColor" d="M0.7 2.7h7.6v7.6H0.7z"/>',
    spade: '<path fill="currentColor" d="M4.5 0.5C6.6 3.2 9 4.7 9 7.2 9 9.1 6.9 10 5.5 8.8 5.7 10.3 6.3 11.3 7.1 12H1.9C2.7 11.3 3.3 10.3 3.5 8.8 2.1 10 0 9.1 0 7.2 0 4.7 2.4 3.2 4.5 0.5Z"/>',
    heart: '<path fill="currentColor" d="M4.5 12.5C1.6 9.7 0 7.8 0 5.6 0 3.8 1.3 2.5 2.8 2.5 3.6 2.5 4.2 2.9 4.5 3.5 4.8 2.9 5.4 2.5 6.2 2.5 7.7 2.5 9 3.8 9 5.6 9 7.8 7.4 9.7 4.5 12.5Z"/>',
    club: '<circle fill="currentColor" cx="4.5" cy="3.7" r="2.5"/><circle fill="currentColor" cx="2.1" cy="7.6" r="2.1"/><circle fill="currentColor" cx="6.9" cy="7.6" r="2.1"/><path fill="currentColor" d="M4 8C4.2 9.9 3.6 11.2 2.8 12H6.2C5.4 11.2 4.8 9.9 5 8Z"/>',
  },
  // The DEFAULT symbol for unknown/general commands in diffs: the
  // reference mark ※ (an X with four compass dots) — chosen 2026-09-09 to
  // stop overloading the diamond, which now belongs to markers.
  UNKNOWN: '<g stroke="currentColor" stroke-width="1.4" stroke-linecap="round" fill="none">'
    + '<path d="M1.7 3.7 7.3 9.3M7.3 3.7 1.7 9.3"/></g>'
    + '<g fill="currentColor"><circle cx="4.5" cy="1.4" r="1"/><circle cx="4.5" cy="11.6" r="1"/>'
    + '<circle cx="0.9" cy="6.5" r="0.9"/><circle cx="8.1" cy="6.5" r="0.9"/></g>',
  map: {}, // slug → { symbol, attention }, loaded per user
  display: false, // settings toggle — OFF is the new-user default

  svgFor(slug) {
    const cfg = (slug && this.map[slug]) || null;
    const key = (cfg && cfg.symbol) || 'default';
    return '<svg width="9" height="13" viewBox="0 0 9 13" aria-hidden="true">'
      + (this.SHAPES[key] || this.SHAPES['default']) + '</svg>';
  },

  // Attention amplitude for a slug (ATTENTION_PLAN.md §2); 0 = neutral.
  attentionFor(slug) {
    const cfg = (slug && this.map[slug]) || null;
    return (cfg && cfg.attention) || 0;
  },

  unknownSvg() {
    return '<svg width="9" height="13" viewBox="0 0 9 13" aria-hidden="true">'
      + this.UNKNOWN + '</svg>';
  },

  async load() {
    try {
      const r = await fetch('api/marker-symbols', { credentials: 'same-origin' });
      if (r.ok) {
        const d = await r.json();
        this.map = d.markers || {};
        this.display = !!d.display;
      }
    } catch (e) { /* defaults — never block rendering */ }
  },
};
