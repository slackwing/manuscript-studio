/**
 * Push-to-PR feature.
 *
 * Top-toolbar split-button that pushes the current user's unmerged suggestions
 * as a real branch on the manuscript's GitHub repo. See PUSH_FEATURE_PLAN.md.
 *
 * Single-user only: each user pushes their OWN suggestions to their OWN branch.
 *
 * Label adapts:
 *   - 0 suggestions → button hidden
 *   - existing branch for (commit, user) → "Push (N)"
 *   - no existing branch                  → "Push New (N)"
 * The dropdown ▼ exposes the alternate action (Push New / Push).
 *
 * Branch existence is sourced from GET .../push-state — server truth, not
 * client guess. Refreshed on init and after every successful push.
 */

const WriteSysPush = {
  apiBaseUrl: 'api',
  _container: null,
  _menuOpen: false,
  _branchExists: false, // server-reported

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
    } catch (err) {
      console.warn('push-state lookup failed (defaulting to "new"):', err.message || err);
      this._branchExists = false;
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

    const isUpdate = this._branchExists;
    const primaryLabel = isUpdate ? `Push (${count})` : `Push New (${count})`;
    const primaryAction = isUpdate ? 'update' : 'new';
    // No existing branch → only "Push New" makes sense. Hide the dropdown
    // (a "Push" option without a branch to update would 404 or worse).
    const altLabel  = isUpdate ? `Push New (${count})` : null;
    const altAction = isUpdate ? 'new' : null;

    const ghIcon = `<svg class="push-btn-gh" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>`;
    const primaryCls = altAction ? 'push-btn-primary push-btn-grouped' : 'push-btn-primary push-btn-solo';
    const caretHtml = altAction
      ? `<button type="button" class="push-btn-caret" aria-haspopup="true" aria-expanded="false">▼</button>
         <div class="push-menu" hidden>
           <button type="button" class="push-menu-item" data-action="${altAction}">${altLabel}</button>
         </div>`
      : '';

    this._container.innerHTML = `<button type="button" class="${primaryCls}" data-action="${primaryAction}">${ghIcon}<span class="push-btn-label">${primaryLabel}</span></button>${caretHtml}`;

    const primary = this._container.querySelector('.push-btn-primary');
    const caret   = this._container.querySelector('.push-btn-caret');
    const menu    = this._container.querySelector('.push-menu');
    primary.addEventListener('click', () => this._confirmAndPush(primaryAction, count));
    if (caret && menu) {
      caret.addEventListener('click', (e) => {
        e.stopPropagation();
        this._toggleMenu();
      });
      menu.querySelector('.push-menu-item').addEventListener('click', () => {
        this._closeMenu();
        this._confirmAndPush(altAction, count);
      });
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

  async _confirmAndPush(action, count) {
    const r = window.WriteSysRenderer;
    if (!r || !r.manuscriptId || !r.currentMigrationID) {
      alert('Manuscript not loaded yet.');
      return;
    }
    const verb = action === 'update' ? 'Push' : 'Push New';
    const ok = confirm(`${verb} ${count} suggested edit(s) as a branch on GitHub?\n\nA pull request can be opened from the link shown after pushing.`);
    if (!ok) return;

    try {
      this._setBusy(true);
      const url = `${this.apiBaseUrl}/manuscripts/${r.manuscriptId}/migrations/${r.currentMigrationID}/push-suggestions`;
      const resp = await authenticatedFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
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

      const skippedNote = data.skipped > 0
        ? `\n\n${data.skipped} suggestion(s) were skipped (originals not found in source).`
        : '';
      if (data.compare_url) {
        const open = confirm(
          `Pushed ${data.applied} edit(s) to branch "${data.branch}".${skippedNote}\n\nOpen the GitHub compare page now?`
        );
        if (open) window.open(data.compare_url, '_blank', 'noopener');
      } else {
        alert(`Pushed ${data.applied} edit(s) to branch "${data.branch}".${skippedNote}`);
      }
      // Refresh from server so label flips to "Push" after a successful "new".
      await this._loadBranchState();
      this.refresh();
    } catch (err) {
      console.error('push failed:', err);
      alert(`Push failed: ${err.message || err}`);
    } finally {
      this._setBusy(false);
    }
  },

  _setBusy(busy) {
    if (!this._container) return;
    const btns = this._container.querySelectorAll('button');
    btns.forEach(b => b.disabled = busy);
    this._container.classList.toggle('push-busy', busy);
  },
};

window.WriteSysPush = WriteSysPush;
