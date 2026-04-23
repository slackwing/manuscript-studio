/**
 * Manuscript picker (top-bar dropdown).
 *
 * Lives between the brand and the ⓘ icon. Lists the user's accessible
 * manuscripts. Selecting one navigates to ?manuscript_id=N (full reload —
 * the whole renderer is keyed on this ID, and a reload is the simplest
 * correct way to reset all loaded state).
 *
 * Also responsible for telling the server "this is my last opened
 * manuscript" once the page has loaded with a valid id, so the next login
 * lands here.
 */

const WriteSysPicker = {
  apiBaseUrl: 'api',
  accessible: [],          // [{name, manuscript_id}]
  currentId: null,
  currentName: '',

  async init() {
    const container = document.getElementById('manuscript-picker');
    if (!container) return;

    const session = await this._loadSession();
    if (!session) return;
    this.accessible = session.accessible_manuscripts || [];

    const urlParams = new URLSearchParams(window.location.search);
    const idStr = urlParams.get('manuscript_id');
    this.currentId = idStr ? parseInt(idStr, 10) : null;
    const match = this.accessible.find(m => m.manuscript_id === this.currentId);
    this.currentName = match ? match.name : '';

    this._render(container);

    // Persist last-opened so the next login lands on the same manuscript.
    // Only persist when the URL points at one we actually have access to —
    // otherwise we'd save garbage from a hand-typed URL.
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

  _render(container) {
    if (this.accessible.length === 0) {
      container.innerHTML = `<span class="manuscript-picker-empty">No manuscripts</span>`;
      return;
    }

    // Native <select> — accessible, keyboard-friendly, no custom popup needed.
    const opts = this.accessible.map(m =>
      `<option value="${m.manuscript_id}"${m.manuscript_id === this.currentId ? ' selected' : ''}>${escapeHTML(m.name)}</option>`
    ).join('');
    const placeholder = this.currentId
      ? ''
      : `<option value="" selected disabled>Select a manuscript…</option>`;
    container.innerHTML = `<select id="manuscript-picker-select" aria-label="Select manuscript">${placeholder}${opts}</select>`;

    const sel = container.querySelector('#manuscript-picker-select');
    sel.addEventListener('change', () => {
      const id = parseInt(sel.value, 10);
      if (!id || id === this.currentId) return;
      const url = new URL(window.location.href);
      url.searchParams.set('manuscript_id', String(id));
      window.location.href = url.toString();
    });
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
