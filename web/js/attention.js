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
 *   LEFT EDGE; +FULL_SCALE (10) on the sheet's right edge; negative attention
 *   spills OFF the sheet into the gray backdrop gutter (the author's
 *   explicit wish — hence the SVG canvas extends a sheet-width beyond
 *   each side). Positive area fills green, negative red — shading only,
 *   no outline stroke.
 *   Holding Tab (book page, see-attention holders only) reveals the
 *   overlays BEHIND the text; releasing hides them.
 *
 * Pre-generation is deliberate: the math couples to pagination, so the
 * overlay is a pure function of the final page geometry — rebuilt from
 * the afterRendered hook (pagedjs-config.js), never during a render.
 *
 * ═══════════ THE FORMULA (maintained — update THIS block with every
 * change to the math; ATTENTION_PLAN.md §2 mirrors it) ═══════════
 *
 *   a(t)  = Σᵢ v̂ᵢ · K(t − tᵢ)                       superposition
 *   K(u)  = N · (1 − e^(−(u/A)³)) · e^(−u/D)   u≥0   C² onset, exp decay,
 *           0                                  u<0   peak numerically = 1
 *   v̂ᵢ    = vᵢ / (1 + J(tᵢ)/JADE_SCALE)             jading (divisive
 *                                                    normalization)
 *   J     — per-SIGN jadedness pools (positive and negative markers
 *           habituate INDEPENDENTLY; author decision 2026-09-09):
 *           between markers  J ← J · e^(−Δt/JADE_RECOVERY_WORDS)
 *           after each marker J ← J + |v̂ᵢ|
 *           (global across slugs for now — per-slug/stimulus-specific
 *           habituation is a someday, per the author)
 *   y→t   — Fritsch–Carlson monotone cubic through line centers (C¹)
 *   t     — WORDS read;  x(a) = (a / FULL_SCALE) · sheetWidth, from the
 *           sheet's left edge (negatives spill into the backdrop gutter)
 * ══════════════════════════════════════════════════════════════════
 */
window.WriteSysAttention = {
  // ---- TUNING — the author calibrates these BY FEEL while reading -----
  // (hold Tab, judge the envelope, tweak here or live on
  // window.WriteSysAttention.TUNING in the console, re-hold Tab after
  // calling rebuild()). Units are WORDS, not pixels: attention decays
  // with reading effort, and headings/blank space cost nothing.
  TUNING: {
    // NOTE the peak does NOT sit at the marker: it lands ~1.8×A words
    // AFTER it (numerically located — see kernel()). A=7 → ~13 words,
    // about one line: accelerate, decelerate, turn. (History: the first
    // double-exponential kernel at A=12 peaked 38 words out and read as
    // "keeps climbing past the peak"; its A=3 successor peaked right but
    // STARTED with a kink — the C²-smooth onset below replaced it,
    // 2026-09-09 evening, "multiple levels of derivatives smooth".)
    ATTACK_WORDS: 7,    // onset scale of the C² rise ("fast smooth curve up")
    DECAY_WORDS: 120,   // fall to 1/e after this many words (author: 250 "decreases too slowly")
    FULL_SCALE: 10,     // a=+10 lands exactly on the sheet's right edge (calibrated back from 25 after jading landed, 2026-09-09)
    SAMPLE_STEP_PX: 3,  // vertical sampling resolution per page
    CUTOFF_DECAYS: 6,   // ignore a marker beyond 6×DECAY_WORDS — contributes ~0.25%
    // Jading (habituation): a spike right after a spike lands weaker.
    // JADE_SCALE is "how much recent stimulation halves the next spike"
    // (J equal to it → gain ½); JADE_RECOVERY_WORDS is how fast novelty
    // regrows. Divisive normalization over leaky per-sign pools — the
    // textbook habituation model (Thompson–Spencer; hedonic adaptation).
    JADE_SCALE: 10,
    JADE_RECOVERY_WORDS: 300,
  },

  _pages: [],   // [{el, svg}] — pages that received an overlay
  _armed: false,

  // ---- The kernel (pure math — unit-tested in test-attention-units) ---
  // K(u) = N · (1 − e^(−(u/A)³)) · e^(−u/DECAY) for u ≥ 0, else 0, with N
  // chosen (numerically — no closed form) so the peak is EXACTLY 1: a
  // lone #twist (+15) peaks at 15. The cubic-exponential onset is C² at
  // the marker — zero first AND second derivative — so each impulse
  // ACCELERATES from nothing, decelerates into the peak, then decays:
  // "multiple levels of derivatives smooth". The old double-exponential
  // rose with a kink at u=0. Peak sits ~1.8×A words after the marker.
  _kcache: null, // { A, D, N, uStar } — recomputed when TUNING changes
  kernel(u) {
    if (u < 0) return 0;
    const A = this.TUNING.ATTACK_WORDS;
    const D = this.TUNING.DECAY_WORDS;
    let c = this._kcache;
    if (!c || c.A !== A || c.D !== D) {
      let peak = 0;
      let uP = 0;
      for (let x = 0.05; x < 12 * A + D; x += 0.05) {
        const k = (1 - Math.exp(-((x / A) ** 3))) * Math.exp(-x / D);
        if (k > peak) { peak = k; uP = x; }
      }
      c = this._kcache = { A, D, N: 1 / peak, uStar: uP };
    }
    return c.N * (1 - Math.exp(-((u / A) ** 3))) * Math.exp(-u / D);
  },

  // jade(markers): the habituation pass (see THE FORMULA). Sequential
  // over t-sorted markers; two INDEPENDENT leaky pools (positive/negative
  // — a #digression does not dull the next #picture), each decaying
  // between its own events and charging by the EFFECTIVE amplitude it
  // let through. First spike lands full; an immediate repeat of +10 at
  // JADE_SCALE=10 lands as +5; spacing markers out restores novelty.
  jade(markers) {
    const S = this.TUNING.JADE_SCALE;
    const R = this.TUNING.JADE_RECOVERY_WORDS;
    const pools = { pos: { J: 0, t: null }, neg: { J: 0, t: null } };
    return markers.map((m) => {
      const p = m.v >= 0 ? pools.pos : pools.neg;
      if (p.t !== null) p.J *= Math.exp(-(m.t - p.t) / R);
      const vEff = m.v / (1 + p.J / S);
      p.J += Math.abs(vEff);
      p.t = m.t;
      return { t: m.t, v: vEff };
    });
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

  // pchip(knots): monotone cubic interpolation (Fritsch–Carlson) through
  // [[y, t], …] with strictly increasing y and nondecreasing t. Returns
  // an evaluator y→t that is C¹, hits every knot exactly, and NEVER
  // overshoots — t must not decrease or the envelope would sample time
  // running backwards. This is what smooths the y→t map: the old
  // piecewise map froze t in the leading between lines, printing a flat
  // shelf into the curve at every line gap (the author's 2026-09-09
  // "between every line there's a flat part").
  pchip(knots) {
    const n = knots.length;
    if (n === 1) return () => knots[0][1];
    const h = [];
    const delta = [];
    for (let i = 0; i < n - 1; i++) {
      h.push(knots[i + 1][0] - knots[i][0]);
      delta.push((knots[i + 1][1] - knots[i][1]) / h[i]);
    }
    const d = [delta[0]];
    for (let i = 1; i < n - 1; i++) {
      if (delta[i - 1] * delta[i] <= 0) { d.push(0); continue; }
      const w1 = 2 * h[i] + h[i - 1];
      const w2 = h[i] + 2 * h[i - 1];
      d.push((w1 + w2) / (w1 / delta[i - 1] + w2 / delta[i]));
    }
    d.push(delta[n - 2]);
    return (y) => {
      if (y <= knots[0][0]) return knots[0][1];
      if (y >= knots[n - 1][0]) return knots[n - 1][1];
      let i = 0;
      while (i < n - 2 && y > knots[i + 1][0]) i++;
      const s = y - knots[i][0];
      const c2 = (3 * delta[i] - 2 * d[i] - d[i + 1]) / h[i];
      const c3 = (d[i] + d[i + 1] - 2 * delta[i]) / (h[i] * h[i]);
      return knots[i][1] + d[i] * s + c2 * s * s + c3 * s * s * s;
    };
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
      // An INVISIBLE marker span has zero WIDTH but is still positioned —
      // its inline box carries the font's height, and its top/left are the
      // marker's true spot in the prose. Anchoring to the parent fragment
      // instead put the impulse at the SENTENCE's first line (up to a few
      // lines early — the bug the fast attack exposed, 2026-09-09). Only a
      // fully degenerate rect (hidden subtree) falls back to the parent.
      const anchor = (r.height > 0 || r.width > 0)
        ? r : el.parentElement.getBoundingClientRect();
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
    const { pages, lines, markers: raw } = this._harvest();
    if (!lines.length) return;
    const markers = this.jade(raw); // habituation before superposition
    const F = this.TUNING.FULL_SCALE;
    for (let pi = 0; pi < pages.length; pi++) {
      const pageLines = lines.filter((l) => l.pageIdx === pi);
      if (!pageLines.length) continue;
      const page = pages[pi];
      const W = page.offsetWidth;
      const H = page.offsetHeight;
      const y0 = pageLines[0].top;
      const y1 = pageLines[pageLines.length - 1].bottom;
      // y → t: a MONOTONE CUBIC through the line CENTERS (plus exact
      // page-edge anchors). The leading between lines absorbs into the
      // flow — words smear smoothly across gaps instead of freezing, so
      // no flat shelves print between lines. (Strict "gaps cost nothing"
      // lost a little literalness to smoothness here, deliberately —
      // 2026-09-09 evening.)
      const lastLn = pageLines[pageLines.length - 1];
      const knots = [[y0, pageLines[0].tStart]];
      for (const l of pageLines) {
        const y = (l.top + l.bottom) / 2;
        if (y > knots[knots.length - 1][0] + 0.5) {
          knots.push([y, l.tStart + l.words / 2]);
        }
      }
      if (y1 > knots[knots.length - 1][0] + 0.5) {
        knots.push([y1, lastLn.tStart + lastLn.words]);
      }
      const tOf = this.pchip(knots);
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
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'attention-overlay');
      // Canvas spans one sheet-width beyond BOTH edges (negative min-x
      // viewBox) so deep dips and >FULL_SCALE spikes stay visible.
      svg.setAttribute('viewBox', `${-W} 0 ${3 * W} ${H}`);
      svg.setAttribute('preserveAspectRatio', 'none');
      svg.style.cssText = `position:absolute;top:0;left:${-W}px;width:${3 * W}px;height:${H}px;`
        + 'z-index:-1;pointer-events:none;';
      svg.innerHTML = `<path d="${area((a) => Math.max(a, 0))}" fill="rgba(27,94,32,0.32)"/>`
        + `<path d="${area((a) => Math.min(a, 0))}" fill="rgba(146,38,36,0.30)"/>`;
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
