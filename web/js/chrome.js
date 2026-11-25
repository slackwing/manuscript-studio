// ONE top bar (#controls) for every logged-in page. home.html, settings.html
// and index.html each carried a hand-copied version of this block and they
// drifted — the reader page lost the settings gear (DRY.md's exact failure
// mode: built on one surface, re-copied to the next). Pages now keep an empty
// <div id="controls" class="pagedjs_ignore"> shell; this script's tag sits
// IMMEDIATELY after that div and fills it synchronously, so every later
// script (global-search, cheatsheet — all of which bind on DOMContentLoaded
// or at end-of-body) finds the nodes in place.
//
// Per-page extras go in the shell's data-extras attribute (space-separated);
// none are defined today (the syntax cheatsheet became a TAB, 2026-11-25:
// the ⓘ between the gear and Logout opens it on every page).
(function () {
  const host = document.getElementById('controls');
  if (!host || host.children.length) return;
  const extras = (host.dataset.extras || '').split(/\s+/).filter(Boolean);

  // Library-of-America binding: the chrome wears a real buckram tile
  // (web/img/cloth-*.jpg, cut from an actual LOA spine photo), a random
  // dye each load — red, green, or blue. Set synchronously (this script
  // runs right after the #controls div) so the header never flashes.
  // The tile url() literals live in chrome.css (a url() smuggled through an
  // inline-style custom property resolves against the STYLESHEET base in
  // Chromium and the document base in Firefox — a class dodges both).
  const DYES = { red: '#7e5a62', green: '#488367', blue: '#3d5c73' };
  const dye = Object.keys(DYES)[Math.floor(Math.random() * 3)];
  document.documentElement.classList.add('cloth-' + dye);
  document.documentElement.style.setProperty('--cloth-dye', DYES[dye]);

  const EXTRA_HTML = {};

  host.innerHTML = `
    <div class="control-group control-group-left">
      <a id="brand" href="home.html">manuscript studio</a>
      <div id="global-search">
        <input id="gs-input" type="text" placeholder="Search" autocomplete="off">
        <div id="gs-dropdown" hidden></div>
      </div>
    </div>
    <div class="control-group control-group-right">
      <a id="settings-link" href="settings.html" title="Settings" aria-label="Settings">
        <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M8 4.75a3.25 3.25 0 100 6.5 3.25 3.25 0 000-6.5zM6.5 8a1.5 1.5 0 113 0 1.5 1.5 0 01-3 0z"/><path fill="currentColor" d="M9.4 1l.35 1.8c.4.14.78.33 1.13.55l1.73-.63 1.4 2.42-1.38 1.17a5.6 5.6 0 010 1.38l1.38 1.17-1.4 2.42-1.73-.63c-.35.22-.73.41-1.13.55L9.4 13H6.6l-.35-1.8a5.6 5.6 0 01-1.13-.55l-1.73.63L2 8.86l1.38-1.17a5.6 5.6 0 010-1.38L2 5.14l1.4-2.42 1.73.63c.35-.22.73-.41 1.13-.55L6.6 1h2.8z" fill-rule="evenodd" opacity="0.85"/></svg>
      </a>
      <a id="cheatsheet-link" href="cheatsheet.html" title="Syntax" aria-label="Syntax">
        <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true"><circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="5" r="1" fill="currentColor"/><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" d="M8 7.4v4"/></svg>
      </a>
      <button id="logout-btn" onclick="logout()" title="Logout" aria-label="Logout">
        <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M6 2h5a1 1 0 0 1 1 1v2h-1.5V3.5H6.5v9H10.5V11H12v2a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/><path fill="currentColor" d="M10.5 5.5 14 8l-3.5 2.5V9H7.5V7h3V5.5z"/></svg>
      </button>
      ${extras.map((k) => EXTRA_HTML[k] || '').join('')}
    </div>`;

  // Pinned-tabs shell: the row under the bar (tabs.js owns state/render;
  // hidden until something is pinned).
  if (!document.getElementById('ms-tabs')) {
    host.insertAdjacentHTML('afterend',
      '<div id="ms-tabs" class="pagedjs_ignore" hidden></div>');
  }
})();
