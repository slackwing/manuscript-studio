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
};

if (typeof window !== 'undefined') {
  window.WriteSysCommand = WriteSysCommand;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = WriteSysCommand;
}
