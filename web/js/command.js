/**
 * &-command parsing (frontend mirror of internal/sentence/command.go).
 *
 * segman decides boundaries; this parses a stored sentence into its command
 * fields for rendering. A '&' begins a command only when immediately followed
 * by an exact keyword and then '#' or '{' — so "Smith & Sons", "R&D", and
 * "A &chapter of accidents" are literal prose, not commands.
 *
 * Grammar (see TEX_COMMANDS_PLAN.md and PLACEHOLDER_PLAN.md):
 *   &title{text}
 *   &part#slug{text}{label?}
 *   &chapter#slug{text}{label?}
 *   &anchor#slug{label?}{details?}                    // details reserved, unrendered
 *   &reference#slug{notes?}                           // inline only
 *   &placeholder#slug{unit}{size?}{label?}{details?}  // see placeholderSpec
 *   &end#slug                                         // region terminator (SCRATCHPAD_PLAN.md)
 *
 * Argument vocabulary: {text} renders in the book, {label} shows in the
 * outline, {details} is auxiliary metadata (a placeholder's details overlay;
 * an anchor's details are parsed but unrendered for now).
 */

const WriteSysCommand = {
  // 'snippet' is the legacy spelling of 'sketch' (the snippet→sketch
  // rename) — parsed as the SAME command and valid input forever; parse()
  // normalizes the kind to 'sketch' so every consumer stays single-kind.
  KEYWORDS: ['title', 'part', 'chapter', 'anchor', 'reference', 'meta', 'placeholder', 'sketch', 'snippet', 'end'],
  // Block commands stand alone as their own sentence when on their own line.
  // &meta is block but renders as nothing (it carries a setting). anchor,
  // placeholder, and end are block only when sole line content (segman).
  BLOCK: { title: true, part: true, chapter: true, anchor: true, meta: true, placeholder: true, sketch: true, snippet: true, end: true },

  // Placeholder t-shirt sizes. Sentences double-ish; paragraphs are
  // Fibonacci. The asymmetry is deliberate (PLACEHOLDER_PLAN.md).
  PLACEHOLDER_SENTENCES: { xs: 1, s: 2, m: 3, l: 5, xl: 10, xxl: 20, xxxl: 40 },
  PLACEHOLDER_PARAGRAPHS: { xs: 1, s: 2, m: 3, l: 5, xl: 8, xxl: 13, xxxl: 21 },

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
    if (kind === 'snippet') kind = 'sketch'; // legacy spelling — one internal kind

    let slug = '';
    if (i < chars.length && chars[i] === '#') {
      i++;
      const start = i;
      if (kind === 'end') {
        // 'end' may be a bare #slug token with no {...} groups, so its slug
        // self-terminates on the slug charset [a-z0-9-].
        while (i < chars.length && /[a-z0-9-]/.test(chars[i])) i++;
      } else {
        while (i < chars.length && chars[i] !== '{') i++;
      }
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
    if (args.length === 0 && !(kind === 'end' && slug)) return null;

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

  // placeholderSpec interprets a &placeholder arg list {unit}{size?}{label?}
  // {details?}. The size arg is positional but detected by value: an arg that
  // exactly matches a size keyword is the size, anything else is the label (a
  // label that IS literally a size keyword can force the default by writing
  // the size explicitly). valid=false means mis-syntax → render as literal
  // prose. Mirrors Go ParsePlaceholder — keep in lockstep.
  placeholderSpec(args) {
    const spec = { unit: '', size: 'm', count: 0, label: '', details: '', valid: false };
    if (!args || args.length === 0 || args.length > 4) return spec;
    spec.unit = String(args[0]).trim();
    const counts = spec.unit === 'sentences' ? this.PLACEHOLDER_SENTENCES
      : (spec.unit === 'paragraphs' ? this.PLACEHOLDER_PARAGRAPHS : null);
    if (!counts) return spec;
    let rest = args.slice(1);
    if (rest.length > 0 && Object.prototype.hasOwnProperty.call(counts, String(rest[0]).trim())) {
      spec.size = String(rest[0]).trim();
      rest = rest.slice(1);
    }
    if (rest.length > 0) { spec.label = rest[0]; rest = rest.slice(1); }
    if (rest.length > 0) { spec.details = rest[0]; rest = rest.slice(1); }
    if (rest.length > 0) return { unit: '', size: 'm', count: 0, label: '', details: '', valid: false };
    spec.count = counts[spec.size];
    spec.valid = true;
    return spec;
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
        marker = '';
        continue;
      }
      // Leading-command block form (canonicalize output): "&anchor{...}\nprose"
      // or "&sketch#x{...}\nprose" (sketch spelling included — parse()
      // normalizes it to kind 'sketch'). canonicalize joins a leading block
      // anchor/sketch to its paragraph with a single \n (canonicalize.js:45–47
      // / canonicalize.go — the same kinds, kept in lockstep), and segman
      // splits it into its own sentence. Mirror that split here so the render
      // preview matches the pushed/segmented result: emit the command as a
      // fragment, then the trailing prose as its paragraph.
      //
      // The block's leading marker (\n\n / \n\t) belongs to the PARAGRAPH, so it
      // rides on the PROSE fragment — that's what drives indent/section behavior
      // (e.g. a paragraph after a placeholder keeps its \n\t indent). The anchor
      // glyph is just a left-margin decoration on that paragraph and carries no
      // marker of its own.
      if (cmd && (cmd.kind === 'anchor' || cmd.kind === 'sketch')) {
        const after = trimmed.slice(cmd.raw.length);
        if (after.startsWith('\n')) {
          const prose = after.slice(1);
          frags.push({ kind: 'command', cmd, marker: '' });
          if (prose.trim() !== '') frags.push({ kind: 'prose', text: prose, marker });
          marker = '';
          continue;
        }
      }
      // Markdown # headers are deprecated and no longer rendered specially —
      // a '#' line is ordinary prose (convert to an &-command for a heading).
      // A block whose text BEGINS with a tab is explicitly an indented
      // paragraph, whatever delimiter preceded it — "\n\n\t" is a blank line
      // for raw-text readability (typically around a command line) plus a
      // tabbed paragraph, not a section break.
      frags.push({ kind: 'prose', text: piece, marker: piece.startsWith('\t') ? '\n\t' : marker });
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

  // findInline scans a string for inline &reference / &anchor / &placeholder
  // commands (those not spanning the whole string) and returns [{kind, slug,
  // notes, args, raw, start, end}] in order. Used to render references as
  // links, anchors as markers, and placeholders as hatch regions within a
  // sentence's visible text.
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
      if (cmd.kind === 'reference' || cmd.kind === 'anchor' || cmd.kind === 'placeholder' || cmd.kind === 'sketch' || cmd.kind === 'end') {
        out.push({ kind: cmd.kind, slug: cmd.slug, notes: cmd.args[0] || '', args: cmd.args, raw: cmd.raw, start: i, end });
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
        // A block anchor renders as a glyph (⚓), NOT its label text. The label
        // is outline metadata and shows on hover (title) + in the outline nav.
        return { tag: 'div', cls: 'cmd-anchor', visible: '', description: '', glyph: true, label: cmd.args[0] || '' };
      case 'sketch':
        // A canon-region opener (VARIATIONS_PLAN.md) renders exactly like a
        // block anchor — the extra class is a styling/selection hook.
        return { tag: 'div', cls: 'cmd-anchor cmd-sketch', visible: '', description: '', glyph: true, label: cmd.args[0] || '' };
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
