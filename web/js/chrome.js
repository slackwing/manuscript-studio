// ONE top bar (#controls) for every logged-in page. home.html, settings.html
// and index.html each carried a hand-copied version of this block and they
// drifted — the reader page lost the settings gear (DRY.md's exact failure
// mode: built on one surface, re-copied to the next). Pages now keep an empty
// <div id="controls" class="pagedjs_ignore"> shell; this script's tag sits
// IMMEDIATELY after that div and fills it synchronously, so every later
// script (global-search, cheatsheet — all of which bind on DOMContentLoaded
// or at end-of-body) finds the nodes in place.
//
// Per-page extras go in the shell's data-extras attribute (space-separated).
// Known extras: "cheatsheet" — the reader's syntax-panel toggle; its panel
// markup and cheatsheet.js live only on that page, this is just the icon.
(function () {
  const host = document.getElementById('controls');
  if (!host || host.children.length) return;
  const extras = (host.dataset.extras || '').split(/\s+/).filter(Boolean);

  const CHEATSHEET_ICON = `
      <span id="cheatsheet-icon" tabindex="0" role="button" aria-label="Syntax cheatsheet" aria-expanded="false" title="Syntax cheatsheet">
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path fill="currentColor" d="M2 2.75A1.75 1.75 0 0 1 3.75 1h6.5A1.75 1.75 0 0 1 12 2.75v10.5A1.75 1.75 0 0 1 10.25 15h-6.5A1.75 1.75 0 0 1 2 13.25V2.75zm1.75-.25a.25.25 0 0 0-.25.25v10.5c0 .138.112.25.25.25h6.5a.25.25 0 0 0 .25-.25V2.75a.25.25 0 0 0-.25-.25h-6.5zM4.5 4.75A.75.75 0 0 1 5.25 4h3.5a.75.75 0 0 1 0 1.5h-3.5a.75.75 0 0 1-.75-.75zm0 3A.75.75 0 0 1 5.25 7h3.5a.75.75 0 0 1 0 1.5h-3.5a.75.75 0 0 1-.75-.75zm0 3a.75.75 0 0 1 .75-.75h2a.75.75 0 0 1 0 1.5h-2a.75.75 0 0 1-.75-.75z"/>
        </svg>
      </span>`;
  const EXTRA_HTML = { cheatsheet: CHEATSHEET_ICON };

  host.innerHTML = `
    <div class="control-group control-group-left">
      <a id="home-link" href="home.html" title="Home" aria-label="Home">
        <svg viewBox="0 0 16 16" width="17" height="17" aria-hidden="true">
          <path fill="currentColor" d="M8 1 1 7h2v7h4v-4h2v4h4V7h2L8 1z"/>
        </svg>
      </a>
      <a id="brand" href="home.html">manuscript studio</a>
      <div id="global-search">
        <input id="gs-input" type="text" placeholder="Search" autocomplete="off">
        <div id="gs-dropdown" hidden></div>
      </div>
    </div>
    <div class="control-group control-group-right">
      <a id="settings-link" href="settings.html" title="Settings" aria-label="Settings">
        <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M8 4.75a3.25 3.25 0 100 6.5 3.25 3.25 0 000-6.5zM6.5 8a1.5 1.5 0 113 0 1.5 1.5 0 01-3 0z"/><path fill="currentColor" d="M9.4 1l.35 1.8c.4.14.78.33 1.13.55l1.73-.63 1.4 2.42-1.38 1.17a5.6 5.6 0 010 1.38l1.38 1.17-1.4 2.42-1.73-.63c-.35.22-.73.41-1.13.55L9.4 13H6.6l-.35-1.8a5.6 5.6 0 01-1.13-.55l-1.73.63L2 8.86l1.38-1.17a5.6 5.6 0 010-1.38L2 5.14l1.4-2.42 1.73.63c.35-.22.73-.41 1.13-.55L6.6 1h2.8z" fill-rule="evenodd" opacity="0.85"/></svg>
      </a>
      <button id="logout-btn" onclick="logout()">Logout</button>
      ${extras.map((k) => EXTRA_HTML[k] || '').join('')}
    </div>`;
})();
