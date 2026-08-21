/**
 * People pane (PERMISSIONS_PLAN.md v3 §6): the third tab beside
 * Outline/Statistics. Lists everyone with a role on the manuscript —
 * default order: role seniority, then account age — and lets the VIEWER
 * drag-reorder. That order is the suggestion-display priority: the top
 * person's fresh suggestion wins the red/green diff on any contested
 * sentence, so reordering re-renders the manuscript.
 */
const WriteSysPeople = {
  apiBaseUrl: 'api',
  el: null,
  manuscriptId: 0,
  data: null, // {members, order, manageable_roles, all_roles}

  init() {
    this.el = document.getElementById('people-margin');
    const idStr = new URLSearchParams(window.location.search).get('manuscript_id');
    this.manuscriptId = idStr ? parseInt(idStr, 10) : 0;
  },

  async load() {
    if (!this.manuscriptId) return;
    try {
      this.data = await fetchJSON(`${this.apiBaseUrl}/manuscripts/${this.manuscriptId}/people`, {}, true);
    } catch (e) {
      this.data = null;
    }
    this.render();
  },

  esc(t) {
    return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },

  render() {
    if (!this.el) return;
    if (!this.data) {
      this.el.innerHTML = '<div class="people-pane"><div class="stats-empty">People unavailable.</div></div>';
      return;
    }
    const byName = {};
    (this.data.members || []).forEach(m => { byName[m.username] = m; });
    const rows = (this.data.order || []).map(u => {
      const m = byName[u];
      if (!m) return '';
      return `<div class="people-row" draggable="true" data-user="${this.esc(u)}">
        <span class="people-grip" title="Drag to reorder — the top person's suggestion wins the diff">⠿</span>
        <span class="people-letter">${this.esc((u[0] || '?').toUpperCase())}</span>
        <span class="people-name">${this.esc(u)}</span>
        <span class="people-roles">${(m.roles || []).map(r => this.esc(r)).join(' · ')}</span>
      </div>`;
    }).join('');
    this.el.innerHTML = `<div class="people-pane">
      <div class="people-hint">Top person's suggestion wins the diff. Drag to reorder (yours only).</div>
      <div class="people-list">${rows}</div>
    </div>`;
    this.wireDrag();
  },

  wireDrag() {
    const list = this.el.querySelector('.people-list');
    if (!list) return;
    let dragging = null;
    list.querySelectorAll('.people-row').forEach(row => {
      row.addEventListener('dragstart', (e) => {
        dragging = row;
        row.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        // Firefox needs data set for the drag to start at all.
        e.dataTransfer.setData('text/plain', row.dataset.user);
      });
      row.addEventListener('dragend', () => {
        if (dragging) dragging.classList.remove('dragging');
        dragging = null;
        this.saveOrder();
      });
      row.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (!dragging || dragging === row) return;
        const r = row.getBoundingClientRect();
        const before = e.clientY < r.top + r.height / 2;
        row.parentNode.insertBefore(dragging, before ? row : row.nextSibling);
      });
    });
  },

  async saveOrder() {
    const order = [...this.el.querySelectorAll('.people-row')].map(r => r.dataset.user);
    if (!order.length) return;
    try {
      const resp = await authenticatedFetch(`${this.apiBaseUrl}/manuscripts/${this.manuscriptId}/people-order`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order }),
      });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      this.data.order = order;
      // The order IS the diff priority — refresh the suggestion maps and
      // re-render so the winning suggestions swap live.
      const S = window.WriteSysSuggestions;
      const r = window.WriteSysRenderer;
      if (S) {
        const rank = {};
        order.forEach((u, i) => { rank[u] = i; });
        S.peopleRank = rank;
        S.rebuildMaps();
      }
      if (r && r.currentMigrationID) await r.renderManuscript({});
      if (window.WriteSysPush) window.WriteSysPush.refresh();
    } catch (e) {
      alert('Failed to save order: ' + (e.message || e));
      this.load();
    }
  },
};

if (typeof window !== 'undefined') {
  window.WriteSysPeople = WriteSysPeople;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => WriteSysPeople.init());
  } else {
    WriteSysPeople.init();
  }
}
