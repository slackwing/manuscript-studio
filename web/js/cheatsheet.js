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
  SECTIONS: [
    {
      title: 'Block commands',
      note: 'Each stands ALONE on its own line — a blank line (paragraph) before and after. These populate the left-margin outline.',
      rows: [
        { code: '&title{The Wildfire}', desc: 'Book title — its own page.' },
        { code: '&part#p1{I.}{The Gathering}', desc: 'Part — its own page. {label} shows in the book; {description} shows only in the outline.' },
        { code: '&chapter#p1c1{1.}{Smoke on the ridge}', desc: 'Chapter heading. {label} in book, {description} in outline.' },
        { code: '&anchor#origin{Where it begins}', desc: 'A named waypoint. {label} shows in the outline (no book text).' },
        { code: '&meta{chapter-align}{center}', desc: 'A setting. Renders as nothing. See settings below.' },
      ],
    },
    {
      title: 'Inline commands',
      note: 'These live INSIDE a sentence, surrounded by prose. They do NOT appear in the outline.',
      rows: [
        { code: 'See &reference#origin{the opening}.', desc: 'A cross-reference link to a #slug defined elsewhere.' },
        { code: 'The fire &anchor#firemark{} spread.', desc: 'An inline anchor — a marker mid-sentence, not an outline entry.' },
      ],
    },
    {
      title: 'Slugs  (#slug)',
      note: 'Optional stable id after the keyword. Lowercase letters, digits, and dashes only: [a-z0-9-]. Slugs let references survive editing.',
      rows: [
        { code: '#p1c1   #act-one   #origin', desc: 'Valid slugs.' },
        { code: '#P1  #with_space  #café', desc: 'Invalid — rejected.' },
      ],
    },
    {
      title: '&meta settings',
      note: 'Fixed vocabulary. Last-wins. Renders as nothing.',
      rows: [
        { code: '&meta{title-align}{left|center}', desc: 'Title alignment.' },
        { code: '&meta{part-align}{left|center}', desc: 'Part-page alignment.' },
        { code: '&meta{chapter-align}{left|center}', desc: 'Chapter-heading alignment.' },
        { code: '&meta{divider-folios}{on|off}', desc: 'Page numbers on part/divider pages.' },
        { code: '&meta{font}{Georgia}', desc: 'Body font (any name).' },
      ],
    },
    {
      title: 'Gotchas',
      note: '',
      rows: [
        { code: '&anchor{X} then prose…', desc: 'On one line WITH trailing prose it becomes INLINE — it will NOT show in the outline. Put it on its own line (blank line after) to make it a block anchor.' },
        { code: 'Smith & Sons · R&D', desc: 'A bare "&" not followed by a keyword+{ is ordinary text.' },
        { code: '# Old markdown header', desc: 'Deprecated — now renders as literal prose. Use &chapter / &part instead.' },
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
