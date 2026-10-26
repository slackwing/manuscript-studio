/**
 * Statistics pane (STATS_PLAN) — the outline's tab-switched sibling in the
 * left band. Shows birthday, word goal (both read-only here — edited via
 * the manuscript settings modal), average words/day since birthday, and a
 * mini progress graph:
 *
 *   black dotted — assumed ramp from (birthday, 0) to the first cron row
 *   black solid  — actual daily totals (wordcount_history: effective+sketches)
 *   red   solid  — extrapolation at the recent 30-day pace
 *   blue  solid  — extrapolation at the average-since-birthday pace
 *   purple solid — the pace needed to reach the goal one year from today
 *
 * No legend, no labels, no tooltips: hovering (or tapping, on mobile) an
 * extrapolation reveals a same-color dotted drop to the axis captioned
 * "May 27, 2027 @ 271 wpd" — that caption is the whole hint.
 * Palette (#c0392b/#4b8ec9/#6b2fa0 on #f5f5f5) is CVD-validated.
 */
const WriteSysStats = {
  apiBaseUrl: 'api',
  el: null,
  data: null,       // {enabled, rows, birthday, word_goal} from the API
  pane: 'outline',  // 'outline' | 'stats'

  DAY: 86400000,
  COLOR_ACTUAL: '#333333',
  COLOR_TREND: '#c0392b',
  COLOR_AVG: '#4b8ec9',
  COLOR_NEED: '#6b2fa0',

  init() {
    this.el = document.getElementById('stats-margin');
    const tabs = document.getElementById('pane-tabs');
    if (!this.el || !tabs) return;
    const idStr = new URLSearchParams(window.location.search).get('manuscript_id');
    this.manuscriptId = idStr ? parseInt(idStr, 10) : null;
    if (!this.manuscriptId) return;

    tabs.querySelectorAll('.pane-tab').forEach(tab => {
      tab.addEventListener('click', () => this.setPane(tab.dataset.pane));
    });
    // Re-render on resize: the band is 300px on desktop but viewport-derived
    // in the mobile second bar, and the SVG is sized at render time.
    window.addEventListener('resize', () => {
      clearTimeout(this._resizeTimer);
      this._resizeTimer = setTimeout(() => { if (this.pane === 'stats') this.render(); }, 150);
    }, { passive: true });

    // Birthday/word-goal edits now happen in the settings modal
    // (MANUSCRIPT_LIFECYCLE_PLAN §4) — refresh when it saves.
    window.addEventListener('manuscript-modal-saved', () => this.load());
    // Overlay build lands after pagination — flip the HOLD button from
    // its disabled/spinner state (or drop it, if the session said no).
    document.addEventListener('ms:attention-rebuilt', () => {
      if (this.pane === 'stats') this.render();
    });
    document.addEventListener('ms:layers-reflowed', () => this.syncLayerButtons());

    document.addEventListener('visibilitychange', () => this.onVisible());

    const saved = localStorage.getItem('ms_pane');
    this.setPane(saved === 'stats' || saved === 'people' ? saved : 'outline');
    this.load();
  },

  setPane(pane) {
    this.pane = (pane === 'stats' || pane === 'people') ? pane : 'outline';
    localStorage.setItem('ms_pane', this.pane);
    const outline = document.getElementById('outline-margin');
    if (outline) outline.classList.toggle('pane-off', this.pane !== 'outline');
    this.el.classList.toggle('pane-on', this.pane === 'stats');
    const people = document.getElementById('people-margin');
    if (people) people.classList.toggle('pane-on', this.pane === 'people');
    document.querySelectorAll('#pane-tabs .pane-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.pane === this.pane);
    });
    if (this.pane === 'stats') this.render();
    if (this.pane === 'people' && window.WriteSysPeople) window.WriteSysPeople.load();
  },

  // Live (2026-10-25): the numbers come from the server's wordcount cron,
  // which runs on the clock (interval_minutes — 15 → :00/:15/:30/:45). The
  // pane re-fetches just after each run, and when the tab comes back into
  // view; it re-renders only when something actually changed, and the
  // changed numbers flash (render).
  REFRESH_LAG_MS: 20000,  // after the boundary: the cron takes ~a second
  async load() {
    let fresh;
    try {
      fresh = await fetchJSON(`${this.apiBaseUrl}/manuscripts/${this.manuscriptId}/wordcount-history`);
    } catch (e) {
      console.error('stats: failed to load wordcount history', e);
      fresh = this.data ? this.data : null; // a failed refresh keeps what's shown
    }
    this._loadedAt = Date.now();
    const changed = JSON.stringify(fresh) !== JSON.stringify(this.data);
    this.data = fresh;
    if (changed && this.pane === 'stats') this.render();
    this.scheduleRefresh();
  },

  scheduleRefresh() {
    clearTimeout(this._refreshTimer);
    const d = this.data;
    if (!d || !d.enabled) return;
    const step = Math.max(1, d.interval_minutes || 60) * 60000;
    const next = Math.ceil(Date.now() / step) * step + this.REFRESH_LAG_MS;
    this._nextRefreshAt = next; // (tests read it)
    this._refreshTimer = setTimeout(() => this.load(), Math.max(5000, next - Date.now()));
  },

  // A review just changed what's accepted (NEW ACCEPTED): refresh shortly
  // — debounced, so a batch accept is one fetch.
  refreshSoon() {
    clearTimeout(this._soonTimer);
    this._soonTimer = setTimeout(() => this.load(), 800);
  },

  // Back to the tab after a while (timers sleep in background tabs): catch up.
  onVisible() {
    if (document.visibilityState !== 'visible' || !this._loadedAt) return;
    if (Date.now() - this._loadedAt > 60000) this.load();
  },

  // ---- date helpers. All x positions are "UTC midnight of a calendar
  // day" so day arithmetic is exact regardless of the viewer's timezone.
  parseDay(s) { return Date.parse(s.slice(0, 10) + 'T00:00:00Z'); },
  todayT() {
    const n = new Date();
    return Date.parse(`${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}T00:00:00Z`);
  },
  fmtDay(t, withYear) {
    const d = new Date(t);
    const s = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    return withYear ? `${s} ’${String(d.getUTCFullYear()).slice(2)}` : s;
  },
  fmtDayLong(t) {
    return new Date(t).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  },
  fmtNum(n) { return Math.round(n).toLocaleString('en-US'); },

  // model() digests the API payload into everything the pane shows.
  model() {
    const d = this.data;
    if (!d) return null;
    const rows = (d.rows || []).map(r => ({
      t: this.parseDay(r.day),
      total: (r.words_effective || 0) + (r.words_sketches || 0),
      avg: r.rate_average,
      trend: r.rate_past_30d,
    })).sort((a, b) => a.t - b.t);
    const birthT = d.birthday ? this.parseDay(d.birthday) : null;
    const goal = d.word_goal || 40000;
    const last = rows.length ? rows[rows.length - 1] : null;
    const m = { rows, birthT, goal, last, current: last ? last.total : null };
    if (birthT != null && last) {
      const days = Math.max(1, (last.t - birthT) / this.DAY);
      m.avgRate = m.current / days;
      // Recent pace: slope across the rows inside the trailing 30 days.
      // With fewer than 2 rows in the window there is no slope — fall back
      // to the average so the red line still means something.
      const windowRows = rows.filter(r => r.t >= last.t - 30 * this.DAY);
      const span = windowRows.length >= 2 ? (last.t - windowRows[0].t) / this.DAY : 0;
      m.trendRate = span >= 1 ? (m.current - windowRows[0].total) / span : m.avgRate;
      m.needRate = Math.max(0, (goal - m.current) / 365);
      const cross = (rate) => (rate > 0 && m.current < goal)
        ? last.t + ((goal - m.current) / rate) * this.DAY : null;
      m.avgCrossT = cross(m.avgRate);
      m.trendCrossT = cross(m.trendRate);
    }
    // The per-day rates the cron froze (024) — the rate graph's series.
    // Days from before the cron tracked rates simply have none.
    m.ratePts = rows.filter(r => r.avg != null && r.trend != null);
    // Words as they stood back then (2026-10-26): the latest history row
    // on or before the day; null when the history doesn't reach back.
    const today = this.todayT();
    const asOf = (t) => {
      let hit = null;
      for (const r of rows) { if (r.t <= t) hit = r; else break; }
      return hit ? hit.total : null;
    };
    const lastYear = new Date(today);
    lastYear.setUTCFullYear(lastYear.getUTCFullYear() - 1);
    m.ago = {
      y1: asOf(lastYear.getTime()),
      d30: asOf(today - 30 * this.DAY),
      w1: asOf(today - 7 * this.DAY),
      d1: asOf(today - this.DAY),
    };
    // Words added by the edits accepted right now, not yet committed
    // (server-counted; a commit resets it).
    m.newAccepted = d.new_accepted;
    return m;
  },

  render() {
    if (!this.el) return;
    const m = this.model();
    if (!m) {
      this.el.innerHTML = '<div class="stats-pane"><div class="stats-empty">Statistics unavailable.</div></div>';
      return;
    }
    // Read-only since the settings modal took over editing
    // (MANUSCRIPT_LIFECYCLE_PLAN §4) — values still display here.
    const birthdayVal = m.birthT != null
      ? `<span class="stats-row-value" id="stats-birthday" data-stat="birthday">${this.fmtDayLong(m.birthT)}</span>`
      : `<span class="stats-row-value stats-unset" id="stats-birthday" data-stat="birthday" title="Set in settings">unknown</span>`;
    const haveRates = m.birthT != null && m.current != null;
    const count = (n) => n != null ? this.fmtNum(n) : '<span class="stats-row-unit">&mdash;</span>';
    const rate = (r) => haveRates
      ? `${this.fmtNum(r)} <span class="stats-row-unit">words/day</span>`
      : '<span class="stats-row-unit">&mdash;</span>';
    const rowsHTML =
      `<div class="stats-row"><span class="stats-row-label">BIRTHDAY</span>${birthdayVal}</div>` +
      `<div class="stats-row"><span class="stats-row-label">WORD GOAL</span>` +
        `<span class="stats-row-value" id="stats-goal" data-stat="goal">${this.fmtNum(m.goal)}</span></div>` +
      // Word count lives here now, not in the chrome info line.
      `<div class="stats-row"><span class="stats-row-label">WORDS</span>` +
        `<span class="stats-row-value" id="stats-words" data-stat="words">${m.current != null ? this.fmtNum(m.current) : '<span class="stats-row-unit">&mdash;</span>'}</span></div>` +
      `<div class="stats-row"><span class="stats-row-label">AVERAGE</span><span class="stats-row-value" data-stat="avg">${rate(m.avgRate)}</span></div>` +
      `<div class="stats-row"><span class="stats-row-label">PAST 30D</span><span class="stats-row-value" data-stat="trend">${rate(m.trendRate)}</span></div>` +
      // The pace that finishes the goal one year from now.
      `<div class="stats-row"><span class="stats-row-label">1Y FINISH</span><span class="stats-row-value" data-stat="need">${rate(m.needRate)}</span></div>` +
      // The word count as it stood back then (2026-10-26).
      [['1Y AGO', 'y1'], ['30D AGO', 'd30'], ['1W AGO', 'w1'], ['1D AGO', 'd1']].map(([label, k]) =>
        `<div class="stats-row"><span class="stats-row-label">${label}</span><span class="stats-row-value" data-stat="ago-${k}">${count(m.ago[k])}</span></div>`).join('') +
      // Words added by accepted suggested edits (moved words don't count).
      `<div class="stats-row"><span class="stats-row-label">NEW ACCEPTED</span><span class="stats-row-value" data-stat="accepted">${count(m.newAccepted)}</span></div>`;

    let graphHTML;
    if (m.birthT == null) {
      graphHTML = '<div class="stats-empty">Set a birthday to chart progress.</div>';
    } else if (!m.rows.length) {
      graphHTML = '<div class="stats-empty">No word-count history yet.</div>';
    } else {
      graphHTML = `<div class="stats-graph">${this.buildGraph(m)}</div>`;
      if (m.ratePts.length >= 2) {
        graphHTML += `<div class="stats-graph stats-rate-graph">${this.buildRateGraph(m)}</div>`;
      }
    }

    // Attention toggle for touch devices (ATTENTION_PLAN.md §5): no Tab key
    // on a phone, so the statistics pane offers a TOGGLE button — click to
    // pin the envelope on, click again to release (2026-09-11; was
    // press-and-hold). Same gate as the key: see-attention. The session
    // bootstrap and the overlay build both land async — until then the
    // button sits disabled with a spinner (ms:attention-rebuilt re-renders)
    // instead of popping in later; it drops out only once the session
    // actually denies the action. Pressed state comes from the pin itself
    // so a re-render draws the button the way the page already is.
    const attnDenied = window.currentSession && !(window.WriteSysActions
      && window.WriteSysActions.has(window.WriteSysActions.currentManuscriptId(), 'see-attention'));
    const attnReady = !!(window.WriteSysAttention && window.WriteSysAttention._pages.length);
    const attnOn = !!(window.WriteSysAttention && window.WriteSysAttention.pinned);
    const attnBtn = attnDenied ? ''
      : `<button type="button" id="stats-attention" class="stats-toggle" aria-pressed="${attnOn}"${attnReady ? '' : ' disabled'}>attention</button>`;
    // Markers / footnotes view toggles flank it (2026-10-08). Markers only
    // for eyes that can see a marker glyph at all — committed (see-markers
    // + the settings display) or in a diff (manage-suggestions).
    const R = window.WriteSysRenderer;
    const mkDenied = window.currentSession && !(R && (R.canSeeMarkers() || R.canSeeCommandGlyphs()));
    const hidden = (R && R.hiddenLayers) || {};
    const reflowing = (R && R.reflowingLayers) || {};
    const layerBtn = (kind) =>
      `<button type="button" id="stats-${kind}" class="stats-toggle" data-layer="${kind}" aria-pressed="${!hidden[kind]}"${reflowing[kind] ? ' disabled' : ''}>${kind}</button>`;
    const toggles = (mkDenied ? '' : layerBtn('markers')) + attnBtn + layerBtn('footnotes');

    this.el.innerHTML = `<div class="stats-pane">${rowsHTML}${graphHTML}<div class="stats-toggles">${toggles}</div></div>`;
    this.flashChanged();
    this.wireHover();
    this.wireAttentionToggle();
    this.wireLayerToggles();
  },

  // Click toggles the pin; aria-pressed mirrors it (CSS paints the on-state).
  // A number that changed since you last SAW the pane flashes — a quick
  // highlight that decays at once (a refresh while you watch, or one that
  // landed while another tab was showing). Re-renders for resize/toggles
  // change nothing, so nothing flashes; the first render has nothing to
  // compare with.
  flashChanged() {
    const prev = this._shown || null;
    const now = {};
    this.el.querySelectorAll('[data-stat]').forEach((el) => {
      const key = el.dataset.stat;
      now[key] = el.textContent;
      if (prev && prev[key] !== undefined && prev[key] !== now[key]) {
        el.classList.remove('stats-flash');
        void el.offsetWidth; // restart the animation if it's mid-flash
        el.classList.add('stats-flash');
        el.addEventListener('animationend', () => el.classList.remove('stats-flash'), { once: true });
      }
    });
    this._shown = now;
  },

  wireAttentionToggle() {
    const btn = document.getElementById('stats-attention');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const on = window.WriteSysAttention.togglePinned();
      btn.setAttribute('aria-pressed', String(on));
    });
  },

  // Markers / footnotes: the renderer owns the state and re-paginates
  // without the hidden layer (renderer.setLayerHidden).
  wireLayerToggles() {
    const R = window.WriteSysRenderer;
    if (!R) return;
    this.el.querySelectorAll('.stats-toggle[data-layer]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const kind = btn.dataset.layer;
        const hide = !R.hiddenLayers[kind];
        btn.setAttribute('aria-pressed', String(!hide));
        R.setLayerHidden(kind, hide);
        this.syncLayerButtons();
      });
    });
  },

  // Disabled + spinner (the attention button's pending look) while the
  // layer's re-pagination runs.
  syncLayerButtons() {
    const R = window.WriteSysRenderer;
    if (!this.el || !R) return;
    this.el.querySelectorAll('.stats-toggle[data-layer]').forEach((btn) => {
      btn.disabled = !!R.reflowingLayers[btn.dataset.layer];
    });
  },

  // buildGraph returns the SVG string. Flat: plain x/y axis lines, one
  // dotted gridline at the goal, labels only at 0, the goal, the birthday,
  // and the current extrapolated finish day.
  buildGraph(m) {
    const w = Math.max(180, (this.el.clientWidth || 280) - 30);
    const isBar = this.el.classList.contains('pane-on') && window.innerWidth <= 1239;
    const h = isBar ? 96 : 150;
    const padL = 6, padR = 6, padT = 14, padB = 10;

    const cap = m.last.t + 3 * 365 * this.DAY; // don't let a slow pace stretch the axis for years
    const xEnds = [m.last.t + 365 * this.DAY];
    if (m.avgCrossT != null) xEnds.push(Math.min(m.avgCrossT, cap));
    if (m.trendCrossT != null) xEnds.push(Math.min(m.trendCrossT, cap));
    const xMin = m.birthT, xMax = Math.max(...xEnds);
    // The box's top edge IS the goal — no separate goal gridline needed.
    // (If the count ever exceeds the goal, the top grows to fit and the
    // goal line reappears inside the box.)
    const yMax = Math.max(m.goal, m.current);
    const X = t => padL + ((t - xMin) / (xMax - xMin)) * (w - padL - padR);
    const Y = v => (h - padB) - (v / yMax) * (h - padB - padT);

    const parts = [];
    const line = (x1, y1, x2, y2, color, width, dash, cls) =>
      `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${color}" stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ''}${cls ? ` class="${cls}"` : ''}/>`;

    // Boxed axes (recessive) with the goal number tucked just below the
    // top edge. No "0" — the bottom edge speaks for itself.
    parts.push(this.seasonBands(X, xMin, xMax, padT, Y(0)));
    parts.push(`<rect x="${padL}" y="${padT}" width="${w - padL - padR}" height="${(Y(0) - padT).toFixed(1)}" fill="none" stroke="#cccccc" stroke-width="1"/>`);
    if (m.current > m.goal) {
      parts.push(line(padL, Y(m.goal), w - padR, Y(m.goal), '#dddddd', 1, '2 3'));
    }
    parts.push(`<text x="${padL + 4}" y="${padT + 10}" font-size="8" fill="#999">${this.fmtNum(m.goal)}</text>`);

    // Assumed ramp: birthday (0 words) to the first recorded day — dotted,
    // in the actual series' color, since it's the same story minus the data.
    const first = m.rows[0];
    parts.push(line(X(m.birthT), Y(0), X(first.t), Y(first.total), this.COLOR_ACTUAL, 0.4, '1.5 3'));

    // Actual series.
    const pts = m.rows.map(r => `${X(r.t).toFixed(1)},${Y(r.total).toFixed(1)}`).join(' ');
    parts.push(`<polyline points="${pts}" fill="none" stroke="${this.COLOR_ACTUAL}" stroke-width="0.6"/>`);

    // Extrapolations, all anchored at the latest actual point. Each gets a
    // fat transparent twin for hovering. endAt() clips a rising line to the
    // axis window so a fast pace doesn't shoot past the right edge.
    const anchorX = X(m.last.t), anchorY = Y(m.current);
    const endAt = (rate, crossT) => {
      const endT = crossT != null ? Math.min(crossT, xMax) : xMax;
      const endV = Math.min(yMax, m.current + rate * ((endT - m.last.t) / this.DAY));
      return { x: X(endT), y: Y(endV) };
    };
    const extras = [];
    if (m.current < m.goal) {
      if (m.trendRate > 0) extras.push({ key: 'trend', color: this.COLOR_TREND, dash: '', rate: m.trendRate, end: endAt(m.trendRate, m.trendCrossT), crossT: m.trendCrossT });
      if (m.avgRate > 0) extras.push({ key: 'avg', color: this.COLOR_AVG, dash: '', rate: m.avgRate, end: endAt(m.avgRate, m.avgCrossT), crossT: m.avgCrossT });
      extras.push({ key: 'need', color: this.COLOR_NEED, dash: '', rate: m.needRate, end: { x: X(m.last.t + 365 * this.DAY), y: Y(m.goal) }, crossT: m.last.t + 365 * this.DAY });
    }
    for (const e of extras) {
      parts.push(line(anchorX, anchorY, e.end.x, e.end.y, e.color, 0.4, e.dash));
      // Hidden until its line is hovered: a same-color dotted drop from the
      // line's end to the axis, captioned "May 27, 2027 @ 271 wpd" beside it
      // just above y=0. That caption is the WHOLE hint — no tooltips.
      const dateT = e.key === 'need' ? m.last.t + 365 * this.DAY : e.crossT;
      const caption = `${dateT != null ? this.fmtDayLong(dateT) : ''} @ ${this.fmtNum(e.rate)} wpd`;
      const nearRight = e.end.x > w - 130;
      parts.push(`<g class="stats-finish-marker" data-for="${e.key}" style="display:none">` +
        line(e.end.x, e.end.y, e.end.x, Y(0), e.color, 1, '2 3') +
        `<text x="${(nearRight ? e.end.x - 4 : e.end.x + 4).toFixed(1)}" y="${(Y(0) - 4).toFixed(1)}" font-size="8" fill="${e.color}" text-anchor="${nearRight ? 'end' : 'start'}">${caption}</text>` +
        `</g>`);
      parts.push(`<line x1="${anchorX.toFixed(1)}" y1="${anchorY.toFixed(1)}" x2="${e.end.x.toFixed(1)}" y2="${e.end.y.toFixed(1)}" stroke="transparent" stroke-width="10" class="stats-hit" data-series="${e.key}"/>`);
    }

    // No x-axis labels: the birthday is in the header rows above, and each
    // line's projected finish appears via its hover/tap drop marker.

    // Where we are today: the actual line's latest point.
    parts.push(this.todayDot(X(m.last.t), Y(m.current)));

    return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${parts.join('')}</svg>`;
  },

  // The background shaded by SEASON (2026-10-26; replaced Jan 1 lines):
  // northern-hemisphere astronomical starts — spring Mar 20, summer Jun 21,
  // autumn Sep 22, winter Dec 21. Pale tints under the data; no labels.
  SEASONS: [
    { name: 'winter', m: 11, d: 21, fill: '#ffffff' }, // from Dec 21 (prev. year)
    { name: 'spring', m: 2, d: 20, fill: '#e9f3dd' },
    { name: 'summer', m: 5, d: 21, fill: '#d3e8c4' },
    { name: 'autumn', m: 8, d: 22, fill: '#f2e2b3' },
    { name: 'winter', m: 11, d: 21, fill: '#ffffff' },
  ],
  seasonBands(X, xMin, xMax, top, bottom) {
    let out = '';
    for (let y = new Date(xMin).getUTCFullYear(); y <= new Date(xMax).getUTCFullYear(); y++) {
      for (let i = 0; i < 4; i++) {
        const a = this.SEASONS[i], b = this.SEASONS[i + 1];
        const start = Date.UTC(i === 0 ? y - 1 : y, a.m, a.d);
        const end = Date.UTC(y, b.m, b.d);
        const s = Math.max(start, xMin), e = Math.min(end, xMax);
        if (e <= s) continue;
        const x1 = X(s), x2 = X(e);
        out += `<rect class="stats-season" data-season="${a.name}" x="${x1.toFixed(1)}" y="${top.toFixed(1)}" width="${(x2 - x1).toFixed(1)}" height="${(bottom - top).toFixed(1)}" fill="${a.fill}"/>`;
      }
    }
    // The loop's last year ends at its Dec 21; past that is the next
    // winter's start (the loop draws it as year+1's first band) — add it.
    const tail = Date.UTC(new Date(xMax).getUTCFullYear(), 11, 21);
    if (xMax > tail) {
      const s = Math.max(tail, xMin), x1 = X(s), x2 = X(xMax);
      out += `<rect class="stats-season" data-season="winter" x="${x1.toFixed(1)}" y="${top.toFixed(1)}" width="${(x2 - x1).toFixed(1)}" height="${(bottom - top).toFixed(1)}" fill="#ffffff"/>`;
    }
    return out;
  },

  // Today on a graph: a tiny blue dot that pings — a ring that swells and
  // fades on a loop (CSS .stats-ping; still under reduced motion).
  todayDot(x, y) {
    const c = (cls) => `<circle${cls ? ` class="${cls}"` : ''} cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.2" fill="#2a6fb0"/>`;
    return `<g class="stats-today">${c('stats-ping')}${c('')}</g>`;
  },

  // buildRateGraph: the pace-over-time companion below the progress graph.
  // Same boxed style, NO labels at all — it reads as relative shape. Red is
  // the past-30d pace, blue the average, each day's value as frozen by the
  // cron. X spans birthday → today (the right edge is today, where the
  // progress graph's projections take over); days before rate tracking
  // simply have no line.
  buildRateGraph(m) {
    const w = Math.max(180, (this.el.clientWidth || 280) - 30);
    const isBar = this.el.classList.contains('pane-on') && window.innerWidth <= 1239;
    const h = isBar ? 56 : 84;
    const padL = 6, padR = 6, padT = 6, padB = 6;

    const xMin = m.birthT, xMax = Math.max(this.todayT(), xMin + this.DAY);
    let yMax = 1;
    for (const p of m.ratePts) yMax = Math.max(yMax, p.avg, p.trend);
    yMax *= 1.05;
    const X = t => padL + ((t - xMin) / (xMax - xMin)) * (w - padL - padR);
    const Y = v => (h - padB) - (Math.max(0, v) / yMax) * (h - padB - padT);

    // The past-30d pace only where a FULL 30 days of history stand behind
    // it (2026-10-26) — earlier days' values came from a shorter window.
    const firstT = m.rows.length ? m.rows[0].t : Infinity;
    const full30 = (p) => p.t - firstT >= 30 * this.DAY;
    const series = (key) => m.ratePts.filter(p => p.t <= xMax && (key !== 'trend' || full30(p)));
    const pts = (key) => series(key)
      .map(p => `${X(p.t).toFixed(1)},${Y(p[key]).toFixed(1)}`).join(' ');
    const parts = [];
    parts.push(this.seasonBands(X, xMin, xMax, padT, h - padB));
    parts.push(`<rect x="${padL}" y="${padT}" width="${w - padL - padR}" height="${h - padT - padB}" fill="none" stroke="#cccccc" stroke-width="1"/>`);
    parts.push(`<polyline points="${pts('trend')}" fill="none" stroke="${this.COLOR_TREND}" stroke-width="0.4"/>`);
    parts.push(`<polyline points="${pts('avg')}" fill="none" stroke="${this.COLOR_AVG}" stroke-width="0.4"/>`);
    // Where we are today: the current (past-30d) pace's last point — or
    // the average's, while the history is under 30 days old.
    const lastTrend = series('trend').pop();
    const lastAvg = series('avg').pop();
    if (lastTrend) parts.push(this.todayDot(X(lastTrend.t), Y(lastTrend.trend)));
    else if (lastAvg) parts.push(this.todayDot(X(lastAvg.t), Y(lastAvg.avg)));
    return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${parts.join('')}</svg>`;
  },

  // ---- finish-drop markers (hover on desktop, tap on mobile) -----------
  wireHover() {
    const svg = this.el.querySelector('.stats-graph svg');
    if (!svg) return;
    const markerFor = (key) => svg.querySelector(`.stats-finish-marker[data-for="${key}"]`);
    const hideAll = () => svg.querySelectorAll('.stats-finish-marker').forEach(g => { g.style.display = 'none'; });
    const show = (key) => { hideAll(); const mk = markerFor(key); if (mk) mk.style.display = ''; };
    svg.querySelectorAll('.stats-hit').forEach(hit => {
      hit.addEventListener('mousemove', () => show(hit.dataset.series));
      hit.addEventListener('mouseleave', () => { const mk = markerFor(hit.dataset.series); if (mk) mk.style.display = 'none'; });
      // Touch: a tap fires this too — keep the marker up until a tap lands
      // somewhere else (the svg-background handler below).
      hit.addEventListener('click', (e) => { e.stopPropagation(); show(hit.dataset.series); });
    });
    svg.addEventListener('click', hideAll);
  },
};

if (typeof window !== 'undefined') {
  window.WriteSysStats = WriteSysStats;
  document.addEventListener('DOMContentLoaded', () => WriteSysStats.init());
}
