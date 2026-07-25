/**
 * Global top-bar search (HOME_PLAN.md): finds manuscripts and scratchpads
 * by name/title over the /api/home payload (server FTS comes later).
 * Selecting a manuscript navigates to it; selecting a scratchpad opens THE
 * scratchpad modal — over the landing page or an open manuscript alike.
 */
const WriteSysGlobalSearch = {
  data: null,
  fetchedAt: 0,
  activeIdx: -1,
  items: [],

  init() {
    this.input = document.getElementById('gs-input');
    this.dropdown = document.getElementById('gs-dropdown');
    if (!this.input || !this.dropdown) return;
    this.input.addEventListener('focus', () => { this.load(); if (this.input.value) this.render(); });
    this.input.addEventListener('input', () => this.render());
    this.input.addEventListener('keydown', (e) => this.onKey(e));
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#global-search')) this.hide();
    });
  },

  async load(force = false) {
    if (!force && this.data && Date.now() - this.fetchedAt < 30000) return this.data;
    try {
      this.data = await fetchJSON('api/home', {}, false);
      this.fetchedAt = Date.now();
    } catch (e) {
      console.warn('search index load failed', e);
      this.data = { manuscripts: [], scratchpads: [] };
    }
    return this.data;
  },

  esc(t) {
    return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },

  async render() {
    const q = this.input.value.trim().toLowerCase();
    if (!q) { this.hide(); return; }
    await this.load();
    const ms = (this.data.manuscripts || []).filter(m =>
      m.name.toLowerCase().includes(q) || (m.display_name || '').toLowerCase().includes(q)).slice(0, 8);
    const sp = (this.data.scratchpads || []).filter(s =>
      s.title.toLowerCase().includes(q) || (s.snippet || '').toLowerCase().includes(q)).slice(0, 8);
    this.items = [
      ...ms.map(m => ({ type: 'manuscript', id: m.manuscript_id, title: m.display_name || m.name, meta: `${(m.word_count || 0).toLocaleString('en-US')} words` })),
      ...sp.map(s => ({ type: 'scratchpad', id: s.scratchpad_id, title: s.title, meta: new Date(s.updated_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) })),
    ];
    this.activeIdx = this.items.length ? 0 : -1;
    let html = '';
    if (ms.length) {
      html += '<div class="gs-group">Manuscripts</div>' + ms.map((m, i) =>
        this.itemHTML(i, 'manuscript', m.display_name || m.name, `${(m.word_count || 0).toLocaleString('en-US')} words`)).join('');
    }
    if (sp.length) {
      html += '<div class="gs-group">Scratchpads</div>' + sp.map((s, i) =>
        this.itemHTML(ms.length + i, 'scratchpad', s.title,
          new Date(s.updated_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))).join('');
    }
    if (!html) html = '<div class="gs-empty">Nothing matches.</div>';
    this.dropdown.innerHTML = html;
    this.dropdown.hidden = false;
    this.dropdown.querySelectorAll('.gs-item').forEach(btn => {
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', () => this.pick(parseInt(btn.dataset.idx, 10)));
    });
    this.highlight();
  },

  itemHTML(idx, type, title, meta) {
    const kind = type === 'manuscript' ? 'Book' : 'Pad';
    return `<button type="button" class="gs-item" data-idx="${idx}">
      <span class="gs-kind gs-kind-${type}">${kind}</span>
      <span class="gs-title">${this.esc(title)}</span>
      <span class="gs-meta">${this.esc(meta)}</span></button>`;
  },

  highlight() {
    this.dropdown.querySelectorAll('.gs-item').forEach((el, i) =>
      el.classList.toggle('active', i === this.activeIdx));
  },

  onKey(e) {
    if (this.dropdown.hidden) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); this.activeIdx = Math.min(this.activeIdx + 1, this.items.length - 1); this.highlight(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); this.activeIdx = Math.max(this.activeIdx - 1, 0); this.highlight(); }
    else if (e.key === 'Enter') { e.preventDefault(); this.pick(this.activeIdx); }
    else if (e.key === 'Escape') { this.hide(); this.input.blur(); }
  },

  pick(idx) {
    const item = this.items[idx];
    if (!item) return;
    this.hide();
    this.input.value = '';
    if (item.type === 'manuscript') {
      window.location.href = `./?manuscript_id=${item.id}`;
    } else if (window.WriteSysScratchpadModal) {
      window.WriteSysScratchpadModal.open(item.id);
    }
  },

  hide() {
    this.dropdown.hidden = true;
  },
};

if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => WriteSysGlobalSearch.init());
  } else {
    WriteSysGlobalSearch.init();
  }
  window.WriteSysGlobalSearch = WriteSysGlobalSearch;
}
