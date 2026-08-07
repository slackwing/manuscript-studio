/**
 * Statistics pane (STATS_PLAN) — the outline's tab-switched sibling in the
 * left band. Shows birthday (editable), word goal (editable), average
 * words/day since birthday, and a mini progress graph:
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
    const haveRates = m.birthT != null && m.current != null;
    const rate = (r) => haveRates
      ? `${this.fmtNum(r)} <span class="stats-row-unit">words/day</span>`
      : '<span class="stats-row-unit">&mdash;</span>';
    const rowsHTML =
      `<div class="stats-row"><span class="stats-row-label">BIRTHDAY</span>${birthdayVal}</div>` +
      `<div class="stats-row"><span class="stats-row-label">WORD GOAL</span>` +
        `<span class="stats-row-value stats-editable" id="stats-goal" title="Click to edit">${this.fmtNum(m.goal)}</span></div>` +
      `<div class="stats-row"><span class="stats-row-label">AVERAGE</span><span class="stats-row-value">${rate(m.avgRate)}</span></div>` +
      `<div class="stats-row"><span class="stats-row-label">PAST 30D</span><span class="stats-row-value">${rate(m.trendRate)}</span></div>` +
      // The pace that finishes the goal one year from now.
      `<div class="stats-row"><span class="stats-row-label">1Y RATE</span><span class="stats-row-value">${rate(m.needRate)}</span></div>`;

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
    parts.push(`<rect x="${padL}" y="${padT}" width="${w - padL - padR}" height="${(Y(0) - padT).toFixed(1)}" fill="none" stroke="#cccccc" stroke-width="1"/>`);
    if (m.current > m.goal) {
      parts.push(line(padL, Y(m.goal), w - padR, Y(m.goal), '#dddddd', 1, '2 3'));
    }
    parts.push(`<text x="${padL + 4}" y="${padT + 10}" font-size="8" fill="#999">${this.fmtNum(m.goal)}</text>`);

    // Assumed ramp: birthday (0 words) to the first recorded day — dotted,
    // in the actual series' color, since it's the same story minus the data.
    const first = m.rows[0];
    parts.push(line(X(m.birthT), Y(0), X(first.t), Y(first.total), this.COLOR_ACTUAL, 1.4, '1.5 3'));

    // Actual series.
    const pts = m.rows.map(r => `${X(r.t).toFixed(1)},${Y(r.total).toFixed(1)}`).join(' ');
    parts.push(`<polyline points="${pts}" fill="none" stroke="${this.COLOR_ACTUAL}" stroke-width="1.6"/>`);

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

    return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${parts.join('')}</svg>`;
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

    const pts = (key) => m.ratePts
      .filter(p => p.t <= xMax)
      .map(p => `${X(p.t).toFixed(1)},${Y(p[key]).toFixed(1)}`).join(' ');
    const parts = [];
    parts.push(`<rect x="${padL}" y="${padT}" width="${w - padL - padR}" height="${h - padT - padB}" fill="none" stroke="#cccccc" stroke-width="1"/>`);
    parts.push(`<polyline points="${pts('trend')}" fill="none" stroke="${this.COLOR_TREND}" stroke-width="1.4"/>`);
    parts.push(`<polyline points="${pts('avg')}" fill="none" stroke="${this.COLOR_AVG}" stroke-width="1.4"/>`);
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
