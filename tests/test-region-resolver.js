// Unit (no browser, no server): region resolution for canonized blocks
// (SCRATCHPAD_PLAN.md §3/§6) — fragment-level anchor→end scanning over
// effective (suggested-or-committed) sentence texts.
const cmd = require('../web/js/command.js');
const region = require('../web/scratchpad/region.js');

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed++;
};

console.log('=== region resolver ===\n');

// A pending canonize suggestion: everything lives in ONE sentence's
// effective text (boundary sentence + anchor + content + end).
const sentences = [
  { id: 's1', text: 'Before it all.' },
  { id: 's2', text: 'The boundary sentence.' },
  { id: 's3', text: 'After everything.' },
];
const sug = {
  s2: 'The boundary sentence.\n\n&anchor#keg{The keg party}\n\nInside one. Inside two.\n\t Indented inside.\n\n&end#keg',
};

let res = region.resolve(sentences, sug, 'keg', cmd, null);
check('suggestion-carried region resolves', res.status === 'ok', res.status);
check('two content fragments', res.items.length === 2, String(res.items.length));
check('fragments carry the host sentence id', res.items.every(i => i.id === 's2'));
check('section marker preserved', res.items[0].text.startsWith('\n\n'));
check('paragraph marker preserved', res.items[1].text.startsWith('\n\t'));
check('boundary prose excluded', !res.items.some(i => /boundary sentence/.test(i.text)));

// Committed region across separate sentences (post-push shape).
const committed = [
  { id: 'a', text: 'Prose before.' },
  { id: 'b', text: '&anchor#keg{The keg party}' },
  { id: 'c', text: '\n\nInside the region.' },
  { id: 'd', text: '\n\n&placeholder#more{sentences}{s}' },
  { id: 'e', text: '\n\n&end#keg' },
  { id: 'f', text: '\n\nAfter the region.' },
];
res = region.resolve(committed, {}, 'keg', cmd, null);
check('committed region resolves', res.status === 'ok', res.status);
check('nested command fragment rides through', res.items.some(i => /&placeholder#more/.test(i.text)));
check('after-region prose excluded', !res.items.some(i => /After the region/.test(i.text)));

// Nested regions: inner end must not close the outer (slug-specific match).
const nested = [
  { id: 'n1', text: '&anchor#outer{}' },
  { id: 'n2', text: '\n\nOuter one.' },
  { id: 'n3', text: '\n\n&anchor#inner{}' },
  { id: 'n4', text: '\n\nInner content.' },
  { id: 'n5', text: '\n\n&end#inner' },
  { id: 'n6', text: '\n\nOuter two.' },
  { id: 'n7', text: '\n\n&end#outer' },
];
res = region.resolve(nested, {}, 'outer', cmd, null);
check('nesting: outer spans past inner end', res.status === 'ok' && res.items.some(i => /Outer two/.test(i.text)));
res = region.resolve(nested, {}, 'inner', cmd, null);
check('nesting: inner region resolves alone', res.status === 'ok' && res.items.length === 1 && /Inner content/.test(res.items[0].text));

// Broken regions (strictness: caller falls back to snapshot).
res = region.resolve(committed, {}, 'nope', cmd, null);
check('missing anchor reported', res.status === 'missing-anchor');
res = region.resolve(committed.slice(0, 4), {}, 'keg', cmd, null);
check('missing end reported', res.status === 'missing-end');

// Slug collection for canonize-time uniqueness validation.
const slugs = region.effectiveSlugs(committed, {}, cmd, null);
check('effectiveSlugs collects anchor/placeholder/end slugs',
  slugs.has('keg') && slugs.has('more'), [...slugs].join(','));

console.log(failed === 0 ? '\n✅ Test passed' : `\n❌ ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
