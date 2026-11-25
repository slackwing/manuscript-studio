/**
 * Syntax cheatsheet — the content of cheatsheet.html (a tab, opened by the
 * ⓘ between the gear and Logout; 2026-11-25).
 *
 * EXTREMELY terse by design: the command shapes, nothing else. `<name>` is
 * an argument (2026-11-25: named, not "…"), `a|b` the choices. What a line
 * does is for the author to try in the editor; this is a reminder, not
 * documentation.
 */
const WriteSysCheatsheet = {
  SECTIONS: [
    {
      title: 'Alone on a line',
      rows: [
        '&title{<title>}',
        '&part#<slug>{<numeral>}{<title>}',
        '&chapter#<slug>{<number>}{<title>}',
        '&anchor#<slug>{<label>}',
        '&placeholder#<slug>{sentences|paragraphs}{xs|s|m|l|xl|xxl|xxxl}{<label>}',
        '&sketch#<id>{<text>} … &end#<id>',
      ],
    },
    {
      title: 'Inside a sentence',
      rows: [
        '&reference#<slug>{<text>}',
        '&anchor#<slug>{}',
        '&marker#<slug>{weak|strong}',
        '&footnote{<text>}',
        '&placeholder{sentences|paragraphs}{<size>}',
      ],
    },
    {
      title: 'Text',
      rows: [
        '*italic*   **bold**',
        '<slug>  =  a-z 0-9 -',
      ],
    },
    {
      // Front matter: these count only before the first prose sentence
      // (sentence.ExtractSettings / command.js extractSettings, 2026-11-25).
      title: 'Top of manuscript',
      rows: [
        '&meta{title-align|part-align|chapter-align}{left|center}',
        '&meta{divider-folios}{on|off}',
        '&meta{footnote-marks}{numbers|symbols}',
        '&meta{footnote-reset}{page|chapter|never}',
        '&meta{font}{<font>}',
      ],
    },
  ],

  render(root) {
    if (!root) return;
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    root.innerHTML = this.SECTIONS.map((s) =>
      `<section class="cheatsheet-section"><h3 class="cheatsheet-h">${esc(s.title)}</h3>`
      + s.rows.map((r) => `<div class="cheatsheet-row"><code class="cheatsheet-code">${esc(r)}</code></div>`).join('')
      + '</section>').join('');
  },

  init() { this.render(document.getElementById('cheatsheet-root')); },
};

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => WriteSysCheatsheet.init());
  else WriteSysCheatsheet.init();
}
if (typeof window !== 'undefined') window.WriteSysCheatsheet = WriteSysCheatsheet;
