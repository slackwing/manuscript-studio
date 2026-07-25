/**
 * Landing page (HOME_PLAN.md): recent manuscript + scratchpad cards, with
 * "See all" views of everything (?view=manuscripts|scratchpads). Clicking a
 * manuscript opens it; clicking a scratchpad opens THE modal. Data comes
 * from /api/home (same payload the global search uses).
 */
const WriteSysHome = {
  RECENT: 8,
  data: null,

  async init() {
    if (this._inited) return;
    this._inited = true;
    // Re-render cards whenever the modal closes (titles/snippets change).
    window.addEventListener('scratchpad-modal-closed', () => this.reload());
    window.addEventListener('popstate', () => this.render());
    await this.reload();
  },

  async reload() {
    try {
      this.data = await fetchJSON('api/home', {}, false);
    } catch (e) {
      document.getElementById('home-root').innerHTML =
        `<div class="home-empty">Failed to load: ${this.esc(e.message)}</div>`;
      return;
    }
    this.render();
  },

  view() {
    return new URLSearchParams(window.location.search).get('view') || 'home';
  },

  esc(t) {
    return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },

  when(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const days = (Date.now() - d.getTime()) / 86400000;
    if (days < 1) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
    if (days < 300) return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short' });
  },

  manuscriptCard(m) {
    const opened = m.last_opened_at ? `opened ${this.when(m.last_opened_at)}` : '';
    const updated = m.processed_at ? `updated ${this.when(m.processed_at)}` : 'not synced yet';
    const words = m.word_count ? `${m.word_count.toLocaleString('en-US')} words` : '';
    return `<a class="card card-manuscript" href="./?manuscript_id=${m.manuscript_id}">
      <span class="card-kindbar"></span>
      <p class="card-title">${this.esc(m.name)}</p>
      <p class="card-snippet">${words}</p>
      <p class="card-meta"><span>${this.esc(opened || updated)}</span>${opened ? `<span>· ${this.esc(updated)}</span>` : ''}</p>
    </a>`;
  },

  scratchpadCard(s) {
    const badge = s.block_count
      ? `<span class="card-badge">${s.canonized_count}/${s.block_count} canonized</span>` : '';
    return `<div class="card card-scratchpad" data-scratchpad-id="${s.scratchpad_id}" tabindex="0" role="button">
      <span class="card-kindbar"></span>
      <button type="button" class="card-del" title="Delete scratchpad">×</button>
      <p class="card-title">${this.esc(s.title)}</p>
      <p class="card-snippet">${this.esc(s.snippet || '')}</p>
      <p class="card-meta"><span>${this.esc(this.when(s.updated_at))}</span>${badge}</p>
    </div>`;
  },

  section(title, count, cardsHTML, opts = {}) {
    return `<section class="home-section">
      <div class="home-section-head">
        <h2>${title}</h2><span class="home-count">${count}</span>
        ${opts.newBtn ? '<button type="button" class="home-new" id="home-new-pad" title="New scratchpad">+</button>' : ''}
        <span class="home-spacer"></span>
        ${opts.seeAll ? `<a class="home-seeall" href="home.html?view=${opts.seeAll}" data-view="${opts.seeAll}">See all →</a>` : ''}
      </div>
      ${cardsHTML ? `<div class="card-grid">${cardsHTML}</div>` : '<div class="home-empty">Nothing here yet.</div>'}
    </section>`;
  },

  render() {
    const root = document.getElementById('home-root');
    const view = this.view();
    const ms = this.data.manuscripts || [];
    const sp = this.data.scratchpads || [];
    let html = '';
    if (view === 'manuscripts') {
      html = `<a class="home-back" href="home.html">← Home</a>` +
        this.section('All manuscripts', ms.length, ms.map(m => this.manuscriptCard(m)).join(''));
    } else if (view === 'scratchpads') {
      html = `<a class="home-back" href="home.html">← Home</a>` +
        this.section('All scratchpads', sp.length, sp.map(s => this.scratchpadCard(s)).join(''), { newBtn: true });
    } else {
      html = this.section('Manuscripts', ms.length,
        ms.slice(0, this.RECENT).map(m => this.manuscriptCard(m)).join(''),
        ms.length > this.RECENT ? { seeAll: 'manuscripts' } : {})
        + this.section('Scratchpads', sp.length,
          sp.slice(0, this.RECENT).map(s => this.scratchpadCard(s)).join(''),
          { newBtn: true, ...(sp.length > this.RECENT ? { seeAll: 'scratchpads' } : {}) });
    }
    root.innerHTML = html;

    root.querySelectorAll('a[data-view]').forEach(a => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        history.pushState(null, '', a.getAttribute('href'));
        this.render();
      });
    });
    const newBtn = document.getElementById('home-new-pad');
    if (newBtn) newBtn.addEventListener('click', () => this.createPad());
    root.querySelectorAll('.card-scratchpad').forEach(card => {
      const id = parseInt(card.dataset.scratchpadId, 10);
      card.addEventListener('click', (e) => {
        if (e.target.closest('.card-del')) return;
        window.WriteSysScratchpadModal.open(id);
      });
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') window.WriteSysScratchpadModal.open(id);
      });
      card.querySelector('.card-del').addEventListener('click', async (e) => {
        e.stopPropagation();
        const title = card.querySelector('.card-title').textContent;
        if (!window.confirm(`Delete scratchpad "${title}"? (Soft-deleted — recoverable from the database.)`)) return;
        await fetch(`api/scratchpads/${id}`, {
          method: 'DELETE',
          headers: { 'X-CSRF-Token': sessionStorage.getItem('csrf_token') || '' },
        });
        this.reload();
      });
    });
  },

  async createPad() {
    const r = await fetch('api/scratchpads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': sessionStorage.getItem('csrf_token') || '' },
      body: JSON.stringify({ title: 'Untitled' }),
    });
    if (!r.ok) return;
    const pad = await r.json();
    await this.reload();
    window.WriteSysScratchpadModal.open(pad.scratchpad_id);
  },
};

if (typeof window !== 'undefined') {
  window.WriteSysHome = WriteSysHome;
  // The page's auth bootstrap (inline script) may finish before or after
  // this file parses — whoever comes second triggers init (idempotent).
  if (window.currentSession) {
    WriteSysHome.init();
  } else {
    const t = setInterval(() => {
      if (window.currentSession) { clearInterval(t); WriteSysHome.init(); }
    }, 50);
  }
}
