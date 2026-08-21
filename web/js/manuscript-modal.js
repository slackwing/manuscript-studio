/**
 * Manuscript create/settings modal (MANUSCRIPT_LIFECYCLE_PLAN §2, §4).
 *
 * ONE field schema drives BOTH modes — add a field here and it appears in
 * the creation modal and (if editableAfterCreate) the settings modal, so the
 * two can never drift. Immutable fields render read-only in settings mode.
 *
 * Create mode: POST api/manuscripts (local storage only in v1), then poll
 * the bootstrap migration and navigate into the new book.
 * Settings mode: PATCH api/manuscripts/{id}/meta with the editable fields,
 * then dispatch 'manuscript-modal-saved' so hosts (home page, stats pane)
 * can refresh.
 */
const WriteSysManuscriptModal = {
  // ---- the one schema ---------------------------------------------------
  // type: text | date | number | storage (custom radio row)
  // createOnly fields render only in create mode; others render in both,
  // as inputs when editableAfterCreate, read-only otherwise.
  FIELDS: [
    { key: 'display_name', label: 'Title', type: 'text', required: true,
      editableAfterCreate: true, placeholder: 'The Great Novel' },
    { key: 'name', label: 'Slug', type: 'text', createOnly: false,
      editableAfterCreate: false, derivedFromTitle: true,
      hint: 'URL-safe id; also the on-disk repo folder name' },
    { key: 'storage', label: 'Storage', type: 'storage',
      editableAfterCreate: false },
    { key: 'birthday', label: 'Birthday', type: 'date',
      editableAfterCreate: true, hint: 'the day writing began' },
    { key: 'word_goal', label: 'Word goal', type: 'number',
      editableAfterCreate: true, placeholder: '40000' },
  ],

  _mode: null,        // 'create' | 'settings'
  _manuscript: null,  // settings mode: the row from GET meta
  _nameTouched: false,

  csrf() { return window.getCSRFToken ? (window.getCSRFToken() || '') : ((localStorage.getItem('csrf_token') || sessionStorage.getItem('csrf_token')) || ''); },

  esc(t) {
    return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },

  slugify(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  },

  openCreate() { this._open('create', null); },

  async openSettings(manuscriptId) {
    let m;
    try {
      const r = await fetch(`api/manuscripts/${manuscriptId}/meta`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      m = await r.json();
    } catch (e) {
      alert('Failed to load manuscript settings: ' + e.message);
      return;
    }
    this._open('settings', m);
  },

  _open(mode, manuscript) {
    this.close();
    this._mode = mode;
    this._manuscript = manuscript;
    this._nameTouched = false;

    const overlay = document.createElement('div');
    overlay.id = 'msm-overlay';
    overlay.innerHTML = `<div class="msm-box" role="dialog" aria-modal="true">
      <h3>${mode === 'create' ? 'Create new manuscript' : 'Manuscript settings'}</h3>
      <form id="msm-form">${this.FIELDS.map(f => this._fieldHTML(f)).join('')}
        <p class="msm-error" id="msm-error" hidden></p>
        <div class="msm-actions">
          <button type="button" id="msm-cancel">Cancel</button>
          <button type="submit" id="msm-go">${mode === 'create' ? 'Create' : 'Save'}</button>
        </div>
      </form>
    </div>`;
    document.body.appendChild(overlay);

    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) this.close(); });
    overlay.querySelector('#msm-cancel').addEventListener('click', () => this.close());
    this._escHandler = (e) => { if (e.key === 'Escape') this.close(); };
    document.addEventListener('keydown', this._escHandler);

    // Title → slug derivation (until the user edits the slug by hand).
    const title = overlay.querySelector('[name="display_name"]');
    const slug = overlay.querySelector('[name="name"]');
    if (title && slug && this._mode === 'create') {
      slug.addEventListener('input', () => { this._nameTouched = true; });
      title.addEventListener('input', () => {
        if (!this._nameTouched) slug.value = this.slugify(title.value);
      });
    }

    overlay.querySelector('#msm-form').addEventListener('submit', (e) => {
      e.preventDefault();
      if (this._mode === 'create') this._create(); else this._save();
    });
    if (title) title.focus();

    // Settings mode: user-access management (PERMISSIONS_PLAN v3) — list
    // everyone's roles; add/revoke per the viewer's manage-role-* powers.
    if (mode === 'settings') this._mountAccessSection(overlay);
  },

  async _mountAccessSection(overlay) {
    const host = document.createElement('div');
    host.className = 'msm-access';
    overlay.querySelector('#msm-form').insertBefore(host, overlay.querySelector('#msm-error'));
    const id = this._manuscript.manuscript_id;
    let data;
    try {
      const r = await fetch(`api/manuscripts/${id}/people`);
      if (!r.ok) return; // no access info — leave the section out
      data = await r.json();
    } catch (e) { return; }
    const manageable = data.manageable_roles || [];

    const render = () => {
      const rows = (data.members || []).map(m => {
        const chips = (m.roles || []).map(role => {
          const removable = manageable.includes(role);
          return `<span class="msm-role-chip" data-user="${this.esc(m.username)}" data-role="${this.esc(role)}">${this.esc(role)}${removable ? '<button type="button" class="msm-role-x" title="Revoke">×</button>' : ''}</span>`;
        }).join('');
        return `<div class="msm-access-row"><span class="msm-access-user">${this.esc(m.username)}</span>${chips}</div>`;
      }).join('');
      const addForm = manageable.length ? `
        <div class="msm-access-add">
          <input type="text" id="msm-add-user" placeholder="username">
          <select id="msm-add-role">${manageable.map(r => `<option>${this.esc(r)}</option>`).join('')}</select>
          <button type="button" id="msm-add-go">Add</button>
        </div>` : '';
      host.innerHTML = `<div class="msm-label">Users &amp; roles</div>${rows || '<div class="msm-hint">Nobody yet.</div>'}${addForm}`;

      host.querySelectorAll('.msm-role-x').forEach(btn => {
        btn.addEventListener('click', async () => {
          const chip = btn.closest('.msm-role-chip');
          const resp = await fetch(`api/manuscripts/${id}/roles`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrf() },
            body: JSON.stringify({ username: chip.dataset.user, role: chip.dataset.role }),
          });
          if (resp.status === 409) { this._error('Cannot remove the last admin.'); return; }
          if (!resp.ok) { this._error(await resp.text()); return; }
          const m = data.members.find(x => x.username === chip.dataset.user);
          if (m) m.roles = m.roles.filter(r => r !== chip.dataset.role);
          data.members = data.members.filter(x => x.roles.length);
          render();
        });
      });
      const go = host.querySelector('#msm-add-go');
      if (go) go.addEventListener('click', async () => {
        const username = host.querySelector('#msm-add-user').value.trim();
        const role = host.querySelector('#msm-add-role').value;
        if (!username) return;
        const resp = await fetch(`api/manuscripts/${id}/roles`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrf() },
          body: JSON.stringify({ username, role }),
        });
        if (!resp.ok) { this._error(await resp.text()); return; }
        let m = data.members.find(x => x.username === username);
        if (!m) { m = { username, roles: [] }; data.members.push(m); }
        if (!m.roles.includes(role)) m.roles.push(role);
        render();
      });
    };
    render();
  },

  _fieldHTML(f) {
    const m = this._manuscript || {};
    const inSettings = this._mode === 'settings';
    const value = m[f.key] != null ? m[f.key] : '';

    if (f.type === 'storage') {
      if (inSettings) {
        return this._roRow(f.label, m.storage === 'local'
          ? 'local (server-owned repo)'
          : `github (${this.esc(m.git_repo_name || '')} · ${this.esc(m.git_branch || 'main')})`);
      }
      return `<label class="msm-row"><span class="msm-label">${f.label}</span>
        <span class="msm-radio-row">
          <label class="msm-radio"><input type="radio" name="storage" value="local" checked> local
            <span class="msm-hint-inline">server-owned repo; commit &amp; migrate in one click</span></label>
          <label class="msm-radio msm-disabled"><input type="radio" name="storage" value="github" disabled> github
            <span class="msm-hint-inline">sync an external repo — coming with the repo picker</span></label>
        </span></label>`;
    }

    if (inSettings && !f.editableAfterCreate) {
      return this._roRow(f.label, f.key === 'birthday' && value ? String(value).slice(0, 10) : String(value));
    }
    if (inSettings && f.createOnly) return '';

    let v = value;
    if (f.type === 'date' && v) v = String(v).slice(0, 10);
    if (f.type === 'number' && !v) v = '';
    // `required` only gates CREATION — a legacy row with an empty display
    // name must still be able to save other settings (an empty field is
    // simply omitted from the PATCH).
    const required = f.required && this._mode === 'create';
    return `<label class="msm-row"><span class="msm-label">${f.label}${required ? ' *' : ''}</span>
      <input type="${f.type}" name="${f.key}" value="${this.esc(v)}"
        ${f.placeholder ? `placeholder="${this.esc(f.placeholder)}"` : ''}
        ${required ? 'required' : ''} ${f.type === 'number' ? 'min="1"' : ''}>
      ${f.hint ? `<span class="msm-hint">${f.hint}</span>` : ''}</label>`;
  },

  _roRow(label, value) {
    return `<div class="msm-row msm-ro"><span class="msm-label">${label}</span>
      <span class="msm-ro-value">${this.esc(value || '—')}</span></div>`;
  },

  _values() {
    const form = document.getElementById('msm-form');
    const out = {};
    this.FIELDS.forEach(f => {
      const el = form.querySelector(`[name="${f.key}"]${f.type === 'storage' ? ':checked' : ''}`);
      if (!el) return;
      let v = el.value.trim();
      if (v === '') return;
      if (f.type === 'number') v = parseInt(v, 10);
      out[f.key] = v;
    });
    return out;
  },

  _error(msg) {
    const el = document.getElementById('msm-error');
    if (el) { el.textContent = msg; el.hidden = false; }
    const go = document.getElementById('msm-go');
    if (go) go.disabled = false;
  },

  async _create() {
    const go = document.getElementById('msm-go');
    go.disabled = true;
    const v = this._values();
    let r;
    try {
      r = await fetch('api/manuscripts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrf() },
        body: JSON.stringify(v),
      });
    } catch (e) { this._error('Network error: ' + e.message); return; }
    if (!r.ok) { this._error(await r.text()); return; }
    const created = await r.json();
    const id = created.manuscript.manuscript_id;

    // The bootstrap migration of a seeded one-liner is fast — poll briefly,
    // then open the book.
    go.textContent = 'Creating…';
    for (let i = 0; i < 30; i++) {
      try {
        const lr = await fetch(`api/migrations/latest?manuscript_id=${id}`);
        if (lr.ok) { window.location.href = `./?manuscript_id=${id}`; return; }
      } catch (e) { /* keep polling */ }
      await new Promise(res => setTimeout(res, 500));
    }
    // Bootstrap slow/failed — land on home; the card shows "not synced yet".
    window.dispatchEvent(new CustomEvent('manuscript-modal-saved'));
    this.close();
  },

  async _save() {
    const go = document.getElementById('msm-go');
    go.disabled = true;
    const v = this._values();
    const patch = {};
    this.FIELDS.filter(f => f.editableAfterCreate).forEach(f => {
      if (v[f.key] !== undefined) patch[f.key] = f.type === 'number' ? v[f.key] : String(v[f.key]);
    });
    if (!Object.keys(patch).length) { this.close(); return; }
    let r;
    try {
      r = await fetch(`api/manuscripts/${this._manuscript.manuscript_id}/meta`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrf() },
        body: JSON.stringify(patch),
      });
    } catch (e) { this._error('Network error: ' + e.message); return; }
    if (!r.ok) { this._error(await r.text()); return; }
    window.dispatchEvent(new CustomEvent('manuscript-modal-saved', { detail: { manuscript_id: this._manuscript.manuscript_id } }));
    this.close();
  },

  close() {
    const el = document.getElementById('msm-overlay');
    if (el) el.remove();
    if (this._escHandler) {
      document.removeEventListener('keydown', this._escHandler);
      this._escHandler = null;
    }
  },
};

if (typeof window !== 'undefined') {
  window.WriteSysManuscriptModal = WriteSysManuscriptModal;
  // Book page: the ⚙ beside the title ("The Wildfire ⚙") opens settings
  // for the loaded manuscript (MANUSCRIPT_LIFECYCLE_PLAN §4).
  const wireGear = () => {
    const gear = document.getElementById('mc-settings');
    if (!gear) return;
    gear.addEventListener('click', () => {
      const id = new URLSearchParams(window.location.search).get('manuscript_id');
      if (id) WriteSysManuscriptModal.openSettings(parseInt(id, 10));
    });
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireGear);
  } else {
    wireGear();
  }
  // A saved title change should show up in the strip without a reload.
  window.addEventListener('manuscript-modal-saved', async (e) => {
    const nameEl = document.getElementById('mc-name');
    const id = e.detail && e.detail.manuscript_id;
    if (!nameEl || !id) return;
    try {
      const r = await fetch(`api/manuscripts/${id}/meta`);
      if (r.ok) {
        const m = await r.json();
        nameEl.textContent = m.display_name || m.name;
      }
    } catch (err) { /* next reload will catch up */ }
  });
}
