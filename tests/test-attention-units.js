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
// C² onset: near the marker K ~ (u/A)³ — first AND second derivative
// vanish, so the impulse ACCELERATES from nothing (no kink).
check('onset is derivative-smooth (K(0.5) is cubic-tiny)',
  A.kernel(0.5) < 1e-3, String(A.kernel(0.5)));

// Peak: exactly 1 at the numerically-located u*, nothing exceeds it.
A.kernel(1); // prime the cache
const uStar = A._kcache.uStar;
check('peak lands about a line out (~1.8×A words)',
  uStar > T.ATTACK_WORDS && uStar < 3 * T.ATTACK_WORDS, String(uStar));
check('kernel peaks at exactly 1 (a lone +15 marker peaks at 15)',
  Math.abs(A.kernel(uStar) - 1) < 1e-6, String(A.kernel(uStar)));
let maxK = 0;
for (let u = 0; u < 8 * T.DECAY_WORDS; u += 1) maxK = Math.max(maxK, A.kernel(u));
check('nothing exceeds the peak', maxK <= 1 + 1e-6, String(maxK));
let mono = true;
for (let u = Math.ceil(uStar) + 1; u < 5 * T.DECAY_WORDS; u += 1) {
  if (A.kernel(u) > A.kernel(u - 1) + 1e-12) { mono = false; break; }
}
check('monotone decay after the peak', mono);

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

// ---- pchip (the smooth y→t map) ----------------------------------------
console.log('\n=== jading units (habituation) ===');
A.TUNING.JADE_SCALE = 10;
A.TUNING.JADE_RECOVERY_WORDS = 300;
{
  // Immediate repeat lands weaker: +10 then +10 one word later → the
  // second passes at 10/(1+10/10) ≈ 5 (divisive normalization).
  const j = A.jade([{ t: 0, v: 10 }, { t: 1, v: 10 }]);
  check('first spike lands full strength', Math.abs(j[0].v - 10) < 1e-9, String(j[0].v));
  check('an immediate repeat is halved (JADE_SCALE worth of J)',
    j[1].v > 4.5 && j[1].v < 5.5, String(j[1].v));
  // Novelty regrows: same repeat 5 recovery-constants later ≈ full.
  const far = A.jade([{ t: 0, v: 10 }, { t: 1500, v: 10 }]);
  check('spacing markers out restores novelty', far[1].v > 9.5, String(far[1].v));
  // Independent pools: a −15 right before a +10 does NOT dull it.
  const mixed = A.jade([{ t: 0, v: -15 }, { t: 1, v: 10 }]);
  check('negative markers do not jade positive ones (independent pools)',
    Math.abs(mixed[1].v - 10) < 1e-9, String(mixed[1].v));
  // …but a second negative IS dulled.
  const negs = A.jade([{ t: 0, v: -15 }, { t: 1, v: -15 }]);
  check('a second negative in a row is dulled', Math.abs(negs[1].v) < 8, String(negs[1].v));
  // Effective values keep monotone recovery: wider gap → stronger second.
  const near = A.jade([{ t: 0, v: 10 }, { t: 50, v: 10 }])[1].v;
  const mid2 = A.jade([{ t: 0, v: 10 }, { t: 300, v: 10 }])[1].v;
  check('recovery is monotone with spacing', near < mid2 && mid2 < far[1].v,
    `50w=${near.toFixed(2)} 300w=${mid2.toFixed(2)} 1500w=${far[1].v.toFixed(2)}`);
}

console.log('\n=== smoothing layer units ===');
{
  // The 2026-09-10 complaint: mid-decay, an opposite-sign marker turns the
  // sum around within ~ATTACK_WORDS — a sharp valley. The Gaussian layer
  // must round it: max curvature (2nd difference) drops, the valley's
  // level barely moves, and σ=0 is the identity.
  const ev = [{ t: 0, v: 10 }, { t: 60, v: -8 }];
  const curvature = (fn) => {
    let worst = 0;
    for (let t = 40; t <= 120; t += 1) {
      worst = Math.max(worst, Math.abs(fn(t - 1) + fn(t + 1) - 2 * fn(t)));
    }
    return worst;
  };
  const saved = T.SMOOTH_WORDS;
  T.SMOOTH_WORDS = 0;
  check('σ=0 is the identity',
    A.attentionSmoothAt(70, ev) === A.attentionAt(70, ev));
  const rawCurv = curvature((t) => A.attentionAt(t, ev));
  T.SMOOTH_WORDS = saved;
  const smoothCurv = curvature((t) => A.attentionSmoothAt(t, ev));
  check('smoothing rounds the valley (max curvature drops sharply)',
    smoothCurv < rawCurv / 2, `raw=${rawCurv.toFixed(4)} smooth=${smoothCurv.toFixed(4)}`);
  // The valley's depth is preserved within tolerance — smoothing reshapes,
  // it does not erase the dip.
  let rawMin = Infinity, smMin = Infinity;
  for (let t = 40; t <= 200; t += 0.5) {
    rawMin = Math.min(rawMin, A.attentionAt(t, ev));
    smMin = Math.min(smMin, A.attentionSmoothAt(t, ev));
  }
  check('the dip survives (level within 25%)',
    smMin < 0 && Math.abs(smMin - rawMin) < Math.abs(rawMin) * 0.25,
    `raw=${rawMin.toFixed(3)} smooth=${smMin.toFixed(3)}`);
}

console.log('\n=== pchip units ===');
const knots = [[0, 0], [20, 10], [40, 10], [60, 30], [100, 60]];
const f = A.pchip(knots);
check('hits every knot exactly', knots.every(([y, t]) => Math.abs(f(y) - t) < 1e-9));
let monoT = true;
let prev = -1;
for (let y = 0; y <= 100; y += 0.25) { const t = f(y); if (t < prev - 1e-9) { monoT = false; break; } prev = t; }
check('monotone — time never runs backwards (even across the flat knot pair)', monoT);
check('clamps beyond the ends', f(-5) === 0 && f(200) === 60);
// C¹: slopes from both sides of an interior knot agree (finite diff).
const e = 0.001;
const slopeL = (f(60) - f(60 - e)) / e;
const slopeR = (f(60 + e) - f(60)) / e;
check('C¹ at interior knots (one-sided slopes agree)',
  Math.abs(slopeL - slopeR) < 0.05, `L=${slopeL.toFixed(4)} R=${slopeR.toFixed(4)}`);
// No flat shelf between knots with distinct t (the line-gap fix).
const mid = (f(80.5) - f(79.5));
check('no flat shelf between distinct-t knots', mid > 0.05, String(mid));

console.log('');
if (failed) { console.log(`❌ ${failed} check(s) failed`); process.exit(1); }
console.log('✅ attention units: all checks pass');
