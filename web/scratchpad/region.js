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
    for (const s of sentences) {
      const raw = (sugMap && sugMap[s.id] !== undefined) ? sugMap[s.id] : s.text;
      const eff = canon(raw);
      for (const f of cmdLib.segmentFragments(eff)) {
        if (state === 'before') {
          if (f.kind === 'command' && f.cmd.kind === 'anchor' && f.cmd.slug === slug) {
            state = 'inside';
          }
          continue;
        }
        if (state === 'inside') {
          if (f.kind === 'command' && f.cmd.kind === 'end' && f.cmd.slug === slug) {
            return { status: 'ok', items };
          }
          const body = f.kind === 'command' ? f.cmd.raw : f.text;
          items.push({ id: s.id, text: (f.marker || '') + body });
        }
      }
    }
    if (state === 'before') return { status: 'missing-anchor', items: [] };
    return { status: 'missing-end', items };
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
