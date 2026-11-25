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
    // (The points grid refits itself on resize — grid-of-squares' mount
    // watches its host.)
    window.addEventListener('popstate', () => { this._noteDeepLinked = false; this.reload(); });
    // After an in-place re-login (session-guard), the page's data fetches
    // had 401'd — reload them, else the landing page stays broken until a
    // manual refresh.
    document.addEventListener('ms:session-restored', () => this.reload());
    await this.reload();
  },

  async reload() {
    try {
      this.data = await fetchJSON('api/home', {}, false);
      // A board (BOARDS_PLAN.md): its own payload — board, rules, notes.
      if (this.view() === 'board') {
        const bid = new URLSearchParams(window.location.search).get('board_id') || '';
        this.board = await fetchJSON('api/boards/' + encodeURIComponent(bid), {}, false);
      }
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

  // ---- Points grid: tuft's grid-of-squares (vendored, web/vendor/tuft/) ----
  //
  // One COLUMN per day, one square = 1 point, stacked bottom-up; today sits
  // ~80% of the way across with the future to its right; as many columns
  // as fit the content width (the card grids' edges). The settings
  // reproduce the hand-rolled grid this replaced (2026-11-12):
  //   - two square types at EQUAL rank. A day's GREEN points (scored on a
  //     task on its owner's daily-tasks board — point_event.from_daily,
  //     049) are added first, so they stack first; GOLD (every other
  //     point) sits above them.
  //   - skim bulldozing: a day shows at most its column height, and the
  //     squares on top roll into the next day's column — cascading as far
  //     as needed, even into days that haven't happened yet
  //     (17, 6, 13 → 14, 9, 13). Equal ranks are what keep a carried-in
  //     square ON TOP of a day's own squares (ranked types would sink a
  //     carried green under the next day's gold); a carried square keeps
  //     its color. The component simulates the days before the window, so
  //     a monster day long ago still spills into view — hence the API's
  //     FULL history.
  //   - column height 14, and 21 from 2026-11-12 on (heightChanges: the
  //     columns share a baseline, so the grid grows from the bottom).
  //   - `today` is the server's tz-resolved date (the API's), never the
  //     browser's; each column's tooltip reads "Nov 12 — daily 3 · other 2".
  POINTS_GRID: {
    schema: [
      { type: 'daily', color: 'green', bulldoze: true },
      { type: 'other', color: 'yellow', bulldoze: true },
    ],
    height: 14,
    heightChanges: [{ from: '2026-11-12', height: 21 }],
    bulldozeMode: 'skim',
    lookahead: 0.2,
    cellSize: 10,
    gap: 2,
    minColumns: 10,
    todayMarker: true,
    legend: false,
    tooltip: 'counts',
  },

  pointsGridSettings(today) {
    return Object.assign({}, this.POINTS_GRID, { today });
  },

  renderPointsGrid() {
    if (this._pointsGrid) { this._pointsGrid.destroy(); this._pointsGrid = null; }
    const host = document.getElementById('points-grid');
    const GOS = window.Tuft && window.Tuft.GridOfSquares;
    if (!host || !this.points || !GOS) return;
    const grid = GOS.mount(host, this.pointsGridSettings(this.points.today));
    (this.points.days || []).forEach((d) => {
      const daily = Math.min(d.daily || 0, d.points);
      if (daily > 0) grid.add(d.date, 'daily', daily);
      if (d.points - daily > 0) grid.add(d.date, 'other', d.points - daily);
    });
    grid.render();
    this._pointsGrid = grid;
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
    // The same ⚙ / daily-tasks buttons as the book chrome (icons + .mc-btn).
    const icons = window.WriteSysIcons;
    const updated = m.processed_at ? `updated ${this.when(m.processed_at)}` : 'not synced yet';
    const created = m.created_at ? `created ${this.when(m.created_at)}` : '';
    const words = m.word_count ? `${m.word_count.toLocaleString('en-US')} words` : '';
    return `<a class="card card-manuscript" href="./?manuscript_id=${m.manuscript_id}">
      <span class="card-kindbar"></span>
      <p class="card-title">${this.esc(m.display_name || m.name)}</p>
      <p class="card-sketch">${words}</p>
      <p class="ms-daily-row"><span class="mc-btn mc-settings ms-gear" data-settings="${m.manuscript_id}" title="Manuscript settings" role="button" tabindex="0">${icons.gear(13)}</span>
        <span class="mc-btn mc-daily ms-daily-link" data-daily="${m.manuscript_id}" title="Daily tasks" role="button" tabindex="0">${icons.dailyTasks(13)}</span></p>
      <p class="card-meta"><span>${this.esc(updated)}</span>${created ? `<span>${this.esc(created)}</span>` : ''}</p>
    </a>`;
  },

  // Ghost card (MANUSCRIPT_LIFECYCLE_PLAN §1): the creation affordance that
  // sits after the last card — faint outline, centered +, label on hover.
  // Both grids use the same component; only kind/label differ.
  ghostCard(kind) {
    const label = { manuscript: 'New manuscript', note: 'New note', board: 'New board' }[kind] || 'New scratchpad';
    return `<button type="button" class="card card-ghost" data-ghost="${kind}" title="${label}">
      <span class="ghost-plus">+</span>
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

  // A board card (BOARDS_PLAN.md): name, its rules as chips, how many notes
  // it shows now. Clicking opens the board's tab.
  boardCard(b) {
    const chips = (b.rules || []).slice(0, 4).map((r) => {
      const bits = [r.task_type, r.priority, r.impact, r.blocked ? '⊘' : null].filter(Boolean).concat(r.tags || []);
      return `<span class="tag-chip dim-chip">${this.esc(bits.join(' · ') || 'any')}</span>`;
    }).join('');
    return `<div class="card card-board" data-board-id="${b.board_id}" tabindex="0" role="button">
      <span class="card-kindbar"></span>
      <button type="button" class="card-del" title="Delete board">${window.WriteSysIcons.trash(13)}</button>
      <p class="card-title">${this.esc(b.name)}</p>
      <p class="card-sketch card-board-rules">${chips}</p>
      <p class="card-meta"><span>${b.note_count} ${b.note_count === 1 ? 'note' : 'notes'}</span></p>
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

  // A note with no context — born here with the Notes "+" (2026-11-25), or
  // detached from everything — has nowhere to "open in", so its card IS
  // its editor: the shared widget, live, saving through the note API.
  isFreeNote(n) {
    return !n.scratchpad_id && !n.manuscript_id && !n.sentence_id && !n.sketch_id && !n.completed_at;
  },

  freeNoteHandlers(n, card) {
    const api = window.WriteSysNoteAPI;
    return {
      onSaveText: (text) => { n.body = text.trim() || null; api.update(n.note_id, { body: text.trim() }).catch(() => {}); },
      onColor: (color) => {
        const was = n.color;
        n.color = color;
        card.classList.remove('color-' + was);
        card.classList.add('color-' + color);
        api.update(n.note_id, { color }).catch(() => {});
        card.replaceWith(this.noteCardEl(n)); // the palette re-renders (shows the other 5)
      },
      onDims: (patch) => { Object.assign(n, patch); api.update(n.note_id, patch).catch(() => {}); window.WriteSysNoteWidget.updateDims(card.querySelector('.sticky-note'), n); },
      onDelete: () => { api.remove(n.note_id).catch(() => {}); card.remove(); },
      onComplete: () => { api.complete(n.note_id).then(() => this.reload()).catch(() => {}); },
      onScorePoints: (points) => { api.scorePoints(n.note_id, points).catch(() => {}); },
      onAddTag: async (name) => { try { const r = await api.addTag(n.note_id, name); n.tags = (r && r.tags) || n.tags; } catch (e) { /* chips re-render from n */ } },
      onRemoveTag: async (tagId) => { try { await api.removeTag(n.note_id, tagId); n.tags = (n.tags || []).filter((t) => t.tag_id !== tagId); } catch (e) { /* ditto */ } },
      onLinkManuscript: async (mid) => { try { const r = await api.linkManuscript(n.note_id, mid); n.manuscript_id = r.manuscript_id || null; n.manuscript_name = r.manuscript_name || ''; } catch (e) { /* unchanged */ } },
      onUnlinkManuscript: async () => { try { await api.linkManuscript(n.note_id, 0); n.manuscript_id = null; n.manuscript_name = ''; } catch (e) { /* unchanged */ } },
    };
  },

  noteCardEl(n) {
    const ctx = n.context || 'no context';
    const card = document.createElement('div');
    card.className = `card card-note color-${this.esc(n.color)}`;
    if (n.completed_at) card.classList.add('note-done'); // All-notes shows completed
    card.dataset.noteId = n.note_id;
    if (n.scratchpad_id) card.dataset.scratchpadId = n.scratchpad_id;
    if (n.manuscript_id) card.dataset.manuscriptId = n.manuscript_id;
    if (n.sentence_id) card.dataset.sentenceId = n.sentence_id;
    const free = this.isFreeNote(n) && !!window.WriteSysNoteWidget && !!window.WriteSysNoteAPI;
    if (free) {
      card.classList.add('card-note-free');
      card.appendChild(window.WriteSysNoteWidget.buildNoteElement(
        n, this.freeNoteHandlers(n, card), { card: true, showDelete: true, showComplete: true }));
      // (No context line, no pin — the widget's own chips carry its dims.)
      return card;
    }
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
      body.textContent = n.body || n.default_body || '(empty note)';
      card.appendChild(body);
    }

    // Pin to the daily-tasks board (048): a faint pushpin in the card's
    // bottom-right corner, darker under the pointer, lit once pinned. Its
    // own button — the card's click (open in context) must not fire.
    const W = window.WriteSysNoteWidget;
    if (W && W.pinnable && W.pinnable(n)) {
      const pin = document.createElement('span');
      pin.className = 'card-pin' + (n.pinned_at ? ' pinned' : '');
      pin.setAttribute('role', 'button');
      pin.tabIndex = 0;
      pin.title = n.pinned_at ? 'Pinned to daily tasks' : 'Pin to daily tasks';
      pin.innerHTML = W.PIN_SVG(15);
      const toggle = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const was = n.pinned_at || null;
        n.pinned_at = was ? null : new Date().toISOString();
        pin.classList.toggle('pinned', !!n.pinned_at);
        pin.title = n.pinned_at ? 'Pinned to daily tasks' : 'Pin to daily tasks';
        try {
          await window.WriteSysNoteAPI.setPinned(n.note_id, !was);
        } catch (err) {
          n.pinned_at = was;
          pin.classList.toggle('pinned', !!was);
          pin.title = was ? 'Pinned to daily tasks' : 'Pin to daily tasks';
        }
      };
      pin.addEventListener('click', toggle);
      pin.addEventListener('keydown', (e) => { if (e.key === 'Enter') toggle(e); });
      card.appendChild(pin);
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
        ${opts.seeAll ? `<a class="home-seeall" href="home.html?view=${opts.seeAll}" data-view="${opts.seeAll}">See all →</a>` : ''}
      </div>
      ${opts.notes
        ? `<div class="card-grid" data-note-grid${opts.ghost === 'note' ? ' data-note-ghost="1"' : ''}></div>`
        : ((cardsHTML || ghost) ? `<div class="card-grid">${cardsHTML}${ghost}</div>` : '<div class="home-empty">Nothing here yet.</div>')}
    </section>`;
  },

  render() {
    const root = document.getElementById('home-root');
    const view = this.view();
    // CSS caps the landing's grids at 4 across off this (home.css).
    root.dataset.view = view;
    const ms = this.data.manuscripts || [];
    const sp = this.data.scratchpads || [];
    const bd = this.data.boards || [];
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
        this.section('All notes', nt.length, '', { notes: true, ghost: 'note' });
    } else if (view === 'boards') {
      html = `<a class="home-back" href="home.html">← Home</a>` +
        this.section('All boards', bd.length, bd.map(b => this.boardCard(b)).join(''), { ghost: 'board' });
    } else if (view === 'board') {
      // The board page (BOARDS_PLAN.md): name · Delete, the shared rules
      // editor (with the manuscript picker), then the notes it shows.
      const B = this.board || { board: { name: '' }, notes: [], rules: [], manuscripts: [] };
      noteList = B.notes || [];
      html = `<section class="home-section board-page" data-board-id="${B.board.board_id}">
        <div class="home-section-head board-head">
          <input class="board-name" value="${this.esc(B.board.name)}" aria-label="Board name">
          <span class="home-count">${noteList.length}</span>
          <span class="board-sort" id="board-sort"></span>
          <button type="button" class="board-delete" title="Delete board">Delete</button>
        </div>
        <div class="settings-section board-rules" id="board-rules"></div>
        <div class="card-grid" data-note-grid></div>
      </section>`;
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
      // The landing grid shows LIVE notes only; completed ones live in the
      // All-notes view (filters later).
      const live = nt.filter(n => !n.completed_at);
      noteList = live.slice(0, this.RECENT);
      html = (this.points ? `<section class="home-section" id="points-section">
          <div id="points-grid"></div>
        </section>` : '')
        + this.section('Manuscripts', ms.length,
        ms.slice(0, this.RECENT).map(m => this.manuscriptCard(m)).join(''),
        { ghost: 'manuscript', ...(ms.length > this.RECENT ? { seeAll: 'manuscripts' } : {}) })
        + this.section('Scratchpads', sp.length,
          sp.slice(0, this.RECENT).map(s => this.scratchpadCard(s)).join(''),
          { ghost: 'scratchpad', ...(sp.length > this.RECENT ? { seeAll: 'scratchpads' } : {}) })
        + this.section('Boards', bd.length,
          bd.slice(0, this.RECENT).map(b => this.boardCard(b)).join(''),
          { ghost: 'board', ...(bd.length > this.RECENT ? { seeAll: 'boards' } : {}) })
        + this.section('Notes', live.length, '',
          { notes: true, ghost: 'note', ...(live.length > this.RECENT ? { seeAll: 'notes' } : {}) });
    }
    root.innerHTML = html;

    // Populate the note grid with shared-component cards.
    if (noteList) {
      const grid = root.querySelector('[data-note-grid]');
      // The Notes "+" (a ghost card like the other sections', after the
      // last card — 2026-11-25): a free note, editable right here.
      if (grid && grid.dataset.noteGhost) {
        const mountGhost = () => grid.insertAdjacentHTML('beforeend', this.ghostCard('note'));
        // After the cards (below) — queue it; the cards are appended synchronously.
        setTimeout(mountGhost, 0);
        const ghostsBound = () => {
          const g = grid.querySelector('.card-ghost[data-ghost="note"]');
          if (g && !g._bound) { g._bound = true; g.addEventListener('click', () => this.createFreeNote()); }
        };
        setTimeout(ghostsBound, 0);
      }
      // The daily board is at most 4 across (4 × 4 = its 16), narrower
      // only when the window is.
      if (grid && view === 'daily') grid.classList.add('daily-grid');
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
      const go = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const href = 'home.html?view=daily&manuscript_id=' + el.dataset.daily;
        if (!(window.WriteSysTabs && window.WriteSysTabs.route(href))) window.location.href = href;
      };
      el.addEventListener('click', go);
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(e); });
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

    this.wireNoteCards(root);

    // "See all" / "← Home" links are plain hrefs: the tabs link router
    // (tabs.js) turns them into in-place view changes with history entries.
    // Ghost cards: scratchpad → create immediately (as the old + did);
    // manuscript → the creation modal.
    root.querySelectorAll('.card-ghost').forEach(g => {
      if (g.dataset.ghost === 'note') return; // bound where it mounts (after the note cards)
      g.addEventListener('click', () => {
        if (g.dataset.ghost === 'scratchpad') this.createPad();
        else if (g.dataset.ghost === 'board') this.createBoard();
        else if (window.WriteSysManuscriptModal) window.WriteSysManuscriptModal.openCreate();
      });
    });
    root.querySelectorAll('.card-board').forEach(card => {
      const id = parseInt(card.dataset.boardId, 10);
      const name = card.querySelector('.card-title').textContent;
      const open = () => { if (window.WriteSysTabs) window.WriteSysTabs.openBoard(id, name); };
      card.addEventListener('click', (e) => { if (!e.target.closest('.card-del')) open(); });
      card.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
      card.querySelector('.card-del').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!window.confirm(`Delete board "${name}"?`)) return;
        await this.api(`api/boards/${id}`, { method: 'DELETE' }).catch(() => {});
        if (window.WriteSysTabs) window.WriteSysTabs.unpin('board', id);
        this.reload();
      });
    });
    if (view === 'board' && this.board && this.board.board) this.wireBoardPage(root);
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

  // Note card → open in context. Scratchpad note: open the pad (later: scroll
  // to the anchor). Manuscript note: go to the book. (A free note's card is
  // its editor — role-less, so it is not wired here.)
  wireNoteCards(root) {
    root.querySelectorAll('.card-note[role="button"]').forEach(card => {
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
          const href = `./?manuscript_id=${mId}` + (sid ? `#note-sentence=${encodeURIComponent(sid)}` : '');
          if (!(window.WriteSysTabs && window.WriteSysTabs.route(href))) window.location.href = href;
        }
      };
      card.addEventListener('click', open);
      card.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
    });
  },

  api(url, opts = {}) {
    const csrf = (localStorage.getItem('csrf_token') || sessionStorage.getItem('csrf_token')) || '';
    return fetch(url, Object.assign({ credentials: 'same-origin' }, opts, {
      headers: Object.assign({ 'X-CSRF-Token': csrf }, opts.body ? { 'Content-Type': 'application/json' } : {}, opts.headers || {}),
    })).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.status === 204 ? null : r.json(); });
  },

  // ---- Boards (BOARDS_PLAN.md) -------------------------------------------
  async createBoard() {
    let b;
    try { b = await this.api('api/boards', { method: 'POST', body: JSON.stringify({ name: 'Board' }) }); } catch (e) { return; }
    await this.reload();
    if (window.WriteSysTabs) window.WriteSysTabs.openBoard(b.board_id, b.name);
  },

  // The board page: name saves on change (and renames the tab), Delete
  // closes the tab; the shared rules editor (picker on) refreshes the grid
  // after every change.
  wireBoardPage(root) {
    const B = this.board;
    const id = B.board.board_id;
    const nameEl = root.querySelector('.board-name');
    nameEl.addEventListener('change', async () => {
      const name = nameEl.value.trim();
      if (!name) { nameEl.value = B.board.name; return; }
      try {
        await this.api(`api/boards/${id}`, { method: 'PUT', body: JSON.stringify({ name }) });
        B.board.name = name;
        this.renameTab(id, name);
      } catch (e) { nameEl.value = B.board.name; }
    });
    nameEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') nameEl.blur(); });
    root.querySelector('.board-delete').addEventListener('click', async () => {
      if (!window.confirm(`Delete board "${B.board.name}"?`)) return;
      await this.api(`api/boards/${id}`, { method: 'DELETE' }).catch(() => {});
      this.closeBoardTab(id);
    });
    // The sort (060), applied after the rules: recent | manuscript.
    const sortHost = root.querySelector('#board-sort');
    const W = window.WriteSysNoteWidget;
    const mountSort = () => {
      if (!sortHost || !W) return;
      sortHost.innerHTML = '';
      sortHost.appendChild(W.buildDimChip({
        cls: 'dim-sort',
        value: B.board.sort || 'recent',
        loadOptions: async () => ['recent', 'manuscript'].map((v) => ({ value: v, label: v })),
        onPick: async (v) => {
          try { await this.api(`api/boards/${id}`, { method: 'PUT', body: JSON.stringify({ sort: v }) }); B.board.sort = v; } catch (e) { /* unchanged */ }
          mountSort();
          this.refreshBoardNotes();
        },
      }));
    };
    mountSort();
    const RE = window.WriteSysRulesEditor;
    const host = root.querySelector('#board-rules');
    if (RE && host) {
      const cfg = RE.forBoard(id);
      cfg.manuscripts = {
        list: B.manuscripts || [],
        selected: (B.board.manuscript_ids || []).slice(),
        onChange: (ids) => this.api(`api/boards/${id}`, { method: 'PUT', body: JSON.stringify({ manuscript_ids: ids }) }),
      };
      cfg.onChange = () => this.refreshBoardNotes();
      this.boardEditor = RE.mount(host, cfg);
    }
  },

  async refreshBoardNotes() {
    const id = this.board && this.board.board && this.board.board.board_id;
    if (!id) return;
    try { this.board = await fetchJSON('api/boards/' + id, {}, false); } catch (e) { return; }
    const grid = document.querySelector('#home-root .board-page [data-note-grid]');
    const count = document.querySelector('#home-root .board-head .home-count');
    if (!grid) return;
    grid.innerHTML = '';
    (this.board.notes || []).forEach((n) => grid.appendChild(this.noteCardEl(n)));
    if (count) count.textContent = String((this.board.notes || []).length);
    this.wireNoteCards(grid);
  },

  renameTab(id, name) {
    try {
      const T = (window.top && window.top.WriteSysTabs) || window.WriteSysTabs;
      if (T && T.rename) T.rename('board', id, name);
    } catch (e) { /* standalone */ }
  },

  closeBoardTab(id) {
    try {
      const T = (window.top && window.top.WriteSysTabs) || window.WriteSysTabs;
      if (T && T.unpin) { T.unpin('board', id); return; }
    } catch (e) { /* standalone */ }
    window.location.href = 'home.html';
  },

  // A free note, born on the landing (2026-11-25): yellow, blank, placed
  // nowhere — its card is live, so the caret lands in it at once.
  async createFreeNote() {
    const api = window.WriteSysNoteAPI;
    if (!api) return;
    let made;
    try { made = await api.create({ color: 'yellow' }); } catch (e) { return; }
    await this.reload();
    const ta = document.querySelector(`#home-root .card-note[data-note-id="${made.note_id}"] .note-input`);
    if (ta) { ta.focus(); ta.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
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

// Node (tests): the points grid's settings are checked against the vendored
// component without a browser.
if (typeof module !== 'undefined' && module.exports) module.exports = { WriteSysHome };

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
