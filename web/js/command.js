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
  KEYWORDS: ['title', 'part', 'chapter', 'anchor', 'reference', 'meta'],
  // Block commands stand alone as their own sentence when on their own line.
  // &meta is block but renders as nothing (it carries a setting).
  BLOCK: { title: true, part: true, chapter: true, anchor: true, meta: true },

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

  // segmentFragments splits a sentence's effective text into an ordered list
  // of render fragments (SUGGESTION_RENDER_PLAN.md). Each fragment is one of:
  //   { kind:'command', cmd }              a block command (title/part/chapter/
  //                                        anchor/meta) on its own line
  //   { kind:'prose', text, marker }       a prose run; marker is '' | '\n\n'
  //                                        | '\n\t' (its leading structural
  //                                        break, for the paragraph grouping)
  // Blocks are separated by \n\n or \n\t. A block whose whole content is a
  // block command becomes a command fragment; everything else is prose.
  segmentFragments(text) {
    const frags = [];
    const s = String(text == null ? '' : text);
    // Split keeping the delimiters so we know each block's leading marker.
    // Tokens alternate: [block, delim, block, delim, ...].
    const parts = s.split(/(\n\n|\n\t)/);
    let marker = '';
    for (let i = 0; i < parts.length; i++) {
      const piece = parts[i];
      if (piece === '\n\n' || piece === '\n\t') { marker = piece; continue; }
      if (piece === '') continue; // empty block (e.g. leading delimiter)
      const trimmed = piece.trim();
      const cmd = this.parse(trimmed);
      if (cmd && this.BLOCK[cmd.kind] && cmd.raw === trimmed) {
        frags.push({ kind: 'command', cmd, marker });
      } else {
        // Markdown # headers are deprecated and no longer rendered specially —
        // a '#' line is ordinary prose (convert to an &-command for a heading).
        frags.push({ kind: 'prose', text: piece, marker });
      }
      marker = '';
    }
    return frags;
  },

  // metaProperties: the fixed &meta vocabulary (mirror of Go's
  // metaProperties). A property mapped to an array of allowed values is
  // validated against it; a property mapped to null accepts any non-empty
  // value (e.g. a font name).
  META_PROPERTIES: {
    'chapter-align': ['left', 'center'],
    'part-align': ['left', 'center'],
    'title-align': ['left', 'center'],
    'divider-folios': ['on', 'off'],
    'font': null,
  },

  // extractSettings walks (id -> effectiveText) sentences, reads &meta
  // commands, and returns the validated {property: value} map. Last-wins for
  // a repeated property; unknown properties and out-of-range values dropped.
  // "Effective text" means the suggestion if one exists, else committed — so
  // a suggested &meta applies live and a suggested removal drops it.
  //
  // A sentence's effective text may be multi-block (a suggestion like
  // "&meta{...}\n\n&title{...}"), so we scan each \n\n / \n\t-separated block
  // for a whole-block &meta, not just whole-sentence meta.
  extractSettings(ids, effectiveTextById) {
    const values = {};
    const consume = (blockText) => {
      const t = String(blockText).trim();
      if (!t.startsWith('&meta')) return;
      const cmd = this.parse(t);
      if (!cmd || cmd.kind !== 'meta' || cmd.raw !== t) return;
      if (cmd.args.length < 2) return;
      const prop = (cmd.args[0] || '').trim();
      const val = (cmd.args[1] || '').trim();
      if (!(prop in this.META_PROPERTIES)) return;
      const allowed = this.META_PROPERTIES[prop];
      if (allowed && !allowed.includes(val)) return;
      if (!val) return;
      values[prop] = val; // last-wins
    };
    for (const id of ids) {
      const text = effectiveTextById[id];
      if (text == null) continue;
      // Split into blocks on \n\n or \n\t (the structural boundaries).
      String(text).split(/\n\n|\n\t/).forEach(consume);
    }
    return values;
  },

  // findInline scans a string for inline &reference / &anchor commands (those
  // not spanning the whole string) and returns [{kind, slug, notes, start,
  // end}] in order. Used to render references as links and anchors as markers
  // within a sentence's visible text.
  findInline(text) {
    const chars = Array.from(text);
    const out = [];
    // If the whole (trimmed) text is one block command, nothing is inline.
    if (this.isBlockCommandText(text)) return out;
    let i = 0;
    while (i < chars.length) {
      if (chars[i] !== '&') { i++; continue; }
      const cmd = this.parse(chars.slice(i).join(''));
      if (!cmd) { i++; continue; }
      const end = i + Array.from(cmd.raw).length;
      if (cmd.kind === 'reference' || cmd.kind === 'anchor') {
        out.push({ kind: cmd.kind, slug: cmd.slug, notes: cmd.args[0] || '', start: i, end });
      }
      i = end;
    }
    return out;
  },

  // structuralForm describes how a block &-command renders as a heading-like
  // element, or null if it's ordinary content. Shape: { tag, cls, visible,
  // description }. The on-page heading shows ONLY the label — the description
  // is outline metadata (never rendered in the book).
  //   &title{name}              -> { h1, 'cmd-title',   name }
  //   &part#s{label}{desc?}     -> { h2, 'cmd-part',    label }
  //   &chapter#s{label}{desc?}  -> { h3, 'cmd-chapter', label }
  //   &anchor#s{desc?}          -> { div,'cmd-anchor',  desc }   (no label)
  // (Markdown # headers are deprecated — a '#' sentence is ordinary content.)
  structuralForm(text) {
    const t = String(text);
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
