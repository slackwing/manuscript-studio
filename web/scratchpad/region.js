/**
 * Region resolution (SCRATCHPAD_PLAN.md §3/§6): find the effective-manuscript
 * region between the block `&anchor#slug` line and the first subsequent block
 * `&end#slug` with the SAME slug, working at FRAGMENT level — a pending
 * canonize suggestion carries anchor + content + end inside ONE sentence's
 * effective text, so sentence granularity isn't enough.
 *
 * Returns pseudo-sentences [{id, text}] (marker-prefixed fragment texts)
 * ready for WriteSysRenderer.renderSentencesToHTML. Regions may NEST (an
 * inner region's anchor/end ride through as ordinary fragments); matching is
 * slug-specific so crossing is impossible to *resolve* — strict validation
 * happens at canonize time.
 */
const WriteSysRegion = {
  // resolve(sentences, sugMap, slug, cmdLib, canonize) →
  //   { status: 'ok'|'missing-anchor'|'missing-end', items: [{id, text}] }
  // sentences: [{id, text}] in ordinal order; sugMap: id → suggested text;
  // canonize: WriteSysCanonicalize.canonicalize (or identity).
  resolve(sentences, sugMap, slug, cmdLib, canonize) {
    const canon = canonize || ((t) => t);
    const items = [];
    let state = 'before';
    // The opener/end may sit INLINE inside a prose fragment (the tight
    // canonize form: "prev.\n&snippet#id{label}\n\tcontent\n&end#id") —
    // find them mid-text, not just as block fragments. Indices from
    // findInline are code-point offsets (match with Array.from).
    const findTok = (text, kinds) => {
      if (!cmdLib.findInline) return null;
      for (const c of cmdLib.findInline(text)) {
        if (kinds.indexOf(c.kind) !== -1 && c.slug === slug) return c;
      }
      return null;
    };
    const slicePts = (text, a, b) => Array.from(text).slice(a, b).join('');
    for (const s of sentences) {
      const raw = (sugMap && sugMap[s.id] !== undefined) ? sugMap[s.id] : s.text;
      const eff = canon(raw);
      for (const f of cmdLib.segmentFragments(eff)) {
        if (state === 'before') {
          if (f.kind === 'command' && (f.cmd.kind === 'anchor' || f.cmd.kind === 'snippet') && f.cmd.slug === slug) {
            state = 'inside';
            continue;
          }
          if (f.kind === 'prose') {
            const open = findTok(f.text, ['anchor', 'snippet']);
            if (open) {
              state = 'inside';
              const rest = slicePts(f.text, open.end);
              const endTok = findTok(rest, ['end']);
              if (endTok) {
                const inner = slicePts(rest, 0, endTok.start);
                if (inner.trim()) items.push({ id: s.id, text: inner });
                return { status: 'ok', items };
              }
              if (rest.trim()) items.push({ id: s.id, text: rest });
            }
          }
          continue;
        }
        // state === 'inside'
        if (f.kind === 'command' && f.cmd.kind === 'end' && f.cmd.slug === slug) {
          return { status: 'ok', items };
        }
        if (f.kind === 'prose') {
          const endTok = findTok(f.text, ['end']);
          if (endTok) {
            const inner = slicePts(f.text, 0, endTok.start);
            if (inner.trim()) items.push({ id: s.id, text: (f.marker || '') + inner });
            return { status: 'ok', items };
          }
        }
        const body = f.kind === 'command' ? f.cmd.raw : f.text;
        items.push({ id: s.id, text: (f.marker || '') + body });
      }
    }
    if (state === 'before') return { status: 'missing-anchor', items: [] };
    return { status: 'missing-end', items };
  },

  // replacePlan computes the suggested edits that RE-PLACE a region: the
  // text between the &sketch/&snippet opener and its &end is replaced by
  // newText, anchors untouched. Returns { status, plan: [{id, text}] } —
  // one suggestion per affected sentence (interior sentences suggest '',
  // the standard delete). Works on RAW effective text (committed text or
  // the pending suggestion), so the plan composes with in-flight edits.
  // Sentences whose text would not change are omitted from the plan.
  replacePlan(sentences, sugMap, slug, cmdLib, newText) {
    const plan = [];
    const push = (s, eff, text) => { if (text !== eff) plan.push({ id: s.id, text }); };
    // Token scan over one raw text: the whole-text block-command case plus
    // inline tokens (findInline skips the whole-is-block case by design).
    const tokensOf = (eff) => {
      const trimmed = eff.trim();
      if (cmdLib.isBlockCommandText && cmdLib.isBlockCommandText(trimmed)) {
        const cmd = cmdLib.parse(trimmed);
        if (cmd) return [{ kind: cmd.kind, slug: cmd.slug, start: 0, end: Array.from(eff).length, block: true }];
      }
      return cmdLib.findInline(eff);
    };
    const pts = (text, a, b) => Array.from(text).slice(a, b).join('');
    let state = 'before';
    for (const s of sentences) {
      const eff = (sugMap && sugMap[s.id] !== undefined) ? sugMap[s.id] : s.text;
      if (state === 'before') {
        const toks = tokensOf(eff);
        const open = toks.find((c) => (c.kind === 'anchor' || c.kind === 'snippet') && c.slug === slug);
        if (!open) continue;
        const after = toks.find((c) => c.kind === 'end' && c.slug === slug && c.start >= open.end);
        // An INLINE region start ("&sketch#x{} prose", 2026-08-22) keeps
        // its space join on re-placement; own-line/tight forms keep their
        // newline joins. Read the join off the existing text.
        const joinAfter = (tok) => pts(eff, tok.end, tok.end + 1) === ' ' ? ' ' : '\n\t';
        const joinBefore = (tok) => pts(eff, tok.start - 1, tok.start) === ' ' ? ' ' : '\n';
        if (open.block) {
          // A sole-line opener: the new content follows it, indented — the
          // tight placement form.
          push(s, eff, eff.replace(/\s+$/, '') + '\n\t' + newText);
          state = 'inside';
        } else if (after) {
          push(s, eff, pts(eff, 0, open.end) + joinAfter(open) + newText + joinBefore(after) + pts(eff, after.start));
          return { status: 'ok', plan };
        } else {
          push(s, eff, pts(eff, 0, open.end) + joinAfter(open) + newText);
          state = 'inside';
        }
        continue;
      }
      // state === 'inside' — delete until the matching &end.
      const toks = tokensOf(eff);
      const endTok = toks.find((c) => c.kind === 'end' && c.slug === slug);
      if (endTok) {
        push(s, eff, endTok.block ? eff : pts(eff, endTok.start));
        return { status: 'ok', plan };
      }
      push(s, eff, '');
    }
    return { status: state === 'before' ? 'missing-anchor' : 'missing-end', plan: [] };
  },

  // regionRawText joins resolve()'s fragments back into an approximate raw
  // text of what's currently placed — the seed for "sketch from placed
  // text". Fragment markers ('\n\n' section breaks etc.) ride along;
  // unmarked fragments joined with a space.
  regionRawText(sentences, sugMap, slug, cmdLib, canonize) {
    const res = this.resolve(sentences, sugMap, slug, cmdLib, canonize);
    if (res.status !== 'ok') return null;
    let out = '';
    for (const it of res.items) {
      out += (it.text.startsWith('\n') || out === '' ? '' : ' ') + it.text;
    }
    return out.trim();
  },

  // effectiveSlugs collects every slug used by any block command in the
  // effective manuscript (committed + suggestions) — canonize-time
  // uniqueness validation (decision 6).
  effectiveSlugs(sentences, sugMap, cmdLib, canonize) {
    const canon = canonize || ((t) => t);
    const slugs = new Set();
    for (const s of sentences) {
      const raw = (sugMap && sugMap[s.id] !== undefined) ? sugMap[s.id] : s.text;
      for (const f of cmdLib.segmentFragments(canon(raw))) {
        if (f.kind === 'command' && f.cmd.slug) slugs.add(f.cmd.slug);
      }
      // Inline commands can carry slugs too (inline anchors/references).
      const cmds = cmdLib.findInline(canon(raw));
      for (const c of cmds) if (c.slug) slugs.add(c.slug);
    }
    return slugs;
  },
};

if (typeof window !== 'undefined') {
  window.WriteSysRegion = WriteSysRegion;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = WriteSysRegion;
}
