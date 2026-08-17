/**
 * Scratchpad scroll machinery (split out of editor-core.mjs —
 * CODE_REVIEW_AUG_2026.md §1): the scroll flight recorder (scrollDiag) and the
 * shared scroll hold (ONE pin per host; suspended holds rebase instead of
 * fighting deliberate scrolls — invariant §1.2#10).
 */
// Import cycle note: pad-notes.mjs imports holdScroll from here; we import
// getActiveView (diagnostics only) from pad-notes. Both uses are strictly
// call-time (never at module evaluation), so the ESM cycle is safe.
import { getActiveView } from './pad-notes.mjs?v=1';

// ---- Scroll flight recorder ------------------------------------------------
// Always-on ring buffer of scroll-relevant events in the pad. When the scroll
// JUMPS (>300px in one event), the whole buffer dumps to the console as
// [ms-scrolldiag] lines — copy-paste them into a bug report. Manual dump:
// window.msScrollDiag.dump(). Overhead is a few pushes per interaction.
export const scrollDiag = {
  buf: [],
  t0: (typeof performance !== 'undefined' ? performance.now() : 0),
  host: null,
  push(kind, data) {
    this.buf.push({ t: Math.round(performance.now() - this.t0), kind, ...data });
    if (this.buf.length > 100) this.buf.shift();
  },
  el(e) {
    if (!e || !e.tagName) return String(e);
    const cls = String(e.className && e.className.baseVal !== undefined ? e.className.baseVal : e.className || '')
      .split(/\s+/).slice(0, 3).join('.');
    const w = e.closest && e.closest('.sn-widget');
    return e.tagName + (cls ? '.' + cls : '')
      + (e.dataset && e.dataset.noteId ? `[note=${e.dataset.noteId}]` : '')
      + (w ? `[widget=${w.dataset.variationId}]` : '');
  },
  state() {
    try {
      const v = getActiveView();
      const sel = v && v.state.selection.from;
      return {
        scrollTop: this.host ? Math.round(this.host.scrollTop) : null,
        selFrom: sel,
        docSize: v && v.state.doc.content.size,
        activeEl: this.el(document.activeElement),
        suspendLeft: Math.max(0, Math.round(holdSuspendUntil - performance.now())),
        holds: this.host && scrollHolds.has(this.host)
          ? { base: Math.round(scrollHolds.get(this.host).base), fns: scrollHolds.get(this.host).fns.length }
          : null,
      };
    } catch (e) { return { err: String(e) }; }
  },
  dump(reason) {
    /* eslint-disable no-console */
    console.log(`[ms-scrolldiag] ==== ${reason || 'manual dump'} ====`);
    console.log('[ms-scrolldiag] state ' + JSON.stringify(this.state()));
    this.buf.forEach((e) => console.log('[ms-scrolldiag] ' + JSON.stringify(e)));
    console.log(`[ms-scrolldiag] ==== end (${this.buf.length} events; copy everything above) ====`);
  },
  install(host) {
    if (this.host === host) return;
    this.host = host;
    this.buf = [];
    this.t0 = performance.now();
    let last = host.scrollTop;
    host.addEventListener('scroll', () => {
      const now = host.scrollTop;
      const d = now - last;
      this.push('scroll', { from: Math.round(last), to: Math.round(now) });
      const jumped = Math.abs(d) > 300;
      last = now;
      if (jumped) this.dump(`JUMP ${Math.round(d)}px`);
    });
    const overlay = host.closest('.spm-overlay') || host;
    overlay.addEventListener('mousedown', (e) => this.push('mousedown', { on: this.el(e.target) }), true);
    overlay.addEventListener('focusin', (e) => this.push('focusin', { on: this.el(e.target) }), true);
    overlay.addEventListener('focusout', (e) => this.push('focusout', { on: this.el(e.target) }), true);
    if (typeof window !== 'undefined') window.msScrollDiag = this;
  },
};

// ---- Shared scroll hold ----------------------------------------------------
// ONE pin per scroll host, shared by every widget that re-renders in the same
// window. Pinning raw scrollTop per-widget was wrong twice over: (a) when a
// widget ABOVE the viewport grows/shrinks (sibling refresh after a save), the
// content the reader is looking at shifts by the height delta even though
// scrollTop never changed — the "suddenly I'm at the top of the pad" jump —
// so the right target is base + Σ height-deltas of above-viewport widgets;
// (b) two widgets rebuilding concurrently each pinned their own snapshot and
// fought each other. holdScroll keeps one base and a list of delta functions,
// re-evaluated every frame, so late async growth (peer previews filling in
// after a fetch) is compensated for as long as any hold is active.
const scrollHolds = new Map(); // host → {base, fns, until, pin}
// While a DELIBERATE scroll is in progress (deep-link settle-scroll to a note,
// navigate-to-variation), holds must not fight it: suspended holds ABSORB the
// current position (rebase) instead of pinning, then defend the new position
// once the suspension lapses. Without this, widgets building during a pad open
// re-arm the hold and yank the settle-scroll back to the top — the deep-link
// "never lands on the note" regression.
let holdSuspendUntil = 0;
export function suspendScrollHolds(ms) {
  holdSuspendUntil = Math.max(holdSuspendUntil, performance.now() + ms);
  scrollDiag.push('suspend-holds', { ms });
}
export function holdScroll(host, ms, deltaFn) {
  let h = scrollHolds.get(host);
  scrollDiag.push('hold', { fresh: !h, ms, delta: !!deltaFn, base: Math.round(h ? h.base : host.scrollTop) });
  if (!h) {
    h = { base: host.scrollTop, fns: [], until: 0 };
    h.sum = () => h.fns.reduce((s, f) => s + f(), 0);
    h.pin = () => {
      if (performance.now() < holdSuspendUntil) {
        h.base = host.scrollTop - h.sum(); // track, don't fight
        return;
      }
      const want = h.base + h.sum();
      if (host.scrollTop !== want) {
        scrollDiag.push('pin-fight', { from: Math.round(host.scrollTop), to: Math.round(want) });
        host.scrollTop = want;
      }
    };
    scrollHolds.set(host, h);
    host.addEventListener('scroll', h.pin, true);
    const step = () => {
      if (performance.now() > h.until) {
        scrollHolds.delete(host);
        host.removeEventListener('scroll', h.pin, true);
        return;
      }
      h.pin();
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  } else {
    // Re-arming an existing hold: adopt whatever position the page is at NOW
    // (a settle-scroll or the user may have moved since the hold was created)
    // rather than defending a stale base forever.
    h.base = host.scrollTop - h.sum();
  }
  h.until = Math.max(h.until, performance.now() + ms);
  if (deltaFn) h.fns.push(deltaFn);
}
