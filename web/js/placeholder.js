/**
 * &placeholder rendering (PLACEHOLDER_PLAN.md v2, 2026-11-25).
 *
 * A placeholder reserves believable space for unwritten prose, sized by a
 * guess about how long it will be (the xs–xxxl tables in command.js). It
 * renders as LOREM IPSUM in a grey face — visibly filler, never mistaken for
 * the book — and it is ONE sentence: the whole run (every filler paragraph
 * of a block form) carries the command's sentence id, so a sticky note, a
 * hover, a click address the placeholder, not a lorem sentence inside it.
 *
 * The excerpt is derived from the size: the canonical passage, in order —
 * a sentences-unit placeholder takes its first N sentences, a paragraphs-
 * unit placeholder its first N paragraphs — wrapping around when the size
 * outruns the passage. No seeding, no hatch, no layout pass: this is plain
 * text that paginates like prose.
 */
const WriteSysPlaceholder = {
  // The canonical passage (the lipsum.com paragraphs), as sentences.
  LOREM: [
    [
      'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
      'Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.',
      'Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.',
      'Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.',
    ],
    [
      'Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium, totam rem aperiam, eaque ipsa quae ab illo inventore veritatis et quasi architecto beatae vitae dicta sunt explicabo.',
      'Nemo enim ipsam voluptatem quia voluptas sit aspernatur aut odit aut fugit, sed quia consequuntur magni dolores eos qui ratione voluptatem sequi nesciunt.',
      'Neque porro quisquam est, qui dolorem ipsum quia dolor sit amet, consectetur, adipisci velit, sed quia non numquam eius modi tempora incidunt ut labore et dolore magnam aliquam quaerat voluptatem.',
      'Ut enim ad minima veniam, quis nostrum exercitationem ullam corporis suscipit laboriosam, nisi ut aliquid ex ea commodi consequatur?',
      'Quis autem vel eum iure reprehenderit qui in ea voluptate velit esse quam nihil molestiae consequatur, vel illum qui dolorem eum fugiat quo voluptas nulla pariatur?',
    ],
    [
      'At vero eos et accusamus et iusto odio dignissimos ducimus qui blanditiis praesentium voluptatum deleniti atque corrupti quos dolores et quas molestias excepturi sint occaecati cupiditate non provident, similique sunt in culpa qui officia deserunt mollitia animi, id est laborum et dolorum fuga.',
      'Et harum quidem rerum facilis est et expedita distinctio.',
      'Nam libero tempore, cum soluta nobis est eligendi optio cumque nihil impedit quo minus id quod maxime placeat facere possimus, omnis voluptas assumenda est, omnis dolor repellendus.',
      'Temporibus autem quibusdam et aut officiis debitis aut rerum necessitatibus saepe eveniet ut et voluptates repudiandae sint et molestiae non recusandae.',
      'Itaque earum rerum hic tenetur a sapiente delectus, ut aut reiciendis voluptatibus maiores alias consequatur aut perferendis doloribus asperiores repellat.',
    ],
  ],

  esc(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  },

  // The first `count` sentences of the passage, in order, wrapping around.
  excerptSentences(count) {
    const flat = this.LOREM.flat();
    const out = [];
    for (let i = 0; i < count; i++) out.push(flat[i % flat.length]);
    return out.join(' ');
  },

  // The first `count` paragraphs of the passage, in order, wrapping around.
  excerptParagraphs(count) {
    const out = [];
    for (let i = 0; i < count; i++) out.push(this.LOREM[i % this.LOREM.length].join(' '));
    return out;
  },

  // Inline (sentences-unit) placeholder: a grey .ph run inside its host
  // sentence. Also used when a sentences-unit placeholder is the sole content
  // of its own line (it becomes a one-run paragraph). Unselectable and
  // aria-hidden: filler must never leak into copy, search, or a screen reader.
  inlineHTML(spec, slug) {
    const slugAttr = slug ? ` data-slug="${this.esc(slug)}"` : '';
    return `<span class="ph"${slugAttr} aria-hidden="true">${this.esc(this.excerptSentences(spec.count))}</span>`;
  },

  // Block (paragraphs-unit) placeholder: N grey paragraphs in a wrapper.
  // Every span carries the sentence id so the whole region is one sentence.
  blockHTML(spec, slug, id, changed, escapeHtml, markerCls) {
    const paras = this.excerptParagraphs(spec.count);
    const slugAttr = slug ? ` data-slug="${this.esc(slug)}"` : '';
    const chCls = changed ? ' cmd-suggested' : '';
    const body = paras.map((p, i) => {
      // First filler paragraph inherits the placeholder's own structural
      // marker (\n\t indent / \n\n section); the rest indent as usual.
      const cls = i === 0 ? (markerCls ? ` class="${markerCls}"` : '') : ' class="indented"';
      return `<p${cls}><span class="sentence ph" data-sentence-id="${escapeHtml(id)}" aria-hidden="true">${this.esc(p)}</span></p>`;
    }).join('');
    return `<div class="cmd-placeholder${chCls}"${slugAttr}>${body}</div>`;
  },
};

if (typeof window !== 'undefined') {
  window.WriteSysPlaceholder = WriteSysPlaceholder;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = WriteSysPlaceholder;
}
