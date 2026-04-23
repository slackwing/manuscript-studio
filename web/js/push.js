/**
 * Push-to-PR feature.
 *
 * Top-toolbar button that force-pushes the current user's unmerged
 * suggestions to the canonical `suggestions-{shortSHA}-{user}` branch on
 * the manuscript's GitHub repo. Single-user, single-branch per (commit,
 * user). See PUSH_FEATURE_PLAN.md.
 *
 *   - 0 suggestions → button hidden
 *   - N > 0         → "Push (N)" — clicking pushes immediately, no confirm
 *   - while in flight, the GitHub icon swaps for a spinner
 *   - dropdown ▼ appears once a branch exists, with one item: "View on GitHub"
 *
 * Branch existence + compare URL come from GET .../push-state — server
 * truth. Refreshed on init and after every successful push.
 */

const ICON_EXTERNAL = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M3.75 2A1.75 1.75 0 0 0 2 3.75v8.5C2 13.216 2.784 14 3.75 14h8.5A1.75 1.75 0 0 0 14 12.25v-3a.75.75 0 0 0-1.5 0v3a.25.25 0 0 1-.25.25h-8.5a.25.25 0 0 1-.25-.25v-8.5a.25.25 0 0 1 .25-.25h3a.75.75 0 0 0 0-1.5h-3zm6.854-1a.75.75 0 0 0 0 1.5h1.836L8.22 7.22a.75.75 0 1 0 1.06 1.06L13.5 4.06v1.836a.75.75 0 0 0 1.5 0V1.75A.75.75 0 0 0 14.25 1h-3.646z"/></svg>`;
const ICON_GITHUB = `<svg class="push-btn-gh" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>`;
const ICON_SPINNER = `<svg class="push-btn-spinner" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="2" stroke-opacity="0.3"/><path d="M14 8a6 6 0 0 0-6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;

const WriteSysPush = {
  apiBaseUrl: 'api',
  _container: null,
  _menuOpen: false,
  _branchExists: false, // server-reported
  _compareURL: '',      // server-computed; empty when no slug configured

  init() {
    this._container = document.getElementById('push-button-container');
    if (!this._container) return;
    document.addEventListener('click', (e) => {
      if (this._menuOpen && !this._container.contains(e.target)) {
        this._closeMenu();
      }
    });
    // Fire-and-forget; refresh() runs whether or not the lookup succeeds.
    this._loadBranchState().finally(() => this.refresh());
  },

  async _loadBranchState() {
    const r = window.WriteSysRenderer;
    if (!r || !r.manuscriptId || !r.currentMigrationID) {
      this._branchExists = false;
      return;
    }
    try {
      const data = await fetchJSON(
        `${this.apiBaseUrl}/manuscripts/${r.manuscriptId}/migrations/${r.currentMigrationID}/push-state`
      );
      this._branchExists = !!data.branch_exists;
      this._compareURL = data.compare_url || '';
    } catch (err) {
      console.warn('push-state lookup failed (defaulting to "new"):', err.message || err);
      this._branchExists = false;
      this._compareURL = '';
    }
  },

  // Re-renders the button to reflect current suggestion count + branch state.
  // Called after suggestion save/delete (frontend-only, no branch refetch).
  refresh() {
    if (!this._container) return;
    const count = this._suggestionCount();
    if (count === 0) {
      this._container.innerHTML = '';
      return;
    }

    const primaryLabel = `Push (${count})`;
    // Dropdown only carries the View-on-GitHub link, and only when there's a
    // branch + compare URL to point at.
    const showView = this._branchExists && !!this._compareURL;
    const primaryCls = showView ? 'push-btn-primary push-btn-grouped' : 'push-btn-primary push-btn-solo';

    const menuHtml = showView
      ? `<button type="button" class="push-btn-caret" aria-haspopup="true" aria-expanded="false">▼</button>
         <div class="push-menu" hidden>
           <a class="push-menu-item" href="${this._compareURL}" target="_blank" rel="noopener">
             <span class="push-menu-icon">${ICON_EXTERNAL}</span>
             <span class="push-menu-text">
               <span class="push-menu-label">View on GitHub</span>
               <span class="push-menu-desc">Open the compare page in a new tab.</span>
             </span>
           </a>
         </div>`
      : '';

    this._container.innerHTML = `<button type="button" class="${primaryCls}" data-action="update"><span class="push-btn-icon">${ICON_GITHUB}</span><span class="push-btn-label">${primaryLabel}</span></button>${menuHtml}`;

    const primary = this._container.querySelector('.push-btn-primary');
    const caret   = this._container.querySelector('.push-btn-caret');
    const menu    = this._container.querySelector('.push-menu');
    primary.addEventListener('click', () => this._push());
    if (caret && menu) {
      caret.addEventListener('click', (e) => {
        e.stopPropagation();
        this._toggleMenu();
      });
      // <a target="_blank"> handles its own navigation; just close the menu.
      menu.querySelector('.push-menu-item').addEventListener('click', () => this._closeMenu());
    }
  },

  _suggestionCount() {
    const s = window.WriteSysSuggestions;
    if (!s || !s.bySentenceId) return 0;
    return Object.keys(s.bySentenceId).length;
  },

  _toggleMenu() {
    const menu = this._container.querySelector('.push-menu');
    const caret = this._container.querySelector('.push-btn-caret');
    if (!menu || !caret) return;
    this._menuOpen = !this._menuOpen;
    menu.hidden = !this._menuOpen;
    caret.setAttribute('aria-expanded', String(this._menuOpen));
  },

  _closeMenu() {
    const menu = this._container.querySelector('.push-menu');
    const caret = this._container.querySelector('.push-btn-caret');
    if (menu) menu.hidden = true;
    if (caret) caret.setAttribute('aria-expanded', 'false');
    this._menuOpen = false;
  },

  // No confirm — pushing is non-destructive (force-push only touches a branch
  // dedicated to this user + commit). On success: silent (the icon stops
  // spinning and View on GitHub appears). On failure: alert, since a silent
  // failure would leave the user thinking it worked.
  async _push() {
    const r = window.WriteSysRenderer;
    if (!r || !r.manuscriptId || !r.currentMigrationID) {
      alert('Manuscript not loaded yet.');
      return;
    }
    try {
      this._setBusy(true);
      const url = `${this.apiBaseUrl}/manuscripts/${r.manuscriptId}/migrations/${r.currentMigrationID}/push-suggestions`;
      const resp = await authenticatedFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update' }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        if (resp.status === 409) {
          alert('Manuscript has been updated since this page loaded — please refresh.');
          return;
        }
        throw new Error(`HTTP ${resp.status}: ${body.slice(0, 300)}`);
      }
      const data = await resp.json();
      if (data.compare_url) this._compareURL = data.compare_url;
      // Skipped suggestions are rare and silent-success goes against showing
      // them — surface them only when the count is non-zero.
      if (data.skipped > 0) {
        alert(`${data.applied} pushed; ${data.skipped} skipped (originals not found in source).`);
      }
      await this._loadBranchState();
      this.refresh();
    } catch (err) {
      console.error('push failed:', err);
      alert(`Push failed: ${err.message || err}`);
    } finally {
      this._setBusy(false);
    }
  },

  // Spinner replaces the GitHub icon; clicks suppressed by `disabled`.
  _setBusy(busy) {
    if (!this._container) return;
    const btns = this._container.querySelectorAll('button');
    btns.forEach(b => b.disabled = busy);
    this._container.classList.toggle('push-busy', busy);
    const iconSlot = this._container.querySelector('.push-btn-icon');
    if (iconSlot) iconSlot.innerHTML = busy ? ICON_SPINNER : ICON_GITHUB;
  },
};

window.WriteSysPush = WriteSysPush;
