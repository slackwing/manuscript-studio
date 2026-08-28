/**
 * Manuscript action buttons (v3.3 — Slackwing's spec, 2026-08-21):
 * a uniform icon-button row in the chrome's controls strip:
 *
 *   [⚙ settings] [✓✗ accept ▾] [push/commit ▾] [view]
 *
 *   - ACCEPT pair: batch-accept is ALWAYS uncontested-only (contested
 *     sentences take manual verdicts in the suggest modal). Variants: my /
 *     everyone's — the shown variant is MINE unless I have none and others
 *     do; the caret menu carries the alternate. Disabled at zero.
 *   - PUSH pair: applies accepted suggestions. Variants: own / everyone's,
 *     same auto-selection. Verb is Push (github, octocat) or Commit
 *     (local, git glyph). Disabled at zero.
 *   - VIEW: the GitHub compare page — github mode only, disabled until the
 *     suggestions branch exists. Absent entirely on local manuscripts.
 *
 * All labels are icons; hover titles carry the words + counts.
 */

const ICON_EXTERNAL = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M3.75 2A1.75 1.75 0 0 0 2 3.75v8.5C2 13.216 2.784 14 3.75 14h8.5A1.75 1.75 0 0 0 14 12.25v-3a.75.75 0 0 0-1.5 0v3a.25.25 0 0 1-.25.25h-8.5a.25.25 0 0 1-.25-.25v-8.5a.25.25 0 0 1 .25-.25h3a.75.75 0 0 0 0-1.5h-3zm6.854-1a.75.75 0 0 0 0 1.5h1.836L8.22 7.22a.75.75 0 1 0 1.06 1.06L13.5 4.06v1.836a.75.75 0 0 0 1.5 0V1.75A.75.75 0 0 0 14.25 1h-3.646z"/></svg>`;
const ICON_GITHUB = `<svg class="mc-ic-github" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>`;
const ICON_SPINNER = `<svg class="push-btn-spinner" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="2" stroke-opacity="0.3"/><path d="M14 8a6 6 0 0 0-6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
// Git commit glyph (dot on a line) for LOCAL manuscripts.
const ICON_COMMIT = `<svg class="mc-ic-commit" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M8 5.25a2.75 2.75 0 0 1 2.646 2H14.25a.75.75 0 0 1 0 1.5h-3.604a2.751 2.751 0 0 1-5.292 0H1.75a.75.75 0 0 1 0-1.5h3.604A2.75 2.75 0 0 1 8 5.25zm0 1.5a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5z"/></svg>`;
// Green ✓ + red ✗ — the review pair (the accept-uncontested batch button;
// its counter reads reviewed/total, verdicts of both kinds).
const ICON_CHECKX = `<svg viewBox="0 0 24 16" width="21" height="14" aria-hidden="true"><g fill="none" stroke-width="2.2" stroke-linecap="round"><path stroke="#2e7d32" stroke-linejoin="round" d="M2 9l3 3 5-6"/><path stroke="#b03030" d="M15 5.5l6 6M21 5.5l-6 6"/></g></svg>`;
// Three person silhouettes — the "everyone's" variant marker.
const ICON_PERSONS3 = `<svg viewBox="0 0 34 16" width="26" height="13" aria-hidden="true"><g fill="currentColor"><circle cx="6" cy="5" r="2.6"/><path d="M1.5 14c0-2.8 2-4.6 4.5-4.6S10.5 11.2 10.5 14z"/><circle cx="17" cy="5" r="2.6"/><path d="M12.5 14c0-2.8 2-4.6 4.5-4.6s4.5 1.8 4.5 4.6z"/><circle cx="28" cy="5" r="2.6"/><path d="M23.5 14c0-2.8 2-4.6 4.5-4.6s4.5 1.8 4.5 4.6z"/></g></svg>`;

const WriteSysPush = {
  apiBaseUrl: 'api',
  _container: null,
  _openMenu: null,
  _branchExists: false, // server-reported
  _compareURL: '',      // server-computed; empty when no slug configured
  _storage: 'github',   // 'github' | 'local'

  init() {
    this._container = document.getElementById('push-button-container');
    if (!this._container) return;
    document.addEventListener('click', (e) => {
      if (this._openMenu && !this._openMenu.parentNode.contains(e.target)) this._closeMenus();
    });
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
      console.warn('push-state lookup failed:', err.message || err);
      this._branchExists = false;
      this._compareURL = '';
    }
  },

  _isLocal() { return this._storage === 'local'; },
  _verb() { return this._isLocal() ? 'Commit' : 'Push'; },
  _verbIcon() { return this._isLocal() ? ICON_COMMIT : ICON_GITHUB; },

  // A split pair: primary executes the shown variant; the caret menu holds
  // the alternate. Shown = own unless own is empty and everyone's isn't.
  _pairHTML(id, counts, icons, hints, labelExtras) {
    const variant = counts.own === 0 && counts.all > 0 ? 'all' : 'own';
    const alt = variant === 'own' ? 'all' : 'own';
    const icon = (v) => (v === 'all' ? `${icons.base}${ICON_PERSONS3}` : icons.base)
      + ((labelExtras && labelExtras[v]) || '');
    const title = (v) => `${hints[v]} (${counts[v]})`;
    return `<span class="mc-split" id="${id}-split" data-variant="${variant}">
      <button type="button" class="mc-btn" id="${id}-btn" data-variant="${variant}"
        title="${title(variant)}" ${counts[variant] === 0 ? 'disabled' : ''}>${icon(variant)}</button>
      <button type="button" class="mc-caret" aria-haspopup="true" aria-expanded="false">▾</button>
      <span class="mc-menu" hidden>
        <button type="button" class="mc-menu-item" data-variant="${alt}"
          title="${title(alt)}" ${counts[alt] === 0 ? 'disabled' : ''}>${icon(alt)}</button>
      </span>
    </span>`;
  },

  refresh() {
    if (!this._container) return;
    const S = window.WriteSysSuggestions || {};
    const A = window.WriteSysActions;
    const mid = A ? A.currentManuscriptId() : 0;
    const canReview = !!S.canReview;
    const canPush = A ? A.has(mid, 'commit-and-push-suggestions') : true;

    const pend = {
      own: S.uncontestedPendingCount ? S.uncontestedPendingCount('own') : 0,
      all: S.uncontestedPendingCount ? S.uncontestedPendingCount('all') : 0,
    };
    const acc = {
      own: S.acceptedCount ? S.acceptedCount('own') : 0,
      all: S.acceptedCount ? S.acceptedCount('all') : 0,
    };
    const verb = this._verb();

    let html = '';
    // "1": jump to the first suggested edit (opens its modal — the nav
    // flippers tour from there). The caret's alternate "1○" jumps to the
    // first UNACCEPTED (still-pending) one. Shown while suggestions live.
    const tour = S.suggestedOrder ? S.suggestedOrder() : [];
    const pendingTour = S.suggestedOrder ? S.suggestedOrder('pending') : [];
    if (tour.length) {
      html += `<span class="mc-split" id="first-split" data-variant="own">
        <button type="button" class="mc-btn" id="first-edit-btn" data-variant="own" title="Go to first suggested edit">1</button>
        <button type="button" class="mc-caret" aria-haspopup="true" aria-expanded="false">▾</button>
        <span class="mc-menu" hidden>
          <button type="button" class="mc-menu-item" data-variant="all" title="Go to first unaccepted suggested edit" ${pendingTour.length ? '' : 'disabled'}>1<span class="mc-first-sub">○</span></button>
        </span>
      </span>`;
    }
    if (canReview) {
      // The button wears its progress right of the ✓✗ — reviewed/total of
      // the SENTENCES carrying suggestions (a sentence is reviewed only
      // when every suggested edit on it has a verdict).
      const rs = S.reviewedSentences ? S.reviewedSentences() : { reviewed: 0, total: 0 };
      const ownCount = `<span class="mc-count">${rs.reviewed}/${rs.total}</span>`;
      html += this._pairHTML('accept', pend, { base: ICON_CHECKX },
        { own: 'Accept my uncontested', all: "Accept everyone's uncontested" },
        { own: ownCount });
    }
    if (canPush) {
      html += this._pairHTML('push', acc, { base: this._verbIcon() },
        { own: `${verb} own accepted`, all: `${verb} everyone's accepted` });
      if (!this._isLocal()) {
        const viewable = this._branchExists && !!this._compareURL;
        html += viewable
          ? `<a class="mc-btn" id="view-btn" href="${this._compareURL}" target="_blank" rel="noopener" title="View on GitHub">${ICON_EXTERNAL}</a>`
          : `<button type="button" class="mc-btn" id="view-btn" disabled title="View on GitHub — nothing pushed yet">${ICON_EXTERNAL}</button>`;
      }
    }
    this._container.innerHTML = html;


    this._container.querySelectorAll('.mc-split').forEach(split => {
      const id = split.id.replace('-split', '');
      const act = (variant) => id === 'first' ? this._gotoFirst(variant)
        : id === 'accept' ? this._accept(variant) : this._push(variant);
      const primary = split.querySelector('.mc-btn');
      primary.addEventListener('click', () => act(primary.dataset.variant));
      const caret = split.querySelector('.mc-caret');
      const menu = split.querySelector('.mc-menu');
      caret.addEventListener('click', (e) => {
        e.stopPropagation();
        const opening = menu.hidden;
        this._closeMenus();
        if (opening) {
          menu.hidden = false;
          caret.setAttribute('aria-expanded', 'true');
          this._openMenu = menu;
        }
      });
      menu.querySelector('.mc-menu-item').addEventListener('click', (e) => {
        this._closeMenus();
        act(e.currentTarget.dataset.variant);
      });
    });
  },

  _closeMenus() {
    this._container.querySelectorAll('.mc-menu').forEach(m => { m.hidden = true; });
    this._container.querySelectorAll('.mc-caret').forEach(c => c.setAttribute('aria-expanded', 'false'));
    this._openMenu = null;
  },

  // "1" split: own = first suggested edit; all = first UNACCEPTED one.
  _gotoFirst(variant) {
    const S = window.WriteSysSuggestions || {};
    const list = S.suggestedOrder ? S.suggestedOrder(variant === 'all' ? 'pending' : undefined) : [];
    if (!list.length) return;
    if (window.WriteSysRenderer && window.WriteSysRenderer.scrollToSentence) {
      window.WriteSysRenderer.scrollToSentence(list[0]);
    }
    S.openModal(list[0]);
  },

  async _accept(variant) {
    const r = window.WriteSysRenderer;
    if (!r || !r.currentMigrationID) return;
    // Batch accepts are a click away from changing the manuscript — confirm.
    const S = window.WriteSysSuggestions || {};
    const n = S.uncontestedPendingCount ? S.uncontestedPendingCount(variant) : 0;
    if (!window.confirm(variant === 'own'
      ? `Accept ${n} uncontested suggested edit${n === 1 ? '' : 's'}?`
      : `Accept ${n} uncontested suggested edit${n === 1 ? '' : 's'} from everyone?`)) return;
    try {
      this._setBusy('accept');
      const resp = await authenticatedFetch(
        `${this.apiBaseUrl}/migrations/${r.currentMigrationID}/accept-uncontested`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scope: variant }),
        });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      if (window.WriteSysSuggestions) await window.WriteSysSuggestions.loadForMigration(r.currentMigrationID);
      await r.renderManuscript({});
    } catch (err) {
      alert('Accept failed: ' + (err.message || err));
    } finally {
      this.refresh();
    }
  },

  // No confirm — pushing is non-destructive for github (force-push touches
  // only the dedicated branch); local commits are the point. Failures alert.
  async _push(variant) {
    const r = window.WriteSysRenderer;
    if (!r || !r.manuscriptId || !r.currentMigrationID) return;
    try {
      this._setBusy('push');
      const url = `${this.apiBaseUrl}/manuscripts/${r.manuscriptId}/migrations/${r.currentMigrationID}/push-suggestions`;
      const resp = await authenticatedFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: variant === 'own' ? 'own-accepted' : 'all-accepted' }),
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
      if (data.skipped > 0) {
        alert(`${data.applied} ${this._isLocal() ? 'committed' : 'pushed'}; ${data.skipped} skipped.`);
      }
      if (this._isLocal()) {
        // Commit + migration in one request; wait for the new migration and
        // reload into it.
        await this._awaitLocalMigration(data.commit_sha);
        window.location.reload();
        return;
      }
      await this._loadBranchState();
    } catch (err) {
      console.error('push failed:', err);
      alert(`${this._verb()} failed: ${err.message || err}`);
    } finally {
      this.refresh();
    }
  },

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

  // Disable everything; spin the acting pair's primary.
  _setBusy(which) {
    if (!this._container) return;
    this._container.querySelectorAll('button, a').forEach(b => { b.disabled = true; });
    const btn = this._container.querySelector(`#${which}-btn`);
    if (btn) btn.innerHTML = ICON_SPINNER;
  },
};

window.WriteSysPush = WriteSysPush;
