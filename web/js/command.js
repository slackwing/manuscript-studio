/**
 * &-command parsing (frontend mirror of internal/sentence/command.go).
 *
 * segman decides boundaries; this parses a stored sentence into its command
 * fields for rendering. A '&' begins a command only when immediately followed
 * by an exact keyword and then '#' or '{' — so "Smith & Sons", "R&D", and
 * "A &chapter of accidents" are literal prose, not commands.
 *
 * Grammar (see TEX_COMMANDS_PLAN.md):
 *   &title{name}
 *   &part#slug{label}{desc?}
 *   &chapter#slug{label}{desc?}
 *   &anchor#slug{desc?}          // no label
 *   &reference#slug{notes?}       // inline only
 */

const WriteSysCommand = {
  KEYWORDS: ['title', 'part', 'chapter', 'anchor', 'reference'],
  // Block commands stand alone as their own sentence when on their own line.
  BLOCK: { title: true, part: true, chapter: true, anchor: true },

  SLUG_RE: /^[a-z0-9-]+$/,

  // parse a command token at the START of s. Returns
  // { kind, slug, args, raw } or null if s does not begin with a command.
  parse(s) {
    const chars = Array.from(s);
    if (chars.length === 0 || chars[0] !== '&') return null;

    let kind = null;
    let i = 0;
    for (const kw of this.KEYWORDS) {
      const end = 1 + kw.length;
      if (end >= chars.length) continue;
      if (chars.slice(1, end).join('') !== kw) continue;
      if (chars[end] === '#' || chars[end] === '{') { kind = kw; i = end; break; }
    }
    if (kind === null) return null;

    let slug = '';
    if (i < chars.length && chars[i] === '#') {
      i++;
      const start = i;
      while (i < chars.length && chars[i] !== '{') i++;
      slug = chars.slice(start, i).join('');
    }

    const args = [];
    while (i < chars.length && chars[i] === '{') {
      let depth = 0;
      const start = i + 1;
      let closed = false;
      while (i < chars.length) {
        if (chars[i] === '{') depth++;
        else if (chars[i] === '}') {
          depth--;
          if (depth === 0) { args.push(chars.slice(start, i).join('')); i++; closed = true; break; }
        }
        i++;
      }
      if (!closed) return null; // unterminated group
    }
    if (args.length === 0) return null;

    return { kind, slug, args, raw: chars.slice(0, i).join('') };
  },

  // isBlockCommandText: the whole sentence is one block command (nothing
  // trailing). Mirrors IsBlockCommandText in Go.
  isBlockCommandText(text) {
    const t = text.trim();
    const cmd = this.parse(t);
    return !!cmd && !!this.BLOCK[cmd.kind] && cmd.raw === t;
  },

  validSlug(slug) {
    return this.SLUG_RE.test(slug);
  },

  // structuralForm describes how a stored sentence renders as a heading-like
  // element, or null if it's ordinary content. Unifies Markdown headers and
  // block &-commands so the renderer and the suggestion-preview path agree on
  // one shape: { tag, cls, visible }.
  //   # H / ## H / ### H        -> { h1|h2|h3.., 'md-header', 'H' }
  // The on-page heading shows ONLY the label — the description is metadata
  // for the outline (see TEX_COMMANDS_PLAN.md §5), never concatenated into the
  // heading. `visible` is what renders on the page; `description` is carried
  // for later use (outline) but not shown here.
  //   &title{name}              -> { h1, 'cmd-title',   name }
  //   &part#s{label}{desc?}     -> { h2, 'cmd-part',    label }
  //   &chapter#s{label}{desc?}  -> { h3, 'cmd-chapter', label }
  //   &anchor#s{desc?}          -> { div,'cmd-anchor',  desc }   (no label)
  structuralForm(text) {
    const t = String(text);
    const hm = t.match(/^(#+)\s+(.*)$/);
    if (hm) {
      const level = Math.min(hm[1].length, 6);
      return { tag: 'h' + level, cls: 'md-header', visible: hm[2], description: '' };
    }
    const cmd = this.parse(t.trim());
    if (!cmd || !this.BLOCK[cmd.kind] || cmd.raw !== t.trim()) return null;
    switch (cmd.kind) {
      case 'title':
        return { tag: 'h1', cls: 'cmd-title', visible: cmd.args[0] || '', description: '' };
      case 'part':
        return { tag: 'h2', cls: 'cmd-part', visible: cmd.args[0] || '', description: cmd.args[1] || '' };
      case 'chapter':
        return { tag: 'h3', cls: 'cmd-chapter', visible: cmd.args[0] || '', description: cmd.args[1] || '' };
      case 'anchor':
        return { tag: 'div', cls: 'cmd-anchor', visible: cmd.args[0] || '', description: '' };
      default:
        return null;
    }
  },
};

if (typeof window !== 'undefined') {
  window.WriteSysCommand = WriteSysCommand;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = WriteSysCommand;
}
