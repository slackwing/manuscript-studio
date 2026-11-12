/**
 * grid-of-squares — a GitHub-contribution-style grid: one column per day,
 * squares stacked bottom-up, today ~80% of the way across.
 *
 * Squares have TYPES (a schema gives each a color, a rank and whether it
 * bulldozes). A day shows at most its column height; what doesn't fit is
 * either hidden or, for bulldozing types, shoved into the next day's
 * column — cascading as far as needed, even into the future.
 *
 * HOLIDAYS forgive a day: up to a share of its height, the squares it
 * didn't earn show as holiday squares (a darker grey), on top of the real
 * ones — and on a full holiday the real squares it did earn are a bonus,
 * each drawn as a rainbow. Holiday squares are drawn after the overflow simulation, so
 * they never push anything out or carry on.
 *
 * Three layers (tuft lib/ui rules):
 *   - core       normalizeSettings / createModel / layout — pure
 *   - renderer   renderHTML — pure, view model → HTML string
 *   - mount      the only code that touches the DOM
 *
 * Settings reference and examples: README.md next to this file.
 * Tests: tests/ui/test-grid-of-squares.js.
 */
(function () {
  'use strict';

  const DAY = 86400000;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // Common hues only, tuned to sit with manuscript-studio's points grid
  // (its daily green and gold are the anchors).
  const PALETTE = Object.freeze({
    green: '#74b355',
    yellow: '#f0c419',
    orange: '#f0913a',
    red: '#e05d5d',
    pink: '#ec8fb8',
    purple: '#a77bca',
    blue: '#5aa9e0',
    brown: '#a0754d',
    gray: '#9e9a90',
    grey: '#9e9a90',
    black: '#3a3630',
    white: '#ffffff',
    empty: 'rgba(87, 80, 63, 0.14)',
  });

  const DEFAULTS = Object.freeze({
    height: 10,
    heightChanges: [],
    bulldozeMode: 'skim',
    lookahead: 0.2,
    cellSize: 10,
    gap: 2,
    minColumns: 10,
    today: null,
    start: null,
    emptyColor: 'empty',
    todayMarker: true,
    legend: false,
    tooltip: 'counts',
    holidays: [],
  });

  const NORMALIZED = typeof Symbol === 'function' ? Symbol('gos-normalized') : '__gosNormalized';

  function fail(msg) {
    throw new Error('grid-of-squares: ' + msg);
  }

  // ---------------------------------------------------------------------
  // Dates: 'YYYY-MM-DD' strings, arithmetic on UTC midnights (no DST drift).

  function dateToMs(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) fail(`bad date ${JSON.stringify(s)} (want YYYY-MM-DD)`);
    const t = Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
    if (msToDate(t) !== s) fail(`bad date ${JSON.stringify(s)}`);
    return t;
  }

  function msToDate(t) {
    return new Date(t).toISOString().slice(0, 10);
  }

  function addDays(date, n) {
    return msToDate(dateToMs(date) + n * DAY);
  }

  function localToday() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  // ---------------------------------------------------------------------
  // Colors

  /** A palette word (case-insensitive), #rgb, #rrggbb, rgb() or rgba(). */
  function resolveColor(c) {
    if (typeof c !== 'string' || !c.trim()) fail(`bad color ${JSON.stringify(c)}`);
    const t = c.trim();
    const word = t.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(PALETTE, word)) return PALETTE[word];
    if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(t)) return t.toLowerCase();
    const m = t.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(0|1|0?\.\d+|1\.0+)\s*)?\)$/i);
    if (m && [m[1], m[2], m[3]].every((v) => +v <= 255)) {
      return m[4] === undefined ? `rgb(${m[1]}, ${m[2]}, ${m[3]})` : `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${m[4]})`;
    }
    fail(`unknown color ${JSON.stringify(c)} (a palette word, #hex, or rgb())`);
  }

  /** True for near-white colors, which need an outline to show. */
  function isLight(color) {
    let r, g, b;
    const hex = color.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (hex) {
      const h = hex[1].length === 3 ? hex[1].replace(/./g, (x) => x + x) : hex[1];
      [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    } else {
      const m = color.match(/^rgba?\((\d+), (\d+), (\d+)/);
      if (!m) return false;
      [r, g, b] = [+m[1], +m[2], +m[3]];
    }
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 235;
  }

  // ---------------------------------------------------------------------
  // Settings

  function isPositiveInt(n) {
    return Number.isInteger(n) && n > 0;
  }

  /** Validates settings and fills in defaults. Idempotent. */
  function normalizeSettings(settings) {
    if (settings && settings[NORMALIZED]) return settings;
    if (!settings || !Array.isArray(settings.schema) || settings.schema.length === 0) {
      fail('settings.schema must be a non-empty array');
    }
    const s = Object.assign({}, DEFAULTS, settings);

    if (!isPositiveInt(s.height)) fail(`height must be a positive integer, got ${s.height}`);
    if (!Array.isArray(s.heightChanges)) fail('heightChanges must be an array');
    const seen = new Set();
    s.heightChanges = s.heightChanges.map((c) => {
      if (!c || typeof c !== 'object') fail('heightChanges entries are {from, height}');
      dateToMs(c.from);
      if (!isPositiveInt(c.height)) fail(`heightChanges height must be a positive integer, got ${c.height}`);
      if (seen.has(c.from)) fail(`two heightChanges on ${c.from}`);
      seen.add(c.from);
      return { from: c.from, height: c.height };
    }).sort((a, b) => (a.from < b.from ? -1 : 1));

    if (s.bulldozeMode !== 'skim' && s.bulldozeMode !== 'proportional') {
      fail(`bulldozeMode must be 'skim' or 'proportional', got ${JSON.stringify(s.bulldozeMode)}`);
    }
    if (typeof s.lookahead !== 'number' || !(s.lookahead >= 0 && s.lookahead < 1)) {
      fail(`lookahead must be in [0, 1), got ${s.lookahead}`);
    }
    if (typeof s.cellSize !== 'number' || !(s.cellSize > 0)) fail(`cellSize must be > 0, got ${s.cellSize}`);
    if (typeof s.gap !== 'number' || !(s.gap >= 0)) fail(`gap must be ≥ 0, got ${s.gap}`);
    if (!isPositiveInt(s.minColumns)) fail(`minColumns must be a positive integer, got ${s.minColumns}`);
    if (s.today !== null) dateToMs(s.today);
    if (s.start !== null) dateToMs(s.start);
    if (s.tooltip !== 'counts' && s.tooltip !== 'date' && s.tooltip !== 'none') {
      fail(`tooltip must be 'counts', 'date' or 'none', got ${JSON.stringify(s.tooltip)}`);
    }
    s.emptyColor = resolveColor(s.emptyColor);

    // holidays: [{date, fill, bonus}] or [{from, to, fill, bonus}]
    // (inclusive), fill in (0, 1], default 1; bonus (real squares drawn as
    // rainbows) defaults to a full holiday → s.holidayOn: date → {fill, bonus}.
    if (!Array.isArray(s.holidays)) fail('holidays must be an array');
    s.holidayOn = new Map();
    s.holidays = s.holidays.map((h) => {
      if (!h || typeof h !== 'object' || (h.date === undefined && h.from === undefined)) {
        fail('holidays entries are {date, fill} or {from, to, fill}');
      }
      const from = h.date !== undefined ? h.date : h.from;
      const to = h.date !== undefined ? h.date : (h.to === undefined ? h.from : h.to);
      dateToMs(from);
      dateToMs(to);
      if (to < from) fail(`holiday to ${to} is before from ${from}`);
      const fill = h.fill === undefined ? 1 : h.fill;
      if (typeof fill !== 'number' || !(fill > 0 && fill <= 1)) fail(`holiday ${from}: fill must be in (0, 1], got ${h.fill}`);
      const bonus = h.bonus === undefined ? fill === 1 : h.bonus;
      if (typeof bonus !== 'boolean') fail(`holiday ${from}: bonus must be true or false, got ${JSON.stringify(h.bonus)}`);
      for (let d = from; d <= to; d = addDays(d, 1)) {
        if (s.holidayOn.has(d)) fail(`two holidays on ${d}`);
        s.holidayOn.set(d, { fill, bonus });
      }
      return h.date !== undefined ? { date: from, fill, bonus } : { from, to, fill, bonus };
    });

    const byType = Object.create(null);
    s.schema = s.schema.map((t, i) => {
      if (!t || typeof t.type !== 'string' || !t.type) fail(`schema[${i}].type must be a non-empty string`);
      if (byType[t.type]) fail(`duplicate type ${JSON.stringify(t.type)}`);
      const rank = t.rank === undefined ? 0 : t.rank;
      if (typeof rank !== 'number' || !Number.isFinite(rank)) fail(`schema ${t.type}: rank must be a number`);
      const max = t.max === undefined || t.max === null ? null : t.max;
      if (max !== null && !isPositiveInt(max)) fail(`schema ${t.type}: max must be a positive integer, got ${t.max}`);
      const color = resolveColor(t.color);
      const entry = {
        type: t.type,
        color,
        rank,
        bulldoze: t.bulldoze === true,
        max,
        label: t.label === undefined ? t.type : String(t.label),
        light: isLight(color),
      };
      byType[t.type] = entry;
      return entry;
    });
    s.byType = byType;
    s[NORMALIZED] = true;
    return s;
  }

  /** A day's column height: the last heightChange on or before it, else height. */
  function heightOn(s, date) {
    let h = s.height;
    for (const c of s.heightChanges) {
      if (c.from <= date) h = c.height;
      else break;
    }
    return h;
  }

  /** As many columns as fit the width, but at least minColumns. */
  function fitColumns(width, settings) {
    const s = normalizeSettings(settings);
    const w = Number.isFinite(width) && width > 0 ? width : 0;
    return Math.max(s.minColumns, Math.floor((w + s.gap) / (s.cellSize + s.gap)));
  }

  // ---------------------------------------------------------------------
  // Model: the squares added so far, in add order.

  function createModel(settings) {
    const s = normalizeSettings(settings);
    const entries = [];
    let seq = 0;
    return {
      add(date, type, count) {
        if (count === undefined) count = 1;
        dateToMs(date);
        if (!s.byType[type]) fail(`unknown type ${JSON.stringify(type)}`);
        if (!Number.isInteger(count) || count < 0) fail(`count must be a non-negative integer, got ${count}`);
        if (count > 0) entries.push({ date, type, count, seq: seq++ });
      },
      clear() {
        entries.length = 0;
      },
      entries() {
        return entries.slice();
      },
    };
  }

  // ---------------------------------------------------------------------
  // Layout

  // Bottom → top: higher rank lower down; within a rank, the day's own
  // squares first and squares carried in from the day before on top; then
  // add order.
  function stackOrder(s) {
    return (a, b) =>
      (s.byType[b.type].rank - s.byType[a.type].rank) ||
      ((a.carried ? 1 : 0) - (b.carried ? 1 : 0)) ||
      (a.seq - b.seq) ||
      (a.sub - b.sub);
  }

  // Proportional: how many squares of each type leave a column of `stack`
  // squares that may keep only H. Largest remainder, in exact integers;
  // ties go to the type with more squares, then to the lower rank.
  function proportionalShares(stack, H, s) {
    const N = stack.length;
    const E = N - H;
    const counts = new Map();
    for (const sq of stack) counts.set(sq.type, (counts.get(sq.type) || 0) + 1);
    const rows = [...counts].map(([type, n]) => ({
      type,
      n,
      take: Math.floor((E * n) / N),
      rem: (E * n) % N,
      rank: s.byType[type].rank,
    }));
    let left = E - rows.reduce((sum, r) => sum + r.take, 0);
    const byClaim = rows.slice().sort((a, b) => (b.rem - a.rem) || (b.n - a.n) || (a.rank - b.rank));
    for (const r of byClaim) {
      if (left <= 0) break;
      r.take++;
      left--;
    }
    return new Map(rows.map((r) => [r.type, r.take]));
  }

  /**
   * The grid's view model for `columns` columns: which squares each visible
   * day shows. Pure. `entries` are {date, type, count, seq?} (createModel's
   * entries() — or any array in add order).
   */
  function layout(settings, entries, columns) {
    const s = normalizeSettings(settings);
    if (!isPositiveInt(columns)) fail(`columns must be a positive integer, got ${columns}`);
    const today = s.today || localToday();
    const future = s.lookahead > 0 ? Math.min(columns - 1, Math.max(1, Math.round(columns * s.lookahead))) : 0;
    const todayIndex = columns - future - 1;
    const windowStart = addDays(today, -todayIndex);
    const windowEnd = addDays(today, future);

    // Every day's own squares, in add order. Squares before `start` don't
    // exist; a type's squares past its daily `max` don't either (the cap is
    // on what a day earns, before any bulldozing).
    const own = new Map();
    const perDayType = new Map();
    let first = windowStart;
    (entries || []).forEach((e, i) => {
      dateToMs(e.date);
      if (!s.byType[e.type]) fail(`unknown type ${JSON.stringify(e.type)}`);
      if (!Number.isInteger(e.count) || e.count < 0) fail(`count must be a non-negative integer, got ${e.count}`);
      if (s.start && e.date < s.start) return;
      const key = e.date + '|' + e.type;
      const already = perDayType.get(key) || 0;
      const max = s.byType[e.type].max;
      const count = max === null ? e.count : Math.min(e.count, Math.max(0, max - already));
      if (count === 0) return;
      perDayType.set(key, already + count);
      if (!own.has(e.date)) own.set(e.date, []);
      const seq = e.seq === undefined ? i : e.seq;
      for (let k = 0; k < count; k++) own.get(e.date).push({ type: e.type, seq, sub: k, carried: false });
      if (e.date < first) first = e.date;
    });

    // Literal simulation, left → right. Days after the window can't affect
    // it (squares only move rightward), so stop at its end.
    const order = stackOrder(s);
    const shown = new Map();
    let carry = [];
    for (let date = first; date <= windowEnd; date = addDays(date, 1)) {
      let stack = carry.concat(own.get(date) || []).sort(order);
      const H = heightOn(s, date);
      let leaving = [];
      if (stack.length > H) {
        if (s.bulldozeMode === 'skim') {
          leaving = stack.slice(H);
          stack = stack.slice(0, H);
        } else {
          const take = proportionalShares(stack, H, s);
          const kept = [];
          for (let i = stack.length - 1; i >= 0; i--) { // topmost of each type first
            const sq = stack[i];
            if (take.get(sq.type) > 0) {
              take.set(sq.type, take.get(sq.type) - 1);
              leaving.push(sq);
            } else {
              kept.push(sq);
            }
          }
          stack = kept.reverse();
          leaving.reverse();
        }
      }
      carry = leaving
        .filter((sq) => s.byType[sq.type].bulldoze)
        .map((sq) => ({ type: sq.type, seq: sq.seq, sub: sq.sub, carried: true }));
      if (date >= windowStart) shown.set(date, stack);
    }

    const cols = [];
    let maxHeight = 0;
    for (let c = 0; c < columns; c++) {
      const date = addDays(windowStart, c);
      const height = heightOn(s, date);
      if (height > maxHeight) maxHeight = height;
      const stack = shown.get(date) || [];
      const counts = {};
      for (const sq of stack) counts[sq.type] = (counts[sq.type] || 0) + 1;
      // a holiday tops the column up to its share of the height
      // and (a full one, by default) its real squares are bonus squares
      const on = s.holidayOn.get(date);
      const isHoliday = !!on && !(s.start && date < s.start);
      const holiday = isHoliday ? Math.max(0, Math.round(on.fill * height) - stack.length) : 0;
      const cells = stack.map((sq) => {
        const cell = { type: sq.type, color: s.byType[sq.type].color, carried: sq.carried };
        if (isHoliday && on.bonus) cell.bonus = true;
        return cell;
      });
      for (let k = 0; k < holiday; k++) cells.push({ type: null, color: null, carried: false, holiday: true });
      cols.push({
        date,
        height,
        isToday: date === today,
        isFuture: date > today,
        isHoliday,
        counts,
        holiday,
        cells,
      });
    }
    return { today, columns, future, todayIndex, windowStart, windowEnd, maxHeight, cols };
  }

  // ---------------------------------------------------------------------
  // Renderer

  function escapeHTML(t) {
    return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function shortDate(date) {
    return `${MONTHS[+date.slice(5, 7) - 1]} ${+date.slice(8, 10)}`;
  }

  /** The tooltip for a column: "Oct 26 — writing 4 · abi 2" (rank order). */
  function columnTitle(col, s) {
    const parts = s.schema
      .slice()
      .sort((a, b) => b.rank - a.rank)
      .filter((t) => col.counts[t.type])
      .map((t) => `${t.label} ${col.counts[t.type]}`);
    if (col.holiday) parts.push(`holiday ${col.holiday}`);
    return shortDate(col.date) + (parts.length ? ' — ' + parts.join(' · ') : '');
  }

  /** View model → HTML string. Pure. */
  function renderHTML(vm, settings) {
    const s = normalizeSettings(settings);
    const px = (n) => `${n}px`;
    const gridHeight = vm.maxHeight * s.cellSize + Math.max(0, vm.maxHeight - 1) * s.gap;
    const out = [];
    out.push(`<div class="gos" style="--gos-cell:${px(s.cellSize)};--gos-gap:${px(s.gap)};--gos-empty:${s.emptyColor}">`);
    out.push(`<div class="gos-grid" style="height:${px(gridHeight)}">`);
    for (const col of vm.cols) {
      const cls = 'gos-col' + (col.isToday ? ' is-today' : '') + (col.isFuture ? ' is-future' : '');
      const title = s.tooltip === 'counts' ? columnTitle(col, s) : s.tooltip === 'date' ? shortDate(col.date) : null;
      out.push(`<div class="${cls}" data-date="${col.date}"${title === null ? '' : ` title="${escapeHTML(title)}"`}>`);
      for (let row = 0; row < col.height; row++) {
        const cell = col.cells[row];
        if (!cell) {
          out.push('<div class="gos-cell"></div>');
          continue;
        }
        if (cell.holiday) {
          out.push('<div class="gos-cell is-holiday"></div>');
          continue;
        }
        const t = s.byType[cell.type];
        if (cell.bonus) { // the stylesheet paints it (--gos-bonus)
          out.push(`<div class="gos-cell is-lit is-bonus${cell.carried ? ' is-carried' : ''}" data-type="${escapeHTML(cell.type)}"></div>`);
          continue;
        }
        const ccls = 'gos-cell is-lit' + (cell.carried ? ' is-carried' : '') + (t.light ? ' is-light' : '');
        out.push(`<div class="${ccls}" data-type="${escapeHTML(cell.type)}" style="background:${cell.color}"></div>`);
      }
      out.push('</div>');
    }
    out.push('</div>');
    if (s.todayMarker) {
      const left = vm.todayIndex * (s.cellSize + s.gap) + s.cellSize / 2;
      out.push(`<div class="gos-today"><span class="gos-mark" style="left:${px(left)}">`
        + '<span class="gos-arrow"></span><span class="gos-caption">TODAY</span></span></div>');
    }
    if (s.legend) {
      out.push('<div class="gos-legend">');
      for (const t of s.schema.slice().sort((a, b) => b.rank - a.rank)) {
        out.push(`<span class="gos-key"><i class="gos-swatch${t.light ? ' is-light' : ''}" style="background:${t.color}"></i>${escapeHTML(t.label)}</span>`);
      }
      if (s.holidays.length) out.push('<span class="gos-key"><i class="gos-swatch is-holiday"></i>holiday</span>');
      out.push('</div>');
    }
    out.push('</div>');
    return out.join('');
  }

  // ---------------------------------------------------------------------
  // Mount — the only DOM code.

  /**
   * Renders into `el` and refits on resize. Returns {add, clear, render,
   * destroy}; add/clear don't re-render — call render() after a batch.
   */
  function mount(el, settings) {
    const s = normalizeSettings(settings);
    const model = createModel(s);
    let timer = null;
    let lastWidth = -1;
    const api = {
      add(date, type, count) {
        model.add(date, type, count);
        return api;
      },
      clear() {
        model.clear();
        return api;
      },
      render() {
        lastWidth = el.clientWidth;
        el.innerHTML = renderHTML(layout(s, model.entries(), fitColumns(lastWidth, s)), s);
        return api;
      },
      destroy() {
        clearTimeout(timer);
        if (observer) observer.disconnect();
        else window.removeEventListener('resize', onResize);
        el.innerHTML = '';
      },
    };
    const onResize = () => {
      if (el.clientWidth === lastWidth) return;
      clearTimeout(timer);
      timer = setTimeout(api.render, 150);
    };
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(onResize) : null;
    if (observer) observer.observe(el);
    else window.addEventListener('resize', onResize);
    api.render();
    return api;
  }

  const GridOfSquares = {
    mount,
    createModel,
    layout,
    renderHTML,
    normalizeSettings,
    resolveColor,
    fitColumns,
    heightOn: (settings, date) => heightOn(normalizeSettings(settings), date),
    PALETTE,
    DEFAULTS,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = GridOfSquares;
  if (typeof window !== 'undefined') {
    window.Tuft = window.Tuft || {};
    window.Tuft.GridOfSquares = GridOfSquares;
  }
})();
