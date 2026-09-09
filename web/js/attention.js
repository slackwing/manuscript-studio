/**
 * attention.js — the reader-attention envelope (ATTENTION_PLAN.md).
 *
 * A completely novel feature; nothing here follows a stock pattern, so
 * READ THE PLAN DOC FIRST. The one-paragraph version:
 *
 *   Markers carry signed integer attention values (settings → Markers).
 *   Reading progression is time t measured in WORDS. Every marker fires
 *   an impulse kernel — fast smooth attack, slow exponential decay, peak
 *   exactly its value — and the envelope a(t) is their superposition.
 *   After Paged.js finishes, we harvest the page geometry, sample a(t)
 *   down each page, and pre-render one rotated-axes SVG per page:
 *   t runs DOWN the page, attention runs RIGHT. a=0 sits on the sheet's
 *   LEFT EDGE; +FULL_SCALE on the sheet's right edge; negative attention
 *   spills OFF the sheet into the gray backdrop gutter (the author's
 *   explicit wish — hence the SVG canvas extends a sheet-width beyond
 *   each side). Positive area fills light green, negative light red.
 *   Holding Tab (book page, see-attention holders only) reveals the
 *   overlays BEHIND the text; releasing hides them.
 *
 * Pre-generation is deliberate: the math couples to pagination, so the
 * overlay is a pure function of the final page geometry — rebuilt from
 * the afterRendered hook (pagedjs-config.js), never during a render.
 */
window.WriteSysAttention = {
  // ---- TUNING — the author calibrates these BY FEEL while reading -----
  // (hold Tab, judge the envelope, tweak here or live on
  // window.WriteSysAttention.TUNING in the console, re-hold Tab after
  // calling rebuild()). Units are WORDS, not pixels: attention decays
  // with reading effort, and headings/blank space cost nothing.
  TUNING: {
    ATTACK_WORDS: 12,   // rise time-constant — "fast smooth curve up"
    DECAY_WORDS: 250,   // fall to 1/e of the contribution after this many words
    FULL_SCALE: 10,     // a=+10 lands exactly on the sheet's right edge
    SAMPLE_STEP_PX: 3,  // vertical sampling resolution per page
    CUTOFF_DECAYS: 6,   // ignore a marker beyond 6×DECAY_WORDS — contributes ~0.25%
  },

  _pages: [],   // [{el, svg}] — pages that received an overlay
  _armed: false,

  // ---- The kernel (pure math — unit-tested in test-attention-units) ---
  // K(u) = N · (e^(−u/DECAY) − e^(−u/ATTACK)) for u ≥ 0, else 0, with N
  // chosen so the peak is EXACTLY 1: a lone #twist (+15) peaks at 15.
  // Peak sits at u* = (A·D/(D−A))·ln(D/A) — a few words after the marker,
  // which is the "not a hard spike" the author asked for.
  kernel(u) {
    if (u < 0) return 0;
    const A = this.TUNING.ATTACK_WORDS;
    const D = this.TUNING.DECAY_WORDS;
    const uStar = (A * D) / (D - A) * Math.log(D / A);
    const N = 1 / (Math.exp(-uStar / D) - Math.exp(-uStar / A));
    return N * (Math.exp(-u / D) - Math.exp(-u / A));
  },

  // a(t) over events [{t, v}] — superposition with a cutoff window.
  attentionAt(t, events) {
    const cutoff = this.TUNING.CUTOFF_DECAYS * this.TUNING.DECAY_WORDS;
    let a = 0;
    for (const e of events) {
      const u = t - e.t;
      if (u < 0) break; // events sorted by t; later ones can't contribute
      if (u > cutoff) continue;
      a += e.v * this.kernel(u);
    }
    return a;
  },

  _gate() {
    return !!(window.WriteSysActions
      && window.WriteSysActions.has(window.WriteSysActions.currentManuscriptId(), 'see-attention'));
  },

  // ---- Harvest: pages → visual lines with word spans ------------------
  // Each .sentence FRAGMENT contributes line rects (getClientRects); its
  // own textContent gives its words, apportioned across its rects by
  // width. Rects group into VISUAL LINES (top within 2px, same page);
  // lines get consecutive t spans. All coordinates are stored PAGE-LOCAL
  // and UNSCALED (divide client rects by the responsive-scaling factor),
  // so the SVG — living inside the transformed page — needs no resize
  // handling: it scales with the sheet.
  _harvest() {
    const pages = [...document.querySelectorAll('.pagedjs_pages .pagedjs_page')];
    const lines = []; // {pageIdx, top, bottom, left, width, words, tStart}
    const markers = []; // {t, v}
    const lineAt = (pageIdx, top) => lines.find((l) =>
      l.pageIdx === pageIdx && Math.abs(l.top - top) < 2);
    const pageRects = pages.map((p) => p.getBoundingClientRect());
    const scaleOf = (i) => pageRects[i].width / pages[i].offsetWidth || 1;
    const pageOf = (clientY, clientX) => pageRects.findIndex((r) =>
      clientY >= r.top - 1 && clientY <= r.bottom + 1 && clientX >= r.left - 1 && clientX <= r.right + 1);

    for (const frag of document.querySelectorAll('.pagedjs_pages .sentence')) {
      const words = (frag.textContent.trim().match(/\S+/g) || []).length;
      const rects = [...frag.getClientRects()].filter((r) => r.width > 1 && r.height > 1);
      if (!rects.length) continue;
      const totalW = rects.reduce((s, r) => s + r.width, 0) || 1;
      for (const r of rects) {
        const pi = pageOf(r.top + r.height / 2, r.left + r.width / 2);
        if (pi < 0) continue;
        const s = scaleOf(pi);
        const top = (r.top - pageRects[pi].top) / s;
        const line = lineAt(pi, top);
        const w = words * (r.width / totalW);
        if (line) {
          line.words += w;
          line.left = Math.min(line.left, (r.left - pageRects[pi].left) / s);
          line.width += r.width / s;
          line.bottom = Math.max(line.bottom, top + r.height / s);
        } else {
          lines.push({
            pageIdx: pi, top, bottom: top + r.height / s,
            left: (r.left - pageRects[pi].left) / s, width: r.width / s,
            words: w, tStart: 0,
          });
        }
      }
    }
    // Reading order = page, then top. Assign consecutive t spans.
    lines.sort((a, b) => (a.pageIdx - b.pageIdx) || (a.top - b.top));
    let t = 0;
    for (const l of lines) { l.tStart = t; t += l.words; }

    // Markers: the spans exist even when their glyphs are hidden (the
    // invisible .inline-cmd keeps data-kind/data-slug — visibility gating
    // never removes them). t interpolates by x-offset within the line.
    const sel = '.pagedjs_pages .cmd-diamond-marker, '
      + '.pagedjs_pages .inline-cmd[data-kind="marker"], .pagedjs_pages .inline-cmd[data-kind="mark"]';
    for (const el of document.querySelectorAll(sel)) {
      const slug = el.dataset.slug || '';
      const v = window.WriteSysMarkerSymbols
        ? window.WriteSysMarkerSymbols.attentionFor(slug) : 0;
      if (!v) continue; // unconfigured/neutral markers shape no envelope
      const r = el.getBoundingClientRect();
      const anchor = el.parentElement && r.width === 0 ? el.parentElement.getBoundingClientRect() : r;
      const pi = pageOf(anchor.top + anchor.height / 2, anchor.left + 1);
      if (pi < 0) continue;
      const s = scaleOf(pi);
      const top = (anchor.top - pageRects[pi].top) / s;
      const line = lines.find((l) => l.pageIdx === pi && top >= l.top - 2 && top <= l.bottom + 2);
      if (!line) continue;
      const fx = Math.max(0, Math.min(1,
        (((anchor.left - pageRects[pi].left) / s) - line.left) / (line.width || 1)));
      markers.push({ t: line.tStart + line.words * fx, v });
    }
    markers.sort((a, b) => a.t - b.t);
    return { pages, lines, markers };
  },

  // ---- Emit: one rotated-axes SVG per page -----------------------------
  rebuild() {
    this.teardown();
    if (!this._gate()) return;
    const { pages, lines, markers } = this._harvest();
    if (!lines.length) return;
    const F = this.TUNING.FULL_SCALE;
    for (let pi = 0; pi < pages.length; pi++) {
      const pageLines = lines.filter((l) => l.pageIdx === pi);
      if (!pageLines.length) continue;
      const page = pages[pi];
      const W = page.offsetWidth;
      const H = page.offsetHeight;
      const y0 = pageLines[0].top;
      const y1 = pageLines[pageLines.length - 1].bottom;
      // y → t: within a line, t advances linearly down its height; in the
      // gaps BETWEEN lines t freezes (no words there — paragraph breaks
      // and headings cost no attention, by design).
      const tOf = (y) => {
        let t = pageLines[0].tStart;
        for (const l of pageLines) {
          if (y >= l.bottom) { t = l.tStart + l.words; continue; }
          if (y >= l.top) return l.tStart + l.words * ((y - l.top) / (l.bottom - l.top));
          break;
        }
        return t;
      };
      // Sample the envelope down the page.
      const pts = [];
      for (let y = y0; y <= y1; y += this.TUNING.SAMPLE_STEP_PX) {
        pts.push([y, this.attentionAt(tOf(y), markers)]);
      }
      if (pts[pts.length - 1][0] !== y1) pts.push([y1, this.attentionAt(tOf(y1), markers)]);
      // a → x: 0 at the sheet's left edge, FULL_SCALE at its right edge;
      // negatives run off-sheet into the backdrop gutter.
      const x = (a) => (a / F) * W;
      const area = (clampFn) => 'M0 ' + pts[0][0].toFixed(1)
        + pts.map(([y, a]) => `L${x(clampFn(a)).toFixed(2)} ${y.toFixed(1)}`).join('')
        + `L0 ${pts[pts.length - 1][0].toFixed(1)}Z`;
      const curve = 'M' + pts.map(([y, a]) => `${x(a).toFixed(2)} ${y.toFixed(1)}`).join('L');
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'attention-overlay');
      // Canvas spans one sheet-width beyond BOTH edges (negative min-x
      // viewBox) so deep dips and >FULL_SCALE spikes stay visible.
      svg.setAttribute('viewBox', `${-W} 0 ${3 * W} ${H}`);
      svg.setAttribute('preserveAspectRatio', 'none');
      svg.style.cssText = `position:absolute;top:0;left:${-W}px;width:${3 * W}px;height:${H}px;`
        + 'z-index:-1;pointer-events:none;';
      svg.innerHTML = `<path d="${area((a) => Math.max(a, 0))}" fill="rgba(46,125,50,0.16)"/>`
        + `<path d="${area((a) => Math.min(a, 0))}" fill="rgba(179,59,58,0.14)"/>`
        + `<path d="${curve}" fill="none" stroke="rgba(60,50,30,0.28)" stroke-width="1"/>`;
      // Behind the text: the page becomes its own stacking context and
      // the negative-z child paints above the sheet's white background
      // but below all in-flow prose. Do NOT "simplify" to a positive
      // z-index — it would wash the text.
      if (getComputedStyle(page).position === 'static') page.style.position = 'relative';
      page.style.zIndex = '0';
      page.appendChild(svg);
      this._pages.push({ el: page, svg });
    }
    this._armKeys();
  },

  teardown() {
    for (const p of this._pages) p.svg.remove();
    this._pages = [];
    document.documentElement.classList.remove('attention-held');
  },

  // ---- Hold Tab to peek ------------------------------------------------
  _armKeys() {
    if (this._armed) return;
    this._armed = true;
    const editable = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'
      || el.isContentEditable);
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab' || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (editable(e.target) || !this._pages.length || !this._gate()) return;
      e.preventDefault(); // Tab must not cycle focus while peeking
      document.documentElement.classList.add('attention-held');
    });
    document.addEventListener('keyup', (e) => {
      if (e.key === 'Tab') document.documentElement.classList.remove('attention-held');
    });
    window.addEventListener('blur', () =>
      document.documentElement.classList.remove('attention-held'));
  },
};
