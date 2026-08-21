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
// Git commit glyph (dot on a line) for LOCAL manuscripts — the octocat is
// GitHub-specific, and "merge" would imply branch semantics local mode
// deliberately doesn't have (MANUSCRIPT_LIFECYCLE_PLAN §3).
const ICON_COMMIT = `<svg class="push-btn-commit" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M8 5.25a2.75 2.75 0 0 1 2.646 2H14.25a.75.75 0 0 1 0 1.5h-3.604a2.751 2.751 0 0 1-5.292 0H1.75a.75.75 0 0 1 0-1.5h3.604A2.75 2.75 0 0 1 8 5.25zm0 1.5a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5z"/></svg>`;

const WriteSysPush = {
  apiBaseUrl: 'api',
  _container: null,
  _menuOpen: false,
  _branchExists: false, // server-reported
  _compareURL: '',      // server-computed; empty when no slug configured
  _storage: 'github',   // 'github' | 'local' — drives label + icon + flow

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
      this._storage = data.storage || 'github';
    } catch (err) {
      console.warn('push-state lookup failed (defaulting to "new"):', err.message || err);
      this._branchExists = false;
      this._compareURL = '';
    }
  },

  _isLocal() { return this._storage === 'local'; },
  _icon() { return this._isLocal() ? ICON_COMMIT : ICON_GITHUB; },

  // Re-renders the button to reflect review state + branch state (v3:
  // pushes land ACCEPTED suggestions only — PERMISSIONS_PLAN §4).
  // Called after suggestion save/delete/review.
  refresh() {
    if (!this._container) return;
    const S = window.WriteSysSuggestions || {};
    const accepted = S.acceptedCount ? S.acceptedCount('all') : 0;
    const ownAccepted = S.acceptedCount ? S.acceptedCount('own') : 0;
    const ownPending = S.ownPendingCount ? S.ownPendingCount() : 0;
    if (accepted === 0 && ownPending === 0) {
      this._container.innerHTML = '';
      return;
    }

    // Primary: push/commit accepted edits; with nothing accepted yet the
    // button becomes the one-click "accept all my uncontested" step.
    const verb = this._isLocal() ? 'Commit' : 'Push';
    const primaryIsAccept = accepted === 0;
    const primaryLabel = primaryIsAccept ? `Accept mine (${ownPending})` : `${verb} (${accepted})`;

    const showView = !this._isLocal() && this._branchExists && !!this._compareURL;
    const items = [];
    if (!primaryIsAccept && ownPending > 0) {
      items.push({ act: 'accept', label: `Accept all my uncontested (${ownPending})`, desc: 'Marks your unchallenged edits accepted.' });
    }
    if (ownAccepted > 0 && ownAccepted !== accepted) {
      items.push({ act: 'push-own', label: `${verb} own accepted (${ownAccepted})`, desc: 'Leave others\' accepted edits behind.' });
    }
    const menuNeeded = showView || items.length > 0;
    const primaryCls = menuNeeded ? 'push-btn-primary push-btn-grouped' : 'push-btn-primary push-btn-solo';

    let menuHtml = '';
    if (menuNeeded) {
      const itemHtml = items.map(it => `
        <button type="button" class="push-menu-item" data-act="${it.act}">
          <span class="push-menu-text">
            <span class="push-menu-label">${it.label}</span>
            <span class="push-menu-desc">${it.desc}</span>
          </span>
        </button>`).join('');
      const viewHtml = showView ? `
        <a class="push-menu-item" data-act="view" href="${this._compareURL}" target="_blank" rel="noopener">
          <span class="push-menu-icon">${ICON_EXTERNAL}</span>
          <span class="push-menu-text">
            <span class="push-menu-label">View on GitHub</span>
            <span class="push-menu-desc">Open the compare page in a new tab.</span>
          </span>
        </a>` : '';
      menuHtml = `<button type="button" class="push-btn-caret" aria-haspopup="true" aria-expanded="false">▼</button>
        <div class="push-menu" hidden>${itemHtml}${viewHtml}</div>`;
    }

    this._container.innerHTML = `<button type="button" class="${primaryCls}" data-action="update"><span class="push-btn-icon">${this._icon()}</span><span class="push-btn-label">${primaryLabel}</span></button>${menuHtml}`;

    const primary = this._container.querySelector('.push-btn-primary');
    const caret   = this._container.querySelector('.push-btn-caret');
    const menu    = this._container.querySelector('.push-menu');
    primary.addEventListener('click', () => primaryIsAccept ? this._acceptOwn() : this._push('all-accepted'));
    if (caret && menu) {
      caret.addEventListener('click', (e) => {
        e.stopPropagation();
        this._toggleMenu();
      });
      menu.querySelectorAll('.push-menu-item').forEach(el => {
        el.addEventListener('click', () => {
          const act = el.dataset.act;
          this._closeMenu();
          if (act === 'accept') this._acceptOwn();
          else if (act === 'push-own') this._push('own-accepted');
          // 'view' is an <a target=_blank> — navigation handles itself.
        });
      });
    }
  },

  // Accept-all-own-uncontested → refresh counts (the button flips to Push).
  async _acceptOwn() {
    const r = window.WriteSysRenderer;
    if (!r || !r.currentMigrationID) return;
    try {
      this._setBusy(true);
      const resp = await authenticatedFetch(
        `${this.apiBaseUrl}/migrations/${r.currentMigrationID}/accept-own-uncontested`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      if (window.WriteSysSuggestions) await window.WriteSysSuggestions.loadForMigration(r.currentMigrationID);
      await r.renderManuscript({});
      this.refresh();
    } catch (err) {
      alert('Accept failed: ' + (err.message || err));
    } finally {
      this._setBusy(false);
    }
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
  async _push(scope) {
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
        body: JSON.stringify({ scope: scope || 'all-accepted' }),
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
        alert(`${data.applied} ${this._isLocal() ? 'committed' : 'pushed'}; ${data.skipped} skipped (originals not found in source).`);
      }
      if (this._isLocal()) {
        // Local commit = commit + migration in one request. The page's
        // migration is now superseded — wait for the new one, then reload
        // into it (the same "please refresh" the PR-merge flow needs, done
        // for you).
        await this._awaitLocalMigration(data.commit_sha);
        window.location.reload();
        return;
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

  // Poll until the just-committed SHA's migration is the latest (local mode
  // runs it in the same request's goroutine — typically a second or two).
  // Times out quietly; the reload then lands on the old migration and the
  // stale banner machinery takes over.
  async _awaitLocalMigration(commitSHA) {
    const r = window.WriteSysRenderer;
    if (!r || !r.manuscriptId || !commitSHA) return;
    for (let i = 0; i < 30; i++) {
      try {
        const data = await fetchJSON(`${this.apiBaseUrl}/migrations/latest?manuscript_id=${r.manuscriptId}`);
        if (data && data.commit_hash === commitSHA) return;
      } catch (e) { /* keep polling */ }
      await new Promise(res => setTimeout(res, 500));
    }
  },

  // Spinner replaces the icon; clicks suppressed by `disabled`.
  _setBusy(busy) {
    if (!this._container) return;
    const btns = this._container.querySelectorAll('button');
    btns.forEach(b => b.disabled = busy);
    this._container.classList.toggle('push-busy', busy);
    const iconSlot = this._container.querySelector('.push-btn-icon');
    if (iconSlot) iconSlot.innerHTML = busy ? ICON_SPINNER : this._icon();
  },
};

window.WriteSysPush = WriteSysPush;
