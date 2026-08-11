// The house icon set — ONE definition per icon, sized at the call site.
// Plain script (loads before everything else); scratchpad modules reach it
// via window.WriteSysIcons since they run in the same document.
// DRY: home.js card-del, editor-core sn-trash, note-ref trash and the
// range-delete gutter button all draw THIS trash — never paste a new copy
// (and never an emoji: platform emoji fonts render clipped/off-center).
(function () {
  'use strict';

  const svg = (size, viewBox, attrs, body) =>
    `<svg width="${size}" height="${size}" viewBox="${viewBox}" ${attrs} aria-hidden="true">${body}</svg>`;

  window.WriteSysIcons = {
    // Filled trash can — the standard delete affordance (scratchpad cards,
    // variation widgets, range-delete).
    trash(size) {
      return svg(size, '0 0 16 16', 'fill="currentColor"',
        '<path d="M6.2 1.5h3.6l.5 1.1H13V4H3V2.6h2.7l.5-1.1zM4.1 5.2h7.8l-.55 8.4c-.06.85-.77 1.5-1.62 1.5H6.27c-.85 0-1.56-.65-1.62-1.5L4.1 5.2zm2.35 1.7l.3 6.3h.9l-.25-6.3h-.95zm3.1 0l-.25 6.3h.9l.3-6.3h-.95z"/>');
    },
    // Stroked trash — the lighter variant the sticky-note float uses.
    trashStroke(size) {
      return svg(size, '0 0 20 20', '',
        '<path d="M6 2h8M3 5h14M5 5l1 12h8l1-12M8 8v6M12 8v6" stroke="currentColor" fill="none" stroke-width="1.5" stroke-linecap="round"/>');
    },
    // Chain link — manuscript chips and variation link buttons.
    link(size) {
      return svg(size, '0 0 16 16', 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"',
        '<path d="M6.2 9.8l3.6-3.6"/><path d="M7.3 4.3l1.4-1.4a2.75 2.75 0 013.9 3.9l-1.4 1.4"/><path d="M8.7 11.7l-1.4 1.4a2.75 2.75 0 01-3.9-3.9l1.4-1.4"/>');
    },
    // Sparkles — "new variation from this" (the widget toolbars' mark).
    sparkles(size) {
      return svg(size, '0 0 20 20', 'fill="currentColor"',
        '<path d="M8 1.6l1.35 3.45L12.8 6.4 9.35 7.75 8 11.2 6.65 7.75 3.2 6.4l3.45-1.35z"/><path d="M14.8 9.4l.85 2.15 2.15.85-2.15.85-.85 2.15-.85-2.15-2.15-.85 2.15-.85z"/><path d="M8.4 13.6l.65 1.65 1.65.65-1.65.65-.65 1.65-.65-1.65-1.65-.65 1.65-.65z"/>');
    },
    // The SKETCH icon: two layered panes (variations of one passage). The
    // margin glyph of placed regions wears it.
    sketch(size) {
      return svg(size, '0 0 20 20', 'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"',
        '<rect x="3" y="6.5" width="10.5" height="10.5" rx="1.5"/><path d="M7 3.5h9.5v9.5"/>');
    },
  };
})();
