// Unit (no browser, no server): region.js `replacePlan` battery plus the
// resolve/regionRawText/effectiveSlugs gaps (CODE_REVIEW_AUG_2026.md §1.4,
// "region.js" table). test-region-resolver.js covers resolve()'s block-level
// happy paths; this file covers the RE-PLACE plan (until now exercised only
// through one full-stack e2e), the inline open+end single-fragment resolve,
// canonicalize application, code-point offset discipline, raw-text joins,
// and inline slug collection.
const cmd = require('../web/js/command.js');
const region = require('../web/scratchpad/region.js');

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed++;
};

console.log('=== region replacePlan + resolve units ===\n');

// ---- replaceplan-inline-same-sentence (region.js:106–116) -----------------
// Opener AND end inline inside one sentence → a single suggestion of the
// form prefix + '\n\t' + newText + '\n' + suffix.
{
  const sentences = [
    { id: 'z', text: 'Zero sentence.' },
    { id: 'p', text: 'Prose before. &sketch#keg{x} old inner &end#keg tail after.' },
    { id: 'q', text: 'Never reached.' },
  ];
  const res = region.replacePlan(sentences, {}, 'keg', cmd, 'NEW');
  check('inline same-sentence: status ok', res.status === 'ok', res.status);
  check('inline same-sentence: single suggestion', res.plan.length === 1, String(res.plan.length));
  check('inline same-sentence: targets the host sentence', res.plan[0] && res.plan[0].id === 'p');
  check('inline same-sentence: space joins preserved (inline region form)',
    res.plan[0] && res.plan[0].text === 'Prose before. &sketch#keg{x} NEW &end#keg tail after.',
    JSON.stringify(res.plan[0] && res.plan[0].text));
}

// ---- replaceplan-block-opener (:109–113) + interior delete + unchanged
// omitted (:89, :123–130). Also: the legacy 'snippet' spelling parses as
// the same opener kind.
{
  const sentences = [
    { id: 'a', text: 'Before.' },
    { id: 'b', text: '&sketch#keg{The keg}' },        // sole-line (block) opener
    { id: 'c', text: '\n\nInside one.' },
    { id: 'blank', text: '' },                         // already empty → no-op
    { id: 'd', text: '\n\nInside two.' },
    { id: 'e', text: '\n\n&end#keg' },                 // block end — unchanged
    { id: 'f', text: '\n\nAfter.' },
  ];
  const res = region.replacePlan(sentences, {}, 'keg', cmd, 'FRESH');
  check('block opener: status ok', res.status === 'ok', res.status);
  const byId = {};
  res.plan.forEach(x => { byId[x.id] = x.text; });
  check('block opener: content follows after \\n\\t',
    byId.b === '&sketch#keg{The keg}\n\tFRESH', JSON.stringify(byId.b));
  check('interior sentences suggest the standard delete (empty text)',
    byId.c === '' && byId.d === '');
  check('already-empty interior omitted from plan', !('blank' in byId));
  check('unchanged block-&end sentence omitted from plan', !('e' in byId));
  check('sentences before the opener untouched', !('a' in byId));
  check('sentences after the end untouched (early return)', !('f' in byId));
  check('plan holds exactly the changed sentences', res.plan.length === 3, String(res.plan.length));
}

// ---- replaceplan-interior-delete: inline end → end sentence TRIMMED (the
// pre-end run deleted, the &end onward kept) (:123–130).
{
  const sentences = [
    { id: 'a', text: '&sketch#keg{x}' },
    { id: 'b', text: '\n\nDoomed middle.' },
    { id: 'c', text: 'Tail start &end#keg and after.' },
  ];
  const res = region.replacePlan(sentences, {}, 'keg', cmd, 'X');
  const byId = {};
  res.plan.forEach(x => { byId[x.id] = x.text; });
  check('inline end: status ok', res.status === 'ok', res.status);
  check('inline end: pre-end content trimmed, &end onward kept',
    byId.c === '&end#keg and after.', JSON.stringify(byId.c));
  check('inline end: interior deleted', byId.b === '');
}

// ---- replaceplan-missing-anchor / missing-end (:132) — both failure
// statuses return an EMPTY plan (partial pushes discarded).
{
  const sentences = [
    { id: 'a', text: 'No commands at all.' },
    { id: 'b', text: '&sketch#keg{x}' },
    { id: 'c', text: '\n\nContent but no end.' },
  ];
  let res = region.replacePlan(sentences, {}, 'nope', cmd, 'X');
  check('missing anchor: status', res.status === 'missing-anchor', res.status);
  check('missing anchor: empty plan', res.plan.length === 0);
  res = region.replacePlan(sentences, {}, 'keg', cmd, 'X');
  check('missing end: status', res.status === 'missing-end', res.status);
  check('missing end: empty plan (partial pushes discarded)', res.plan.length === 0);
}

// ---- replaceplan-composes-with-suggestion (:103) — the sugMap entry is the
// base, so the plan composes with an in-flight edit.
{
  const sentences = [{ id: 's1', text: 'Committed text without any region.' }];
  const sug = { s1: 'Lead. &sketch#keg{x} old &end#keg tail.' };
  const res = region.replacePlan(sentences, sug, 'keg', cmd, 'NEW');
  check('sugMap composes: status ok', res.status === 'ok', res.status);
  check('sugMap composes: plan built on the suggestion, not the committed text',
    res.plan.length === 1 && res.plan[0].text === 'Lead. &sketch#keg{x} NEW &end#keg tail.',
    JSON.stringify(res.plan[0] && res.plan[0].text));
}

// ---- replaceplan-codepoints (:96, :100) — astral characters before/inside
// the tokens must not shift offsets (Array.from slicing, code-point indices
// from findInline). Any code-UNIT slicing would corrupt the exact strings.
{
  const sentences = [
    { id: 'u', text: '𝔘𝔫𝔦 😀 &sketch#keg{a😀b} old &end#keg 🎉 tail.' },
  ];
  const res = region.replacePlan(sentences, {}, 'keg', cmd, 'NEW✨');
  check('codepoints: status ok', res.status === 'ok', res.status);
  check('codepoints: astral prefix/label/suffix survive exactly',
    res.plan.length === 1
      && res.plan[0].text === '𝔘𝔫𝔦 😀 &sketch#keg{a😀b} NEW✨ &end#keg 🎉 tail.',
    JSON.stringify(res.plan[0] && res.plan[0].text));
}

// ---- regionrawtext-join (:139–147) — marker-led fragments concatenate
// directly; unmarked fragments join with a single space; non-ok → null.
{
  const committed = [
    { id: 'x', text: '&anchor#keg{lbl}' },
    { id: 'y', text: 'First part.' },
    { id: 'y2', text: 'Also here.' },
    { id: 'z', text: '\n\nSecond para.' },
    { id: 'e', text: '\n\n&end#keg' },
  ];
  const out = region.regionRawText(committed, {}, 'keg', cmd, null);
  check('regionRawText: space-join for unmarked, direct concat for marker-led',
    out === 'First part. Also here.\n\nSecond para.', JSON.stringify(out));
  const broken = region.regionRawText(committed.slice(0, 4), {}, 'keg', cmd, null);
  check('regionRawText: non-ok resolve → null', broken === null, String(broken));
}

// ---- resolve-inline-open-and-end-same-fragment (:44–57) — both tokens in
// one prose fragment → exactly one inner item, boundaries excluded.
{
  const sentences = [
    { id: 'q', text: 'Boundary. &sketch#keg{x} the inner bit &end#keg afterwards.' },
  ];
  const res = region.resolve(sentences, {}, 'keg', cmd, null);
  check('inline open+end: status ok', res.status === 'ok', res.status);
  check('inline open+end: single inner item', res.items.length === 1, String(res.items.length));
  check('inline open+end: inner text captured', res.items.length === 1 && /the inner bit/.test(res.items[0].text));
  check('inline open+end: boundary and tail excluded',
    !res.items.some(i => /Boundary|afterwards/.test(i.text)));
}

// ---- resolve-with-canonicalize (:20, :36–37) — the canonize fn is actually
// applied per sentence (every pre-existing case passes null).
{
  const sentences = [
    { id: 'x', text: 'OPEN-TOKEN' },
    { id: 'y', text: '\n\nInside prose.' },
    { id: 'z', text: 'CLOSE-TOKEN' },
  ];
  const canon = (t) => t
    .replace('OPEN-TOKEN', '&anchor#keg{lbl}')
    .replace('CLOSE-TOKEN', '&end#keg');
  const withCanon = region.resolve(sentences, {}, 'keg', cmd, canon);
  check('canonicalize applied: region resolves through the canon transform',
    withCanon.status === 'ok' && withCanon.items.length === 1
      && /Inside prose/.test(withCanon.items[0].text),
    withCanon.status);
  const withoutCanon = region.resolve(sentences, {}, 'keg', cmd, null);
  check('canonicalize omitted: same input does NOT resolve (proves fn was used)',
    withoutCanon.status === 'missing-anchor', withoutCanon.status);
}

// ---- effectiveslugs-inline (:160–162) — slugs of INLINE commands are
// collected too (the existing resolver test only covers block slugs).
{
  const sentences = [
    { id: 'm', text: 'Prose with &reference#refslug{see notes} and &anchor#ml{} inline.' },
    { id: 'n', text: '&chapter#chap-one{One}' },
  ];
  const slugs = region.effectiveSlugs(sentences, {}, cmd, null);
  check('effectiveSlugs: inline reference slug collected', slugs.has('refslug'), [...slugs].join(','));
  check('effectiveSlugs: inline anchor slug collected', slugs.has('ml'));
  check('effectiveSlugs: block slugs still collected alongside', slugs.has('chap-one'));
}

console.log(failed === 0 ? '\n✅ Test passed' : `\n❌ ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
