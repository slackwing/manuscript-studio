/**
 * Render-pipeline wiring (no DB, no browser): the render loop now does
 * effective = canonicalize(suggestion ?? committed) BEFORE segmentFragments.
 * This asserts the composed behavior canonicalize→segment produces the right
 * fragment shapes for the cases that motivated canonicalization.
 */
const cmd = require('../web/js/command.js');
const { canonicalize } = require('../web/js/canonicalize.js');

let failed = 0;
const check = (name, ok, extra) => {
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) failed++;
};

// Simulate the render loop's per-sentence transform.
const pipeline = (raw) => cmd.segmentFragments(canonicalize(raw));
const kinds = (frags) => frags.map(f => f.kind + (f.cmd ? ':' + f.cmd.kind : ''));

// 1. Leading anchor + prose → block anchor fragment THEN prose fragment.
{
  const frags = pipeline('&anchor{The salvia night.} We probably recounted tales.');
  check('leading anchor: [command:anchor, prose]',
    JSON.stringify(kinds(frags)) === JSON.stringify(['command:anchor', 'prose']),
    JSON.stringify(kinds(frags)));
  const anchorFrag = frags.find(f => f.kind === 'command');
  check('anchor fragment carries the anchor cmd', anchorFrag && anchorFrag.cmd.kind === 'anchor');
  const prose = frags.find(f => f.kind === 'prose');
  check('prose fragment is the trailing text', prose && /We probably recounted/.test(prose.text));
}

// 2. Inline-typed &part (with stray spaces) → single block command fragment.
{
  const frags = pipeline('   &part#p1{I.}{The Gathering}   ');
  check('inline-typed part canonicalizes to [command:part]',
    JSON.stringify(kinds(frags)) === JSON.stringify(['command:part']),
    JSON.stringify(kinds(frags)));
}

// 3. Inline anchor mid-sentence stays ONE prose fragment (not blocked out).
{
  const frags = pipeline('The fire &anchor#firemark{} spread.');
  check('inline anchor stays prose',
    JSON.stringify(kinds(frags)) === JSON.stringify(['prose']),
    JSON.stringify(kinds(frags)));
}

// 4. Whole-block anchor (no prose) → single command fragment.
{
  const frags = pipeline('&anchor{Waypoint}');
  check('block anchor alone → [command:anchor]',
    JSON.stringify(kinds(frags)) === JSON.stringify(['command:anchor']),
    JSON.stringify(kinds(frags)));
}

// 5. Plain prose with trailing spaces → one clean prose fragment.
{
  const frags = pipeline('The fire began at dawn.   ');
  check('plain prose → [prose]', JSON.stringify(kinds(frags)) === JSON.stringify(['prose']));
  check('trailing space trimmed', frags[0].text === 'The fire began at dawn.', JSON.stringify(frags[0].text));
}

// 6. '#' header is literal prose (deprecated), not a command.
{
  const frags = pipeline('## Chapter 1   ');
  check('markdown header → [prose]', JSON.stringify(kinds(frags)) === JSON.stringify(['prose']));
}

if (failed === 0) {
  console.log('\n✅ canon→render pipeline: all checks pass');
  process.exit(0);
}
console.log(`\n${failed} check(s) failed`);
process.exit(1);
