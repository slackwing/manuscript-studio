/**
 * Statistics pane (STATS_PLAN) — the outline's tab-switched sibling in the
 * left band. Shows birthday (editable), word goal (editable), average
 * words/day since birthday, and a mini progress graph:
 *
 *   black dotted — assumed ramp from (birthday, 0) to the first cron row
 *   black solid  — actual daily totals (wordcount_history: effective+snippets)
 *   red   solid  — extrapolation at the recent 30-day pace
 *   blue  solid  — extrapolation at the average-since-birthday pace
 *   purple solid — the pace needed to reach the goal one year from today
 *
 * No legend — hovering a line says what it means, its rate, and its
 * expected finish day; hovering the actual series shows that day's count.
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

    this.setPane(localStorage.getItem('ms_pane') === 'stats' ? 'stats' : 'outline');
    this.load();
  },

  setPane(pane) {
    this.pane = pane === 'stats' ? 'stats' : 'outline';
    localStorage.setItem('ms_pane', this.pane);
    const outline = document.getElementById('outline-margin');
    if (outline) outline.classList.toggle('pane-off', this.pane === 'stats');
    this.el.classList.toggle('pane-on', this.pane === 'stats');
    document.querySelectorAll('#pane-tabs .pane-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.pane === this.pane);
    });
    if (this.pane === 'stats') this.render();
  },

  async load() {
    try {
      this.data = await fetchJSON(`${this.apiBaseUrl}/manuscripts/${this.manuscriptId}/wordcount-history`);
    } catch (e) {
      console.error('stats: failed to load wordcount history', e);
      this.data = null;
    }
    if (this.pane === 'stats') this.render();
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
      total: (r.words_effective || 0) + (r.words_snippets || 0),
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
    return m;
  },

  render() {
    if (!this.el) return;
    const m = this.model();
    if (!m) {
      this.el.innerHTML = '<div class="stats-pane"><div class="stats-empty">Statistics unavailable.</div></div>';
      return;
    }
    const birthdayVal = m.birthT != null
      ? `<span class="stats-row-value stats-editable" id="stats-birthday" title="Click to edit">${this.fmtDayLong(m.birthT)}</span>`
      : `<span class="stats-row-value stats-editable stats-unset" id="stats-birthday" title="Click to set">set birthday</span>`;
    const avgVal = (m.birthT != null && m.current != null)
      ? `${this.fmtNum(m.avgRate)} <span class="stats-row-unit">words/day</span>`
      : '<span class="stats-row-unit">&mdash;</span>';
    const rowsHTML =
      `<div class="stats-row"><span class="stats-row-label">BIRTHDAY</span>${birthdayVal}</div>` +
      `<div class="stats-row"><span class="stats-row-label">WORD GOAL</span>` +
        `<span class="stats-row-value stats-editable" id="stats-goal" title="Click to edit">${this.fmtNum(m.goal)}</span></div>` +
      `<div class="stats-row"><span class="stats-row-label">AVERAGE</span><span class="stats-row-value">${avgVal}</span></div>`;

    let graphHTML;
    if (m.birthT == null) {
      graphHTML = '<div class="stats-empty">Set a birthday to chart progress.</div>';
    } else if (!m.rows.length) {
      graphHTML = '<div class="stats-empty">No word-count history yet.</div>';
    } else {
      graphHTML = `<div class="stats-graph">${this.buildGraph(m)}</div>`;
    }

    this.el.innerHTML = `<div class="stats-pane">${rowsHTML}${graphHTML}</div>`;
    this.wireEditors(m);
    this.wireHover();
  },

  // buildGraph returns the SVG string. Flat: plain x/y axis lines, one
  // dotted gridline at the goal, labels only at 0, the goal, the birthday,
  // and the current extrapolated finish day.
  buildGraph(m) {
    const w = Math.max(180, (this.el.clientWidth || 280) - 30);
    const isBar = this.el.classList.contains('pane-on') && window.innerWidth <= 1239;
    const h = isBar ? 96 : 150;
    const padL = 6, padR = 6, padT = 14, padB = 24;

    const cap = m.last.t + 3 * 365 * this.DAY; // don't let a slow pace stretch the axis for years
    const xEnds = [m.last.t + 365 * this.DAY];
    if (m.avgCrossT != null) xEnds.push(Math.min(m.avgCrossT, cap));
    if (m.trendCrossT != null) xEnds.push(Math.min(m.trendCrossT, cap));
    const xMin = m.birthT, xMax = Math.max(...xEnds);
    const yMax = Math.max(m.goal, m.current) * 1.02;
    const X = t => padL + ((t - xMin) / (xMax - xMin)) * (w - padL - padR);
    const Y = v => (h - padB) - (v / yMax) * (h - padB - padT);

    const parts = [];
    const line = (x1, y1, x2, y2, color, width, dash, cls) =>
      `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${color}" stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ''}${cls ? ` class="${cls}"` : ''}/>`;

    // Axes (plain, recessive) + goal gridline + y labels.
    parts.push(line(padL, Y(0), w - padR, Y(0), '#cccccc', 1));
    parts.push(line(padL, padT, padL, Y(0), '#cccccc', 1));
    parts.push(line(padL, Y(m.goal), w - padR, Y(m.goal), '#dddddd', 1, '2 3'));
    parts.push(`<text x="${padL + 3}" y="${Y(m.goal) - 3}" font-size="8" fill="#999">${this.fmtNum(m.goal)}</text>`);
    parts.push(`<text x="${padL + 3}" y="${h - padB + 9}" font-size="8" fill="#999">0</text>`);

    // Assumed ramp: birthday (0 words) to the first recorded day — dotted,
    // in the actual series' color, since it's the same story minus the data.
    const first = m.rows[0];
    parts.push(line(X(m.birthT), Y(0), X(first.t), Y(first.total), this.COLOR_ACTUAL, 1.4, '1.5 3'));

    // Actual series.
    const pts = m.rows.map(r => `${X(r.t).toFixed(1)},${Y(r.total).toFixed(1)}`).join(' ');
    parts.push(`<polyline points="${pts}" fill="none" stroke="${this.COLOR_ACTUAL}" stroke-width="1.6"/>`);
    parts.push(`<polyline points="${pts}" fill="none" stroke="transparent" stroke-width="10" class="stats-hit" data-series="actual"/>`);

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
      parts.push(line(anchorX, anchorY, e.end.x, e.end.y, e.color, 1.4, e.dash));
      parts.push(`<line x1="${anchorX.toFixed(1)}" y1="${anchorY.toFixed(1)}" x2="${e.end.x.toFixed(1)}" y2="${e.end.y.toFixed(1)}" stroke="transparent" stroke-width="10" class="stats-hit" data-series="${e.key}"/>`);
    }

    // X labels: only the birthday and the CURRENT extrapolated finish day
    // (recent pace when it projects a finish, else the average) — exact
    // dates for every line live in the hover.
    const xLabel = (t, anchorMode) =>
      `<text x="${Math.min(Math.max(X(t), padL), w - padR).toFixed(1)}" y="${h - 3}" font-size="8" fill="#999" text-anchor="${anchorMode}">${this.fmtDay(t, true)}</text>`;
    parts.push(xLabel(m.birthT, 'start'));
    const finishT = (m.trendCrossT != null && m.trendCrossT <= xMax) ? m.trendCrossT
      : (m.avgCrossT != null && m.avgCrossT <= xMax) ? m.avgCrossT : null;
    if (finishT != null && X(finishT) - X(m.birthT) > 50) {
      parts.push(xLabel(finishT, X(finishT) > w - 50 ? 'end' : 'middle'));
    }

    this._graphModel = m; // for tooltips
    this._graphGeom = { xMin, xMax, w, padL, padR };
    return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${parts.join('')}</svg>`;
  },

  // ---- hover tooltips -------------------------------------------------
  wireHover() {
    const svg = this.el.querySelector('.stats-graph svg');
    if (!svg) return;
    let tip = document.getElementById('stats-tip');
    if (!tip) {
      tip = document.createElement('div');
      tip.id = 'stats-tip';
      document.body.appendChild(tip);
    }
    const m = this._graphModel;
    // Each extrapolation's hover: what it means · its rate · expected
    // finish day (the only place the exact dates live — there's no legend).
    const finish = (t) => (t != null ? ` · finish ${this.fmtDay(t, true)}` : '');
    const text = (series, evt) => {
      if (series === 'trend') {
        return `recent pace (last 30 days) · ${this.fmtNum(m.trendRate)} words/day${finish(m.trendCrossT)}`;
      }
      if (series === 'avg') {
        return `average since birthday · ${this.fmtNum(m.avgRate)} words/day${finish(m.avgCrossT)}`;
      }
      if (series === 'need') {
        return `needed to finish in 1 year · ${this.fmtNum(m.needRate)} words/day${finish(m.last.t + 365 * this.DAY)}`;
      }
      // actual: nearest recorded day to the pointer.
      const g = this._graphGeom;
      const rect = svg.getBoundingClientRect();
      const px = ((evt.clientX - rect.left) / rect.width) * g.w;
      const t = g.xMin + ((px - g.padL) / (g.w - g.padL - g.padR)) * (g.xMax - g.xMin);
      let nearest = m.rows[0];
      for (const r of m.rows) if (Math.abs(r.t - t) < Math.abs(nearest.t - t)) nearest = r;
      return `${this.fmtDay(nearest.t, true)} · ${this.fmtNum(nearest.total)} words`;
    };
    svg.querySelectorAll('.stats-hit').forEach(hit => {
      hit.addEventListener('mousemove', (evt) => {
        tip.textContent = text(hit.dataset.series, evt);
        tip.style.display = 'block';
        tip.style.left = `${Math.min(evt.clientX + 12, window.innerWidth - tip.offsetWidth - 8)}px`;
        tip.style.top = `${evt.clientY - 28}px`;
      });
      hit.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
    });
  },

  // ---- inline editors -------------------------------------------------
  wireEditors(m) {
    const goalEl = this.el.querySelector('#stats-goal');
    if (goalEl) goalEl.addEventListener('click', () => this.editField(goalEl, {
      type: 'number',
      value: m.goal,
      attrs: 'min="1" step="1000"',
      parse: (v) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? { word_goal: n } : null; },
    }));
    const bdayEl = this.el.querySelector('#stats-birthday');
    if (bdayEl) bdayEl.addEventListener('click', () => this.editField(bdayEl, {
      type: 'date',
      value: m.birthT != null ? new Date(m.birthT).toISOString().slice(0, 10) : '',
      attrs: '',
      parse: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) ? { birthday: v } : null,
    }));
  },

  editField(span, spec) {
    if (span._editing) return;
    span._editing = true;
    const input = document.createElement('input');
    input.className = 'stats-edit-input';
    input.type = spec.type;
    input.value = spec.value;
    (spec.attrs.match(/(\w+)="([^"]*)"/g) || []).forEach(a => {
      const [, k, v] = a.match(/(\w+)="([^"]*)"/);
      input.setAttribute(k, v);
    });
    span.replaceWith(input);
    input.focus();
    if (spec.type === 'number') input.select();
    let done = false;
    const finish = async (commit) => {
      if (done) return;
      done = true;
      const patch = commit ? spec.parse(input.value) : null;
      if (patch && String(input.value) !== String(spec.value)) {
        await this.patchMeta(patch);
      } else {
        this.render(); // restore the span
      }
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  },

  async patchMeta(patch) {
    try {
      const res = await authenticatedFetch(`${this.apiBaseUrl}/manuscripts/${this.manuscriptId}/meta`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': sessionStorage.getItem('csrf_token') || localStorage.getItem('csrf_token') || '',
        },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const meta = await res.json();
      if (this.data) {
        this.data.birthday = meta.birthday;
        this.data.word_goal = meta.word_goal;
      }
    } catch (e) {
      console.error('stats: failed to update manuscript meta', e);
    }
    this.render();
  },
};

if (typeof window !== 'undefined') {
  window.WriteSysStats = WriteSysStats;
  document.addEventListener('DOMContentLoaded', () => WriteSysStats.init());
}
