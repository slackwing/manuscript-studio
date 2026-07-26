/**
 * Left-margin document outline (TEX_COMMANDS_PLAN.md §5).
 *
 * Fetches GET /api/migrations/{id}/outline and renders a Part -> Chapter ->
 * Anchor nav in the left margin. Clicking an item scrolls to its sentence.
 * Non-fatal: an empty or failed outline just hides the panel.
 */
const WriteSysOutline = {
  apiBaseUrl: 'api',
  el: null,
  // slug -> sentence_id, for resolving inline &reference targets.
  slugMap: {},

  init() {
    this.el = document.getElementById('outline-margin');
  },

  // Load the outline for a migration. Kept for the initial load path, but the
  // outline is now built CLIENT-SIDE from the effective (suggested-or-
  // committed) sentence fragments so suggested structure previews in the nav.
  // The server endpoint remains available for committed-only consumers.
  async loadForMigration(migrationID) {
    this.refresh();
  },

  // refresh rebuilds the outline from the renderer's current sentences with
  // suggestions overlaid — reusing the same fragment segmentation the renderer
  // uses, so the nav matches what's on the page. Call on load and re-render.
  refresh() {
    if (!this.el) return;
    const r = window.WriteSysRenderer;
    const cmd = window.WriteSysCommand;
    if (!r || !r.currentSentences || !cmd) {
      this.render({ parts: [], top_chapters: [], top_anchors: [] });
      return;
    }
    const sug = (window.WriteSysSuggestions && window.WriteSysSuggestions.bySentenceId) || {};
    this.render(this.buildOutline(r.currentSentences, sug, cmd));
  },

  // buildOutline mirrors the Go BuildOutline, but over EFFECTIVE fragments:
  // for each sentence use its suggestion if present, segment into fragments,
  // and place title/part/chapter/anchor blocks into the tree. All fragments of
  // a sentence share its id (used as the scroll target).
  buildOutline(sentences, sug, cmd) {
    const o = { title: null, parts: [], top_chapters: [], top_anchors: [] };
    let curPart = -1, curChapter = -1;
    const canon = (window.WriteSysCanonicalize && window.WriteSysCanonicalize.canonicalize)
      ? window.WriteSysCanonicalize.canonicalize
      : (t) => t;
    for (const s of sentences) {
      const rawEff = (sug[s.id] !== undefined) ? sug[s.id] : s.text;
      const eff = canon(rawEff);
      for (const f of cmd.segmentFragments(eff)) {
        if (f.kind !== 'command') continue;
        const c = f.cmd;
        const label = c.args[0] || '';
        const desc = c.args[1] || '';
        if (c.kind === 'title') {
          o.title = { name: label, slug: c.slug, sentence_id: s.id };
        } else if (c.kind === 'part') {
          o.parts.push({ label, description: desc, slug: c.slug, sentence_id: s.id, chapters: [], anchors: [] });
          curPart = o.parts.length - 1; curChapter = -1;
        } else if (c.kind === 'chapter') {
          const ch = { label, description: desc, slug: c.slug, sentence_id: s.id, anchors: [] };
          if (curPart >= 0) { o.parts[curPart].chapters.push(ch); curChapter = o.parts[curPart].chapters.length - 1; }
          else { o.top_chapters.push(ch); curChapter = o.top_chapters.length - 1; }
        } else if (c.kind === 'anchor' || c.kind === 'placeholder') {
          // A placeholder lists exactly like an anchor — indistinguishable in
          // the outline — using its {label}; mis-syntaxed placeholders render
          // as prose and stay out of the outline (mirrors Go BuildOutline).
          let description = label;
          if (c.kind === 'placeholder') {
            const spec = cmd.placeholderSpec(c.args);
            // Unlabeled placeholders are pure spacing — not outline-worthy.
            if (!spec.valid || !spec.label.trim()) continue;
            description = spec.label;
          }
          const a = { description, slug: c.slug, sentence_id: s.id };
          if (curPart >= 0 && curChapter >= 0) o.parts[curPart].chapters[curChapter].anchors.push(a);
          else if (curPart >= 0) o.parts[curPart].anchors.push(a);
          else if (curChapter >= 0) o.top_chapters[curChapter].anchors.push(a);
          else o.top_anchors.push(a);
        }
      }
    }
    return o;
  },

  render(outline) {
    if (!this.el) return;
    // Rebuild the slug -> sentence_id map from the outline so inline
    // references can resolve their targets.
    this.slugMap = {};
    const note = (n) => { if (n && n.slug) this.slugMap[n.slug] = n.sentence_id; };
    if (outline.title) note(outline.title);
    (outline.top_chapters || []).forEach(c => { note(c); (c.anchors || []).forEach(note); });
    (outline.top_anchors || []).forEach(note);
    (outline.parts || []).forEach(part => {
      note(part);
      (part.chapters || []).forEach(c => { note(c); (c.anchors || []).forEach(note); });
      (part.anchors || []).forEach(note);
    });

    const items = [];

    if (outline.title && outline.title.name) {
      items.push(this.item('outline-title', outline.title.name, outline.title.sentence_id));
    }
    (outline.top_chapters || []).forEach(c => this.pushChapter(items, c));
    (outline.top_anchors || []).forEach(a => this.pushAnchor(items, a));
    (outline.parts || []).forEach(part => {
      const label = [part.label, part.description].filter(Boolean).join(' — ');
      items.push(this.item('outline-part', label || '(part)', part.sentence_id));
      (part.chapters || []).forEach(c => this.pushChapter(items, c));
      (part.anchors || []).forEach(a => this.pushAnchor(items, a));
    });

    if (items.length === 0) {
      this.el.innerHTML = '';
      this.el.classList.remove('has-outline');
      return;
    }

    // One caret element that glides to the active row (positioned absolutely
    // within the nav; moved via translateY with a CSS transition).
    this.el.innerHTML = `<nav class="outline-nav">` +
      `<span class="outline-caret" aria-hidden="true">◂</span>` +
      items.join('') + `</nav>`;
    this.el.classList.add('has-outline');
    this.caretEl = this.el.querySelector('.outline-caret');

    this.itemNodes = Array.from(this.el.querySelectorAll('.outline-item'));
    this.itemNodes.forEach(node => {
      node.addEventListener('click', () => {
        const id = node.dataset.sentenceId;
        if (window.WriteSysRenderer && window.WriteSysRenderer.scrollToSentence) {
          window.WriteSysRenderer.scrollToSentence(id);
        } else {
          const target = document.querySelector(`.sentence[data-sentence-id="${id}"]`);
          if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      });
    });

    // Page numbers / counts are DOM-position-derived, so compute them after
    // paged.js has laid the pages out. A short delay lets pagination settle;
    // also re-run on window resize (re-pagination changes page numbers).
    this.schedulePageInfo();
    this.attachScrollTracking();
  },

  // pageOfSentence returns the 1-based page number of a sentence id (its
  // .pagedjs_page's DOM index + 1), or 0 if not found/paginated yet.
  pageOfSentence(id) {
    const el = document.querySelector(`.sentence[data-sentence-id="${id}"]`);
    if (!el) return 0;
    const page = el.closest('.pagedjs_page');
    if (!page) return 0;
    const pages = Array.from(document.querySelectorAll('.pagedjs_page'));
    const idx = pages.indexOf(page);
    return idx < 0 ? 0 : idx + 1;
  },

  schedulePageInfo() {
    clearTimeout(this._pageInfoTimer);
    this._pageInfoTimer = setTimeout(() => this.updatePageInfo(), 250);
  },

  // updatePageInfo fills each item's right column with its start page and the
  // number of pages that section spans (start of the next item minus this
  // one). The last item spans through the final page.
  updatePageInfo() {
    if (!this.itemNodes || this.itemNodes.length === 0) return;
    const totalPages = document.querySelectorAll('.pagedjs_page').length;
    if (totalPages === 0) return;
    const starts = this.itemNodes.map(n => this.pageOfSentence(n.dataset.sentenceId) || 0);
    for (let i = 0; i < this.itemNodes.length; i++) {
      const start = starts[i];
      // The next SECTION row (title/part/chapter) with a known start page
      // determines where this section ends. Anchor rows (and placeholders,
      // which list as anchors) are skipped: they live INSIDE a chapter, so a
      // chapter's page count runs past them to the next real section.
      let nextStart = totalPages + 1;
      for (let j = i + 1; j < starts.length; j++) {
        if (this.itemNodes[j].classList.contains('outline-anchor')) continue;
        if (starts[j] > 0) { nextStart = starts[j]; break; }
      }
      const span = Math.max(1, nextStart - start);
      const info = this.itemNodes[i].querySelector('.outline-pageinfo');
      // Page number / count are shown for CHAPTERS only — title and part are
      // dividers, not page-addressable content sections.
      const isChapter = this.itemNodes[i].classList.contains('outline-chapter');
      if (info && isChapter) {
        // Two columns: page number (dark) then page count (light). Always
        // show the count column — even "1pp" — so the two columns stay
        // aligned across rows (omitting it would let the page number slide
        // into the count column's space).
        const pageCol = start ? `<span class="outline-page">${start}</span>` : '';
        const countCol = start ? `<span class="outline-count">${span}pp</span>` : '';
        info.innerHTML = pageCol + countCol;
        info.title = start ? `starts on page ${start}, spans ${span} page${span > 1 ? 's' : ''}` : '';
      } else if (info) {
        info.innerHTML = '';
        info.title = '';
      }
    }
    this.itemStarts = starts;
    this.updateCaret();
  },

  // attachScrollTracking wires scroll/resize listeners (once) that move the
  // reading-position caret to the section at the viewport center. Listens on
  // window AND document (capture) so it catches scrolling regardless of which
  // element the scroll originates on.
  attachScrollTracking() {
    if (this._scrollBound) return;
    this._scrollBound = true;
    const onScroll = () => {
      if (this._rafPending) return;
      this._rafPending = true;
      requestAnimationFrame(() => { this._rafPending = false; this.updateCaret(); });
    };
    window.addEventListener('scroll', onScroll, { passive: true, capture: true });
    document.addEventListener('scroll', onScroll, { passive: true, capture: true });
    window.addEventListener('resize', () => { this.schedulePageInfo(); }, { passive: true });
    // Run once now (in case content is already scrolled or short).
    this.updateCaret();
  },

  // updateCaret glides the single caret element to the row whose section
  // contains the page at the viewport center. The caret moves via translateY
  // (with a CSS transition) so it physically slides between rows rather than
  // fading out and in.
  updateCaret() {
    if (!this.itemNodes || this.itemNodes.length === 0 || !this.caretEl) return;
    const pages = Array.from(document.querySelectorAll('.pagedjs_page'));
    if (pages.length === 0) return;
    // Which page is at the vertical center of the viewport?
    const centerY = window.innerHeight / 2;
    let centerPageIdx = 0;
    for (let i = 0; i < pages.length; i++) {
      const r = pages[i].getBoundingClientRect();
      if (r.top <= centerY && r.bottom >= centerY) { centerPageIdx = i; break; }
      if (r.top > centerY) { centerPageIdx = Math.max(0, i - 1); break; }
      centerPageIdx = i;
    }
    const centerPage = centerPageIdx + 1;
    // The active row is the last item whose start page <= centerPage.
    const starts = this.itemStarts || [];
    let activeIdx = -1;
    for (let i = 0; i < starts.length; i++) {
      if (starts[i] > 0 && starts[i] <= centerPage) activeIdx = i;
    }
    this.itemNodes.forEach((n, i) => n.classList.toggle('active', i === activeIdx));

    if (activeIdx < 0) { this.caretEl.style.opacity = '0'; return; }
    // Glide the caret to vertically center on the active row (both measured
    // relative to the nav so translateY is nav-local).
    const navTop = this.el.querySelector('.outline-nav').getBoundingClientRect().top;
    const rowRect = this.itemNodes[activeIdx].getBoundingClientRect();
    const y = (rowRect.top + rowRect.height / 2) - navTop;
    this.caretEl.style.opacity = '1';
    this.caretEl.style.transform = `translateY(${y}px)`;
  },

  pushChapter(items, c) {
    const label = [c.label, c.description].filter(Boolean).join(' — ');
    items.push(this.item('outline-chapter', label || '(chapter)', c.sentence_id));
    (c.anchors || []).forEach(a => this.pushAnchor(items, a));
  },

  pushAnchor(items, a) {
    const label = a.description || (a.slug ? '#' + a.slug : '(anchor)');
    items.push(this.item('outline-anchor', label, a.sentence_id));
  },

  item(cls, text, sentenceId) {
    // Columns: text | page# | page-count. The reading-position caret is a
    // single element in the nav (not per-item) that glides to the active row.
    return `<a class="outline-item ${cls}" data-sentence-id="${escapeHTML(sentenceId)}">` +
      `<span class="outline-text">${escapeHTML(text)}</span>` +
      `<span class="outline-pageinfo"></span>` +
      `</a>`;
  },
};

if (typeof window !== 'undefined') {
  window.WriteSysOutline = WriteSysOutline;
}
