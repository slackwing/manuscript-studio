/**
 * Syntax cheatsheet — a slide-in right panel toggled by #cheatsheet-icon.
 *
 * A quick reference for the &-command grammar. Content is grounded in the real
 * parser (command.js / internal/sentence/command.go): block commands stand
 * alone on their own line (own paragraph); inline commands live inside a
 * sentence's prose. Kept deliberately terse — this is a reminder, not docs.
 */
const WriteSysCheatsheet = {
  iconEl: null,
  panelEl: null,
  backdropEl: null,
  open: false,

  init() {
    this.iconEl = document.getElementById('cheatsheet-icon');
    this.panelEl = document.getElementById('cheatsheet-panel');
    this.backdropEl = document.getElementById('cheatsheet-backdrop');
    if (!this.iconEl || !this.panelEl) return;

    this.panelEl.innerHTML = this.buildHTML();

    this.iconEl.addEventListener('click', () => this.toggle());
    this.iconEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.toggle(); }
    });
    if (this.backdropEl) this.backdropEl.addEventListener('click', () => this.setOpen(false));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.open) this.setOpen(false);
    });
    // Delegate the close button inside the panel.
    this.panelEl.addEventListener('click', (e) => {
      if (e.target.closest('.cheatsheet-close')) this.setOpen(false);
    });
  },

  toggle() { this.setOpen(!this.open); },

  setOpen(v) {
    this.open = v;
    this.panelEl.classList.toggle('is-open', v);
    this.panelEl.setAttribute('aria-hidden', v ? 'false' : 'true');
    this.iconEl.setAttribute('aria-expanded', v ? 'true' : 'false');
    this.iconEl.classList.toggle('is-active', v);
    if (this.backdropEl) this.backdropEl.hidden = !v;
  },

  // Each row: { code, desc }. A section groups rows under a heading with an
  // optional note. code is shown verbatim (monospace), desc as prose.
  // Each row: { code, desc }. Terse by design (2026-08-20): one example,
  // one line of description — try it in the editor to learn the rest.
  SECTIONS: [
    {
      title: 'Block commands',
      note: 'Alone on their own line. These build the left-margin outline.',
      rows: [
        { code: '&title{The Wildfire}', desc: 'Book title page.' },
        { code: '&part#p1{I.}{The Gathering}', desc: 'Part page — {description} shows in the outline only.' },
        { code: '&chapter#p1c1{1.}{Smoke on the ridge}', desc: 'Chapter heading.' },
        { code: '&anchor#origin{Where it begins}', desc: 'Outline waypoint — renders nothing.' },
        { code: '&placeholder#reunion{paragraphs}{m}{Reunion}{notes}', desc: 'Hatched space for unwritten prose — sizes xs–xxxl.' },
        { code: '&end#reunion', desc: 'Closes a placed region (Canonize writes these).' },
      ],
    },
    {
      title: 'Inline commands',
      note: 'Mid-sentence, inside prose.',
      rows: [
        { code: 'See &reference#origin{the opening}.', desc: 'Link to a #slug.' },
        { code: 'The fire &anchor#mark{} spread.', desc: 'Inline marker.' },
        { code: 'She waited. &placeholder{sentences}{l}', desc: 'Inline hatched space.' },
      ],
    },
    {
      title: 'Formatting',
      note: '',
      rows: [
        { code: '*emphasis*  or  _emphasis_', desc: 'Italics.' },
        { code: '#my-slug-2', desc: 'Slugs: lowercase letters, digits, dashes.' },
      ],
    },
    {
      title: '&meta settings',
      note: 'Its own line; renders nothing; last one wins.',
      rows: [
        { code: '&meta{title-align}{left|center}', desc: 'Title alignment.' },
        { code: '&meta{part-align}{left|center}', desc: 'Part-page alignment.' },
        { code: '&meta{chapter-align}{left|center}', desc: 'Chapter-heading alignment.' },
        { code: '&meta{divider-folios}{on|off}', desc: 'Page numbers on divider pages.' },
        { code: '&meta{font}{Georgia}', desc: 'Body font.' },
      ],
    },
  ],

  buildHTML() {
    const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const rowHTML = (r) => `<div class="cheatsheet-row">` +
      `<code class="cheatsheet-code">${esc(r.code)}</code>` +
      `<div class="cheatsheet-desc">${esc(r.desc)}</div>` +
      `</div>`;
    const sectionHTML = (s) => `<section class="cheatsheet-section">` +
      `<h3 class="cheatsheet-h">${esc(s.title)}</h3>` +
      (s.note ? `<p class="cheatsheet-note">${esc(s.note)}</p>` : '') +
      s.rows.map(rowHTML).join('') +
      `</section>`;
    return `<div class="cheatsheet-inner">` +
      `<div class="cheatsheet-header">` +
      `<span class="cheatsheet-title">Syntax cheatsheet</span>` +
      `<button class="cheatsheet-close" aria-label="Close cheatsheet" title="Close">&times;</button>` +
      `</div>` +
      `<div class="cheatsheet-body">` +
      this.SECTIONS.map(sectionHTML).join('') +
      `</div></div>`;
  },
};

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => WriteSysCheatsheet.init());
  } else {
    WriteSysCheatsheet.init();
  }
}
if (typeof window !== 'undefined') window.WriteSysCheatsheet = WriteSysCheatsheet;
