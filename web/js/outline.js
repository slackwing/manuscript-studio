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
    for (const s of sentences) {
      const eff = (sug[s.id] !== undefined) ? sug[s.id] : s.text;
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
        } else if (c.kind === 'anchor') {
          const a = { description: label, slug: c.slug, sentence_id: s.id };
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

    this.el.innerHTML = `<nav class="outline-nav">${items.join('')}</nav>`;
    this.el.classList.add('has-outline');

    this.el.querySelectorAll('[data-sentence-id]').forEach(node => {
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
    return `<a class="outline-item ${cls}" data-sentence-id="${escapeHTML(sentenceId)}">${escapeHTML(text)}</a>`;
  },
};

if (typeof window !== 'undefined') {
  window.WriteSysOutline = WriteSysOutline;
}
