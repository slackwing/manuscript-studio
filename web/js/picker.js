/**
 * Manuscript picker (top-bar).
 *
 * Custom button + dropdown that visually mirrors the push split-button
 * (same shape, same caret, same menu panel) but in white. Selecting an
 * item navigates to ?manuscript_id=N.
 */

const ICON_BOOK = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M0 1.75A.75.75 0 0 1 .75 1h4.253c1.227 0 2.317.59 3 1.501A3.744 3.744 0 0 1 11.006 1h4.245a.75.75 0 0 1 .75.75v10.5a.75.75 0 0 1-.75.75h-4.507a2.25 2.25 0 0 0-1.591.659l-.622.621a.75.75 0 0 1-1.06 0l-.622-.621A2.25 2.25 0 0 0 5.258 13H.75a.75.75 0 0 1-.75-.75Zm7.251 10.324.004-5.073-.002-2.253A2.25 2.25 0 0 0 5.003 2.5H1.5v9h3.757a3.75 3.75 0 0 1 1.994.574ZM8.755 4.75l-.004 7.322a3.752 3.752 0 0 1 1.992-.572H14.5v-9h-3.495a2.25 2.25 0 0 0-2.25 2.25Z"/></svg>`;
const ICON_CHECK = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/></svg>`;

const WriteSysPicker = {
  apiBaseUrl: 'api',
  accessible: [],          // [{name, manuscript_id}]
  currentId: null,
  currentName: '',
  _container: null,
  _menuOpen: false,

  async init() {
    this._container = document.getElementById('manuscript-picker');
    if (!this._container) return;

    document.addEventListener('click', (e) => {
      if (this._menuOpen && !this._container.contains(e.target)) {
        this._closeMenu();
      }
    });

    const session = await this._loadSession();
    if (!session) return;
    this.accessible = session.accessible_manuscripts || [];

    const urlParams = new URLSearchParams(window.location.search);
    const idStr = urlParams.get('manuscript_id');
    this.currentId = idStr ? parseInt(idStr, 10) : null;
    const match = this.accessible.find(m => m.manuscript_id === this.currentId);
    this.currentName = match ? match.name : '';

    this._render();

    if (match) {
      this._persistLastOpened(match.name).catch(err => {
        console.warn('failed to persist last-opened manuscript:', err);
      });
    }
  },

  async _loadSession() {
    try {
      return await fetchJSON(`${this.apiBaseUrl}/session`);
    } catch (err) {
      console.warn('session lookup failed in picker:', err);
      return null;
    }
  },

  _render() {
    if (this.accessible.length === 0) {
      this._container.innerHTML = `<span class="manuscript-picker-empty">No manuscripts</span>`;
      return;
    }

    // Label: current manuscript name, or a placeholder when nothing's loaded
    // (URL had no/bad manuscript_id).
    const label = this.currentName || 'Pick a manuscript';

    // Same structure as push.js: primary button + caret + menu panel. The
    // primary itself opens the menu (vs. push, where the primary is the
    // action). That's the only behavioural difference.
    const itemsHtml = this.accessible.map(m => {
      const selected = m.manuscript_id === this.currentId;
      return `<button type="button" class="picker-menu-item${selected ? ' picker-menu-item-selected' : ''}" data-id="${m.manuscript_id}">
        <span class="picker-menu-check">${selected ? ICON_CHECK : ''}</span>
        <span class="picker-menu-name">${escapeHTML(m.name)}</span>
      </button>`;
    }).join('');

    this._container.innerHTML = `<button type="button" class="picker-btn-primary picker-btn-grouped" aria-haspopup="true" aria-expanded="false"><span class="picker-btn-icon">${ICON_BOOK}</span><span class="picker-btn-label">${escapeHTML(label)}</span></button><button type="button" class="picker-btn-caret" aria-haspopup="true" aria-expanded="false">▼</button><div class="picker-menu" hidden>${itemsHtml}</div>`;

    const primary = this._container.querySelector('.picker-btn-primary');
    const caret   = this._container.querySelector('.picker-btn-caret');
    const menu    = this._container.querySelector('.picker-menu');

    const toggle = (e) => { e.stopPropagation(); this._toggleMenu(); };
    primary.addEventListener('click', toggle);
    caret.addEventListener('click', toggle);

    menu.querySelectorAll('.picker-menu-item').forEach(el => {
      el.addEventListener('click', () => {
        const id = parseInt(el.dataset.id, 10);
        this._closeMenu();
        if (!id || id === this.currentId) return;
        const url = new URL(window.location.href);
        url.searchParams.set('manuscript_id', String(id));
        window.location.href = url.toString();
      });
    });
  },

  _toggleMenu() {
    const menu  = this._container.querySelector('.picker-menu');
    const btns  = this._container.querySelectorAll('[aria-haspopup="true"]');
    if (!menu) return;
    this._menuOpen = !this._menuOpen;
    menu.hidden = !this._menuOpen;
    btns.forEach(b => b.setAttribute('aria-expanded', String(this._menuOpen)));
  },

  _closeMenu() {
    const menu = this._container.querySelector('.picker-menu');
    const btns = this._container.querySelectorAll('[aria-haspopup="true"]');
    if (menu) menu.hidden = true;
    if (btns) btns.forEach(b => b.setAttribute('aria-expanded', 'false'));
    this._menuOpen = false;
  },

  async _persistLastOpened(name) {
    await authenticatedFetch(`${this.apiBaseUrl}/session/last-manuscript`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ manuscript_name: name }),
    });
  },
};

function escapeHTML(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

window.WriteSysPicker = WriteSysPicker;
