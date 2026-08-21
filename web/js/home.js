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
    // Manuscript created/settings-saved → refresh cards.
    window.addEventListener('manuscript-modal-saved', () => this.reload());
    // The points grid sizes itself to the content width — refit on resize.
    window.addEventListener('resize', () => {
      clearTimeout(this._pgResize);
      this._pgResize = setTimeout(() => this.renderPointsGrid(), 150);
    });
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
      // The daily-tasks view has its own payload (date-seeded task pick).
      if (this.view() === 'daily') {
        const mid = new URLSearchParams(window.location.search).get('manuscript_id') || '';
        this.daily = await fetchJSON('api/daily-tasks?manuscript_id=' + encodeURIComponent(mid), {}, false);
      }
      // Points grid (default view only): the FULL per-day history — the
      // bulldozer cascade needs every day since the first point. v3: the
      // points surfaces belong to the POINTER role (award-points).
      if (this.view() === 'home'
          && window.WriteSysActions && window.WriteSysActions.hasAnywhere('award-points')) {
        try { this.points = await fetchJSON('api/points-daily', {}, false); }
        catch (e) { this.points = null; } // grid is an enhancement, not a gate
      } else {
        this.points = null;
      }
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

  // ---- Points grid (GitHub-contribution style, with a bulldozer) ----
  //
  // One COLUMN per day, 14 ROWS, one row = 1 point; a day's points light
  // squares bottom-up in gold. Today sits ~80% of the way across; the ~20%
  // to its right is the future. As many columns as fit the content width
  // (same left/right edges as the card grids). Empty cells stay gray.
  //
  // QUIRK (deliberate — keep it): a day displays at most 14 points, but
  // points 15+ do NOT vanish. Picture a bulldozer shoving the excess blocks
  // off the top of the stack RIGHTWARD into the next day's column,
  // cascading as far as needed — even into days that haven't happened yet.
  //   17, 6, 13  →  14, 9, 13
  //   17, 12, 14 →  14, 14, 14, 1   (the trailing 1 lands in the future)
  // Per spec the implementation is the LITERAL simulation — build the
  // matrix, then bulldoze; simple beats efficient:
  //   1. Stack every day's actual points as 'natural' blocks (stacks may
  //      be taller than 14 at this stage).
  //   2. Scan columns left→right; while a column is taller than 14, pop
  //      its TOP block and drop it on TOP of the next column, marked
  //      'bulldozed'. Carried-in blocks therefore sit ABOVE the day's own
  //      points, and an overfull day sheds those carried blocks first —
  //      they keep rolling rightward.
  // Colors: natural = gold; bulldozed = darker gold; anything in a FUTURE
  // column = green ("for being so ahead") — future-ness outranks the
  // bulldozed shade, since every future block is bulldozed by definition.
  // The cascade runs over the FULL history (the API returns every day
  // since the first point), so a monster day left of the visible window
  // still spills into view correctly.
  renderPointsGrid() {
    const grid = document.getElementById('points-grid');
    if (!grid || !this.points) return;
    const CELL = 10, GAP = 2, ROWS = 14;
    const cols = Math.max(10, Math.floor((grid.clientWidth + GAP) / (CELL + GAP)));
    const future = Math.max(1, Math.round(cols * 0.2)); // today ≈ 80% across
    // All date math in UTC on the tz-resolved YYYY-MM-DD labels the server
    // sent — stepping by whole days can never straddle a DST boundary.
    const DAY = 86400000;
    const parse = (s) => new Date(s + 'T00:00:00Z');
    const fmt = (d) => d.toISOString().slice(0, 10);
    const today = parse(this.points.today);
    const byDate = {};
    (this.points.days || []).forEach(d => { byDate[d.date] = d.points; });
    // The matrix starts at the EARLIER of (first data day, window start):
    // history left of the window still bulldozes into view.
    const windowStart = new Date(today.getTime() - (cols - future - 1) * DAY);
    const firstData = (this.points.days || []).length ? parse(this.points.days[0].date) : windowStart;
    const start = firstData < windowStart ? firstData : windowStart;
    const end = new Date(today.getTime() + future * DAY);
    const days = [];
    for (let t = start.getTime(); t <= end.getTime(); t += DAY) days.push(fmt(new Date(t)));
    // 1. Stack natural blocks.
    const matrix = days.map(d => Array(byDate[d] || 0).fill('natural'));
    // 2. Bulldoze.
    for (let i = 0; i < matrix.length; i++) {
      while (matrix[i].length > ROWS) {
        matrix[i].pop();
        if (!matrix[i + 1]) {
          matrix.push([]);
          days.push(fmt(new Date(parse(days[days.length - 1]).getTime() + DAY)));
        }
        matrix[i + 1].push('bulldozed');
      }
    }
    // Render only the visible window (the cascade may extend past it).
    grid.innerHTML = '';
    const startIdx = days.indexOf(fmt(windowStart));
    for (let c = 0; c < cols; c++) {
      const idx = startIdx + c;
      const date = days[idx] || fmt(new Date(windowStart.getTime() + c * DAY));
      const stack = matrix[idx] || [];
      const col = document.createElement('div');
      col.className = 'points-col' + (date === this.points.today ? ' today' : '');
      col.dataset.date = date;
      const isFuture = date > this.points.today; // ISO strings compare lexically
      for (let row = 0; row < ROWS; row++) {
        const cell = document.createElement('div');
        cell.className = 'points-cell';
        if (row < stack.length) {
          cell.classList.add('lit');
          if (isFuture) cell.classList.add('future');
          else if (stack[row] === 'bulldozed') cell.classList.add('bulldozed');
        }
        col.appendChild(cell);
      }
      grid.appendChild(col);
    }
    // TODAY marker: a little black triangle under today's column + caption.
    // (The column itself stays plain gold — no special shade for today.)
    const marker = document.getElementById('points-today');
    if (marker) {
      const c = Math.round((today.getTime() - windowStart.getTime()) / DAY);
      marker.innerHTML = `<span class="pt-mark" style="left:${c * (CELL + GAP) + CELL / 2}px">
        <span class="pt-arrow"></span><span class="pt-caption">TODAY</span></span>`;
    }
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

  GEAR_SVG: `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M8 4.75a3.25 3.25 0 100 6.5 3.25 3.25 0 000-6.5zM6.5 8a1.5 1.5 0 113 0 1.5 1.5 0 01-3 0z"/><path fill="currentColor" d="M9.4 1l.35 1.8c.4.14.78.33 1.13.55l1.73-.63 1.4 2.42-1.38 1.17a5.6 5.6 0 010 1.38l1.38 1.17-1.4 2.42-1.73-.63c-.35.22-.73.41-1.13.55L9.4 13H6.6l-.35-1.8a5.6 5.6 0 01-1.13-.55l-1.73.63L2 8.86l1.38-1.17a5.6 5.6 0 010-1.38L2 5.14l1.4-2.42 1.73.63c.35-.22.73-.41 1.13-.55L6.6 1h2.8z" fill-rule="evenodd" opacity="0.85"/></svg>`,

  manuscriptCard(m) {
    const updated = m.processed_at ? `updated ${this.when(m.processed_at)}` : 'not synced yet';
    const created = m.created_at ? `created ${this.when(m.created_at)}` : '';
    const words = m.word_count ? `${m.word_count.toLocaleString('en-US')} words` : '';
    return `<a class="card card-manuscript" href="./?manuscript_id=${m.manuscript_id}">
      <span class="card-kindbar"></span>
      <p class="card-title">${this.esc(m.display_name || m.name)}</p>
      <p class="card-sketch">${words}</p>
      <p class="ms-daily-row"><span class="ms-daily-link" data-daily="${m.manuscript_id}">daily tasks</span>
        <span class="ms-gear" data-settings="${m.manuscript_id}" title="Manuscript settings" role="button" tabindex="0">${this.GEAR_SVG}</span></p>
      <p class="card-meta"><span>${this.esc(updated)}</span>${created ? `<span>${this.esc(created)}</span>` : ''}</p>
    </a>`;
  },

  // Ghost card (MANUSCRIPT_LIFECYCLE_PLAN §1): the creation affordance that
  // sits after the last card — faint outline, centered +, label on hover.
  // Both grids use the same component; only kind/label differ.
  ghostCard(kind) {
    const label = kind === 'manuscript' ? 'New manuscript' : 'New scratchpad';
    return `<button type="button" class="card card-ghost" data-ghost="${kind}" title="${label}">
      <span class="ghost-plus">+</span>
      <span class="ghost-label">${label}</span>
    </button>`;
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
  // ---- All-notes search filters -----------------------------------------
  // The SAME criteria chip-row the settings Daily-task-rules builder uses
  // (note-widget.js buildCriteriaRow) plus a literal text search. Filtering
  // is client-side over the already-loaded notes; only the GRID re-renders,
  // so the text input keeps focus while typing.
  mountNoteFilters(root) {
    const grid = root.querySelector('[data-note-grid]');
    if (!grid) return;
    if (!this.noteFilter) {
      this.noteFilter = { task_type: null, priority: null, impact: null, blocked: null, color: null, tags: [], text: '' };
    }
    const bar = document.createElement('div');
    bar.className = 'nf-bar';
    bar.innerHTML = '<div id="nf-crit" class="dr-row nf-crit"></div>'
      + '<input type="text" id="nf-text" class="nf-text" placeholder="search text (literal)">';
    grid.parentNode.insertBefore(bar, grid);
    const txt = bar.querySelector('#nf-text');
    txt.value = this.noteFilter.text;
    txt.addEventListener('input', () => {
      this.noteFilter.text = txt.value;
      this.applyNoteFilter();
    });
    this.renderNoteCritRow();
    this.applyNoteFilter();
  },

  renderNoteCritRow() {
    const host = document.getElementById('nf-crit');
    if (!host) return;
    window.WriteSysNoteWidget.buildCriteriaRow(host, this.noteFilter, () => {
      this.renderNoteCritRow();
      this.applyNoteFilter();
    });
  },

  applyNoteFilter() {
    const grid = document.querySelector('[data-note-grid]');
    if (!grid) return;
    const f = this.noteFilter;
    const W = window.WriteSysNoteWidget;
    const needle = f.text.trim().toLowerCase();
    const matches = (this.data.notes || []).filter(n =>
      W.criteriaMatches(f, n)
      && (!needle || (n.body || '').toLowerCase().includes(needle)));
    grid.innerHTML = '';
    if (!matches.length) {
      grid.innerHTML = '<div class="home-empty">No matching notes.</div>';
      return;
    }
    matches.forEach(n => grid.appendChild(this.noteCardEl(n)));
  },

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

  // opts.ghost ('manuscript'|'scratchpad') appends the ghost creation card
  // after the last real card — this replaced the old header "+" button.
  section(title, count, cardsHTML, opts = {}) {
    const ghost = opts.ghost ? this.ghostCard(opts.ghost) : '';
    return `<section class="home-section">
      <div class="home-section-head">
        <h2>${title}</h2><span class="home-count">${count}</span>
        <span class="home-spacer"></span>
        ${opts.seeAll ? `<a class="home-seeall" href="home.html?view=${opts.seeAll}" data-view="${opts.seeAll}">See all →</a>` : ''}
      </div>
      ${opts.notes
        ? '<div class="card-grid" data-note-grid></div>'
        : ((cardsHTML || ghost) ? `<div class="card-grid">${cardsHTML}${ghost}</div>` : '<div class="home-empty">Nothing here yet.</div>')}
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
        this.section('All manuscripts', ms.length, ms.map(m => this.manuscriptCard(m)).join(''), { ghost: 'manuscript' });
    } else if (view === 'scratchpads') {
      html = `<a class="home-back" href="home.html">← Home</a>` +
        this.section('All scratchpads', sp.length, sp.map(s => this.scratchpadCard(s)).join(''), { ghost: 'scratchpad' });
    } else if (view === 'notes') {
      noteList = nt;
      html = `<a class="home-back" href="home.html">← Home</a>` +
        this.section('All notes', nt.length, '', { notes: true });
    } else if (view === 'daily') {
      const daily = this.daily || { notes: [] };
      noteList = daily.notes || [];
      // "Daily tasks for August 8, 2026 — The Wildfire"
      const dateStr = daily.date
        ? new Date(daily.date + 'T00:00:00Z').toLocaleDateString('en-US',
            { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
        : '';
      const title = 'Daily tasks' + (dateStr ? ` for ${dateStr}` : '')
        + (daily.manuscript_name ? ` — ${daily.manuscript_name}` : '');
      html = `<a class="home-back" href="home.html">← Home</a>` +
        this.section(this.esc(title), noteList.length, '', { notes: true });
    } else {
      noteList = nt.slice(0, this.RECENT);
      html = (this.points ? `<section class="home-section" id="points-section">
          <div id="points-grid" class="points-grid"></div>
          <div id="points-today" class="points-today-row"></div>
        </section>` : '')
        + this.section('Manuscripts', ms.length,
        ms.slice(0, this.RECENT).map(m => this.manuscriptCard(m)).join(''),
        { ghost: 'manuscript', ...(ms.length > this.RECENT ? { seeAll: 'manuscripts' } : {}) })
        + this.section('Scratchpads', sp.length,
          sp.slice(0, this.RECENT).map(s => this.scratchpadCard(s)).join(''),
          { ghost: 'scratchpad', ...(sp.length > this.RECENT ? { seeAll: 'scratchpads' } : {}) })
        + this.section('Notes', nt.length, '',
          { notes: true, ...(nt.length > this.RECENT ? { seeAll: 'notes' } : {}) });
    }
    root.innerHTML = html;

    // Populate the note grid with shared-component cards.
    if (noteList) {
      const grid = root.querySelector('[data-note-grid]');
      if (grid) {
        if (noteList.length) noteList.forEach(n => {
          const card = this.noteCardEl(n);
          // Daily-tasks page: a note already awarded points today dims
          // under a big gold check (still clickable).
          if (view === 'daily' && n.done_today) {
            card.classList.add('daily-done');
            const ov = document.createElement('div');
            ov.className = 'daily-check';
            ov.innerHTML = '<svg width="64" height="64" viewBox="0 0 24 24">'
              + '<path d="M4.5 13l5 5L20 6.5" fill="none" stroke="#fff" stroke-width="7.5" stroke-linecap="round" stroke-linejoin="round"/>'
              + '<path d="M4.5 13l5 5L20 6.5" fill="none" stroke="#f0c419" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>'
              + '</svg>';
            card.appendChild(ov);
          }
          grid.appendChild(card);
        });
        else grid.outerHTML = '<div class="home-empty">Nothing here yet.</div>';
      }
    }

    if (view === 'notes') this.mountNoteFilters(root);

    this.renderPointsGrid();

    // ?note=<id> deep-link (the settings table's go-to arrow): scroll to
    // the note's card and flash it. Once — a later re-render must not yank
    // the scroll back.
    const targetNote = new URLSearchParams(window.location.search).get('note');
    if (targetNote && !this._noteDeepLinked) {
      const card = root.querySelector(`.card-note[data-note-id="${CSS.escape(targetNote)}"]`);
      if (card) {
        this._noteDeepLinked = true;
        card.scrollIntoView({ block: 'center' });
        card.classList.add('note-flash');
        setTimeout(() => card.classList.remove('note-flash'), 2400);
      }
    }

    // Manuscript card's "daily tasks" link (a span — the card itself is an
    // anchor, so stop the card navigation and go to the daily view).
    root.querySelectorAll('.ms-daily-link').forEach(el => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.location.href = 'home.html?view=daily&manuscript_id=' + el.dataset.daily;
      });
    });

    // Card gear → settings modal (same stop-the-anchor dance).
    root.querySelectorAll('.ms-gear').forEach(el => {
      const open = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (window.WriteSysManuscriptModal) {
          window.WriteSysManuscriptModal.openSettings(parseInt(el.dataset.settings, 10));
        }
      };
      el.addEventListener('click', open);
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(e); });
    });

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
    // Ghost cards: scratchpad → create immediately (as the old + did);
    // manuscript → the creation modal.
    root.querySelectorAll('.card-ghost').forEach(g => {
      g.addEventListener('click', () => {
        if (g.dataset.ghost === 'scratchpad') this.createPad();
        else if (window.WriteSysManuscriptModal) window.WriteSysManuscriptModal.openCreate();
      });
    });
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
