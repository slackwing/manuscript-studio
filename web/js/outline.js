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

  init() {
    this.el = document.getElementById('outline-margin');
  },

  // Load and render the outline for a migration. Safe to call on every
  // manuscript (re)render; hides itself when there's nothing structural.
  async loadForMigration(migrationID) {
    if (!this.el || !migrationID) return;
    let outline;
    try {
      outline = await fetchJSON(`${this.apiBaseUrl}/migrations/${migrationID}/outline`, {}, true);
    } catch (err) {
      console.warn('outline endpoint failed (ignored):', err.message || err);
      this.el.innerHTML = '';
      this.el.classList.remove('has-outline');
      return;
    }
    this.render(outline);
  },

  render(outline) {
    if (!this.el) return;
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
