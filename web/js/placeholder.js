/**
 * &placeholder rendering (PLACEHOLDER_PLAN.md).
 *
 * A placeholder reserves believable space for unwritten prose: invisible
 * lorem filler that justifies and wraps exactly like real text, painted with
 * a diagonal hatch that reads as one merged silhouette across lines.
 *
 * The hatch geometry is phase-aligned by construction:
 *   - tile: 6.4px SVG diagonal hatch (TILE)
 *   - book line-height: 12pt * 1.6 = 25.6px = 4 tiles, so stacked rows land
 *     on the same pattern phase
 *   - paragraph indent: 2em = 32px = 5 tiles
 *   - row bridge: vertical padding measured at runtime from the rendered
 *     font's real metrics (Linux substitutes Georgia, so it can't be
 *     hardcoded) makes line fragments butt-joint into one silhouette
 *   - phase nudge: an inline placeholder's first fragment starts mid-line at
 *     an arbitrary x; a 0-5px spacer shifts its start onto a tile boundary
 *     (invisible inside justified word-spacing)
 *
 * layoutPass() runs after paged.js finishes (pagedjs-config afterRendered and
 * renderer re-renders) — same hook family as the rainbow side-bars.
 */
const WriteSysPlaceholder = {
  TILE: 6.4,

  // Deterministic filler: the classic lorem sentence pool. Seeded per
  // placeholder (slug, else label, else signature) so the same command
  // renders the same silhouette on every render/session, but different
  // placeholders don't look like copies of one stamp.
  LOREM: [
    'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
    'Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.',
    'Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.',
    'Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.',
    'Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium, totam rem aperiam.',
    'Nemo enim ipsam voluptatem quia voluptas sit aspernatur aut odit aut fugit, sed quia consequuntur magni dolores eos qui ratione.',
    'Neque porro quisquam est, qui dolorem ipsum quia dolor sit amet, consectetur, adipisci velit, sed quia non numquam eius modi tempora.',
    'At vero eos et accusamus et iusto odio dignissimos ducimus qui blanditiis praesentium voluptatum deleniti atque corrupti.',
  ],

  esc(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  },

  // mulberry32 PRNG over a simple string hash — tiny and deterministic.
  rng(seedStr) {
    let h = 2166136261 >>> 0;
    for (const ch of String(seedStr)) {
      h ^= ch.codePointAt(0);
      h = Math.imul(h, 16777619);
    }
    let a = h >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  },

  seedOf(spec, slug) {
    return slug || spec.label || (spec.unit + spec.size);
  },

  fillerSentences(count, rand) {
    const out = [];
    let last = -1;
    for (let i = 0; i < count; i++) {
      let pick = Math.floor(rand() * this.LOREM.length);
      if (pick === last) pick = (pick + 1) % this.LOREM.length;
      out.push(this.LOREM[pick]);
      last = pick;
    }
    return out.join(' ');
  },

  // Each filler paragraph is 3-5 sentences — about the length of lorem
  // ipsum's classic first paragraph, with seeded variation.
  fillerParagraphs(count, rand) {
    const out = [];
    for (let i = 0; i < count; i++) {
      out.push(this.fillerSentences(3 + Math.floor(rand() * 3), rand));
    }
    return out;
  },

  // The details chip: shows "#slug — label" and the details text. Inline
  // placeholders suppress it until hover; the block form overlays it
  // persistently, centered on the region.
  chipInnerHTML(spec, slug) {
    const head = [slug ? '#' + slug : '', spec.label].filter(Boolean).join(' — ');
    const headHtml = head ? `<span class="ph-chip-head">${this.esc(head)}</span>` : '';
    const detailsHtml = spec.details ? this.esc(spec.details) : '';
    if (!headHtml && !detailsHtml) return '';
    return headHtml + detailsHtml;
  },

  // Inline (sentences-unit) placeholder: a .ph run of invisible filler inside
  // the host sentence, chip on hover. Also used when a sentences-unit
  // placeholder is the sole content of its own line (it becomes a one-run
  // paragraph). aria-hidden + unselectable: the filler must never leak into
  // copy/paste, search, or a screen reader.
  inlineHTML(spec, slug) {
    const rand = this.rng(this.seedOf(spec, slug));
    const filler = this.fillerSentences(spec.count, rand);
    const chip = this.chipInnerHTML(spec, slug);
    const chipHtml = chip ? `<span class="ph-chip" aria-hidden="true">${chip}</span>` : '';
    const slugAttr = slug ? ` data-slug="${this.esc(slug)}"` : '';
    return `<span class="ph"${slugAttr} aria-hidden="true">${chipHtml}${this.esc(filler)}</span>`;
  },

  // Block (paragraphs-unit) placeholder: N filler paragraphs in a wrapper,
  // details chip overlaid persistently. Every span carries the sentence id so
  // the whole region stays hoverable/annotatable as one sentence.
  blockHTML(spec, slug, id, changed, escapeHtml, markerCls) {
    const rand = this.rng(this.seedOf(spec, slug));
    const paras = this.fillerParagraphs(spec.count, rand);
    const slugAttr = slug ? ` data-slug="${this.esc(slug)}"` : '';
    const chCls = changed ? ' cmd-suggested' : '';
    const body = paras.map((p, i) => {
      // First filler paragraph inherits the placeholder's own structural
      // marker (\n\t indent / \n\n section); the rest indent as usual.
      const cls = i === 0 ? (markerCls ? ` class="${markerCls}"` : '') : ' class="indented"';
      return `<p${cls}><span class="sentence ph" data-sentence-id="${escapeHtml(id)}" aria-hidden="true">${this.esc(p)}</span></p>`;
    }).join('');
    const chip = this.chipInnerHTML(spec, slug);
    // Overlay first in DOM order: if paged.js splits the block across pages,
    // the chip rides the FIRST page fragment (where the region starts).
    const overlay = chip ? `<div class="ph-overlay" aria-hidden="true"><div class="ph-chip-block">${chip}</div></div>` : '';
    return `<div class="cmd-placeholder${chCls}"${slugAttr}>${overlay}${body}</div>`;
  },

  // ---- post-pagination layout pass -------------------------------------

  // Row bridge: half the gap between the paragraph line-height and the
  // rendered font's content-box height. Measured inside a real paged page so
  // the metrics match the book context (font substitution, &meta{font}).
  tunePad() {
    const host = document.querySelector('.pagedjs_page_content') || document.body;
    const p = document.createElement('p');
    p.style.cssText = 'position:absolute;visibility:hidden;margin:0';
    const probe = document.createElement('span');
    probe.textContent = 'Hxg';
    p.appendChild(probe);
    host.appendChild(p);
    const lh = parseFloat(getComputedStyle(p).lineHeight) || 25.6;
    const pad = Math.max(0, (lh - probe.getBoundingClientRect().height) / 2);
    p.remove();
    document.documentElement.style.setProperty('--ph-pad', pad.toFixed(2) + 'px');
  },

  // Phase nudge: shift each inline placeholder's start onto the next tile
  // boundary so its first fragment's diagonals mesh with the rows below.
  // The nudge itself reflows justification, so measure-and-repeat; bail out
  // whenever the placeholder doesn't actually wrap (single fragment).
  nudge() {
    const TILE = this.TILE;
    document.querySelectorAll('.pagedjs_pages .ph').forEach(ph => {
      let sp = ph.previousElementSibling;
      if (sp && !sp.classList.contains('ph-nudge')) sp = null;
      const rectsOf = () => Array.from(ph.getClientRects()).filter(r => r.width > 1 && r.height > 1);
      for (let i = 0; i < 4; i++) {
        const r = rectsOf();
        if (r.length < 2) break;
        let off = (((r[1].left - r[0].left) % TILE) + TILE) % TILE;
        if (off < 0.35 || off > TILE - 0.35) break;
        if (!sp) {
          sp = document.createElement('span');
          sp.className = 'ph-nudge';
          ph.parentNode.insertBefore(sp, ph);
        }
        // Take the shorter path: right by off, or left by off - TILE. Small
        // negative margins hide in justified word-spacing just as well.
        const shift = off <= TILE / 2 ? off : off - TILE;
        const cur = parseFloat(sp.style.marginLeft) || 0;
        sp.style.marginLeft = (cur + shift).toFixed(2) + 'px';
      }
    });
  },

  layoutPass() {
    if (!document.querySelector('.pagedjs_pages .ph')) return;
    this.tunePad();
    this.nudge();
  },
};

if (typeof window !== 'undefined') {
  window.WriteSysPlaceholder = WriteSysPlaceholder;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = WriteSysPlaceholder;
}
