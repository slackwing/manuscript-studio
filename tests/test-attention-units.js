// Attention kernel units (ATTENTION_PLAN.md §2) — pure math, no browser.
// Loads attention.js in a vm with a window stub (same technique as
// test-diff-units.js for suggestions.js).
const fs = require('fs');
const vm = require('vm');
const path = require('path');

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail !== '' ? ` (${detail})` : ''}`);
  if (!ok) failed++;
};

const ctx = { window: {}, document: undefined };
vm.createContext(ctx);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, '..', 'web', 'js', 'attention.js'), 'utf-8'), ctx);
const A = ctx.window.WriteSysAttention;
const T = A.TUNING;

console.log('=== attention kernel units ===');

check('kernel is 0 before the marker', A.kernel(-1) === 0);
check('kernel is 0 at the marker itself (smooth rise, not a step)',
  Math.abs(A.kernel(0)) < 1e-9, String(A.kernel(0)));

// Peak: exactly 1 at u* = (A·D/(D−A))·ln(D/A), and nothing exceeds it.
const uStar = (T.ATTACK_WORDS * T.DECAY_WORDS) / (T.DECAY_WORDS - T.ATTACK_WORDS)
  * Math.log(T.DECAY_WORDS / T.ATTACK_WORDS);
check('kernel peaks at exactly 1 (a lone +15 marker peaks at 15)',
  Math.abs(A.kernel(uStar) - 1) < 1e-9, String(A.kernel(uStar)));
let maxK = 0;
for (let u = 0; u < 8 * T.DECAY_WORDS; u += 1) maxK = Math.max(maxK, A.kernel(u));
check('nothing exceeds the peak', maxK <= 1 + 1e-9, String(maxK));

check('decay: far past the marker the contribution is ~0',
  A.kernel(T.CUTOFF_DECAYS * T.DECAY_WORDS) < 0.005, String(A.kernel(T.CUTOFF_DECAYS * T.DECAY_WORDS)));

// Superposition: a second marker ADDS to the decayed value of the first.
const events = [{ t: 0, v: 5 }, { t: 400, v: 5 }];
const justBefore = A.attentionAt(399, events);
const atSecondPeak = A.attentionAt(400 + uStar, events);
check('second impulse adds onto the decayed first',
  atSecondPeak > 5 && atSecondPeak < 10,
  `before=${justBefore.toFixed(3)} secondPeak=${atSecondPeak.toFixed(3)}`);

// Negative markers dip and recover.
const dip = [{ t: 0, v: -15 }];
check('negative marker dips below zero', A.attentionAt(uStar, dip) < -14.9,
  String(A.attentionAt(uStar, dip)));
check('and recovers toward zero', A.attentionAt(5 * T.DECAY_WORDS, dip) > -0.2,
  String(A.attentionAt(5 * T.DECAY_WORDS, dip)));

// Events beyond the cutoff stop contributing (and sorted-break correctness:
// events after t contribute nothing).
check('future events contribute nothing', A.attentionAt(100, [{ t: 200, v: 50 }]) === 0);

console.log('');
if (failed) { console.log(`❌ ${failed} check(s) failed`); process.exit(1); }
console.log('✅ attention units: all checks pass');
