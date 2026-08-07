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
    // Re-render cards whenever the modal closes (titles/sketches change).
    window.addEventListener('scratchpad-modal-closed', () => this.reload());
    window.addEventListener('popstate', () => this.render());
    // After an in-place re-login (session-guard), the page's data fetches
    // had 401'd — reload them, else the landing page stays broken until a
    // manual refresh.
    document.addEventListener('ms:session-restored', () => this.reload());
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
    // Under 24h → clock time; under ~10 months → "Jul 25"; older → +year.
    if (!iso) return '';
    const d = new Date(iso);
    const days = (Date.now() - d.getTime()) / 86400000;
    if (days < 1) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
    if (days < 300) return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  },

  manuscriptCard(m) {
    const updated = m.processed_at ? `updated ${this.when(m.processed_at)}` : 'not synced yet';
    const created = m.created_at ? `created ${this.when(m.created_at)}` : '';
    const words = m.word_count ? `${m.word_count.toLocaleString('en-US')} words` : '';
    return `<a class="card card-manuscript" href="./?manuscript_id=${m.manuscript_id}">
      <span class="card-kindbar"></span>
      <p class="card-title">${this.esc(m.display_name || m.name)}</p>
      <p class="card-sketch">${words}</p>
      <p class="card-meta"><span>${this.esc(updated)}</span>${created ? `<span>${this.esc(created)}</span>` : ''}</p>
    </a>`;
  },

  scratchpadCard(s) {
    const badge = s.block_count
      ? `<span class="card-badge" title="${s.canonized_count} of ${s.block_count} sketches have been placed into a book (their text now lives in the manuscript)">⧉ ${s.canonized_count}/${s.block_count}</span>` : '';
    return `<div class="card card-scratchpad" data-scratchpad-id="${s.scratchpad_id}" tabindex="0" role="button">
      <span class="card-kindbar"></span>
      <button type="button" class="card-del" title="Delete scratchpad">${window.WriteSysIcons.trash(13)}</button>
      <p class="card-title">${this.esc(s.title)}</p>
      <p class="card-sketch">${this.esc(s.sketch || '')}</p>
      <p class="card-meta"><span>updated ${this.esc(this.when(s.updated_at))}</span>${badge}</p>
    </div>`;
  },

  // A note card (NOTES_PLAN.md Phase 3): the SHARED note component in its
  // read-only card variant, wrapped in the standard card frame + a context line.
  // The card returns an outer .card element; its note body/tags/priority/flag
  // come from buildNoteElement, so they always match the real note (font,
  // chips, everything). Only the frame, the context, and click-to-open are
  // card-specific. Returns an HTMLElement (not a string) since it composes DOM.
  noteCardEl(n) {
    const ctx = n.context || 'no context';
    const card = document.createElement('div');
    card.className = `card card-note color-${this.esc(n.color)}`;
    card.dataset.noteId = n.note_id;
    if (n.scratchpad_id) card.dataset.scratchpadId = n.scratchpad_id;
    if (n.manuscript_id) card.dataset.manuscriptId = n.manuscript_id;
    if (n.sentence_id) card.dataset.sentenceId = n.sentence_id;
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.title = 'Open note in context';

    // The note component, read-only + card look. No handlers → nothing editable.
    if (window.WriteSysNoteWidget) {
      const noteEl = window.WriteSysNoteWidget.buildNoteElement(
        n, {}, { readOnly: true, card: true, showComplete: false });
      card.appendChild(noteEl);
    } else {
      const body = document.createElement('p');
      body.className = 'card-note-body';
      body.textContent = n.body || '(empty note)';
      card.appendChild(body);
    }

    // Context line under the note content (manuscript · scratchpad).
    const meta = document.createElement('p');
    meta.className = 'card-meta';
    const ctxSpan = document.createElement('span');
    ctxSpan.className = 'note-card-ctx';
    ctxSpan.textContent = ctx;
    meta.appendChild(ctxSpan);
    card.appendChild(meta);
    return card;
  },

  section(title, count, cardsHTML, opts = {}) {
    return `<section class="home-section">
      <div class="home-section-head">
        <h2>${title}</h2><span class="home-count">${count}</span>
        ${opts.newBtn ? '<button type="button" class="home-new" id="home-new-pad" title="New scratchpad">+</button>' : ''}
        <span class="home-spacer"></span>
        ${opts.seeAll ? `<a class="home-seeall" href="home.html?view=${opts.seeAll}" data-view="${opts.seeAll}">See all →</a>` : ''}
      </div>
      ${opts.notes
        ? '<div class="card-grid" data-note-grid></div>'
        : (cardsHTML ? `<div class="card-grid">${cardsHTML}</div>` : '<div class="home-empty">Nothing here yet.</div>')}
    </section>`;
  },

  render() {
    const root = document.getElementById('home-root');
    const view = this.view();
    const ms = this.data.manuscripts || [];
    const sp = this.data.scratchpads || [];
    const nt = this.data.notes || [];
    // Note cards are BUILT AS ELEMENTS (they mount the shared note component),
    // so their sections render an empty grid placeholder here and get populated
    // after innerHTML is set. `noteList` is the notes to inject for this view.
    let html = '';
    let noteList = null;
    if (view === 'manuscripts') {
      html = `<a class="home-back" href="home.html">← Home</a>` +
        this.section('All manuscripts', ms.length, ms.map(m => this.manuscriptCard(m)).join(''));
    } else if (view === 'scratchpads') {
      html = `<a class="home-back" href="home.html">← Home</a>` +
        this.section('All scratchpads', sp.length, sp.map(s => this.scratchpadCard(s)).join(''), { newBtn: true });
    } else if (view === 'notes') {
      noteList = nt;
      html = `<a class="home-back" href="home.html">← Home</a>` +
        this.section('All notes', nt.length, '', { notes: true });
    } else {
      noteList = nt.slice(0, this.RECENT);
      html = this.section('Manuscripts', ms.length,
        ms.slice(0, this.RECENT).map(m => this.manuscriptCard(m)).join(''),
        ms.length > this.RECENT ? { seeAll: 'manuscripts' } : {})
        + this.section('Scratchpads', sp.length,
          sp.slice(0, this.RECENT).map(s => this.scratchpadCard(s)).join(''),
          { newBtn: true, ...(sp.length > this.RECENT ? { seeAll: 'scratchpads' } : {}) })
        + this.section('Notes', nt.length, '',
          { notes: true, ...(nt.length > this.RECENT ? { seeAll: 'notes' } : {}) });
    }
    root.innerHTML = html;

    // Populate the note grid with shared-component cards.
    if (noteList) {
      const grid = root.querySelector('[data-note-grid]');
      if (grid) {
        if (noteList.length) noteList.forEach(n => grid.appendChild(this.noteCardEl(n)));
        else grid.outerHTML = '<div class="home-empty">Nothing here yet.</div>';
      }
    }

    // Note card → open in context. Scratchpad note: open the pad (later: scroll
    // to the anchor). Manuscript note: go to the book.
    root.querySelectorAll('.card-note').forEach(card => {
      const noteId = parseInt(card.dataset.noteId, 10);
      const open = () => {
        const padId = card.dataset.scratchpadId;
        const mId = card.dataset.manuscriptId;
        if (padId && window.WriteSysScratchpadModal) {
          // Open the pad and scroll to this note's inline anchor.
          window.WriteSysScratchpadModal.open(parseInt(padId, 10), { noteId });
        } else if (mId) {
          // Manuscript note → open the book and scroll to the noted sentence.
          const sid = card.dataset.sentenceId;
          window.location.href = `./?manuscript_id=${mId}` + (sid ? `#note-sentence=${encodeURIComponent(sid)}` : '');
        }
      };
      card.addEventListener('click', open);
      card.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
    });

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
          headers: { 'X-CSRF-Token': (localStorage.getItem('csrf_token') || sessionStorage.getItem('csrf_token')) || '' },
        });
        this.reload();
      });
    });
  },

  async createPad() {
    const now = new Date();
    const r = await fetch('api/scratchpads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': (localStorage.getItem('csrf_token') || sessionStorage.getItem('csrf_token')) || '' },
      body: JSON.stringify({ title: `Untitled ${now.getMonth() + 1}/${now.getDate()}` }),
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
