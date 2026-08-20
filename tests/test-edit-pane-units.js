// Unit (no browser, no server): WriteSysEditPane — the shared autosaver,
// mono editor, tab markup, and draft persistence (CODE_REVIEW_AUG_2026.md
// §1.4, "edit-pane.js" table; all U rows — autogrow-pin is e2e, elsewhere).
// Until now the autosaver was only exercised through its hosts; these run it
// directly under a fake clock so the retry ladder (2→60s) is deterministic.
//
// edit-pane.js is a classic window-global script; the test supplies minimal
// window/localStorage/document shims and requires it via its module.exports
// guard.

// ---- fake browser globals (BEFORE loading the script) ----------------------
global.window = {}; // no WriteSysSessionGuard → no re-login link paths

const store = new Map();
global.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};

// Minimal DOM for createMonoEditor (elements are plain records; only what
// the pane touches: className/style/children/listeners/value/selection).
function makeEl(tag) {
  const listeners = {};
  const el = {
    tagName: tag, className: '', style: {}, children: [],
    value: '', selectionStart: 0, selectionEnd: 0,
    offsetHeight: 0, scrollHeight: 0, innerHTML: '',
    setAttribute() {},
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    dispatchEvent(ev) { (listeners[ev.type] || []).forEach((fn) => fn(ev)); return true; },
    focus(opts) { el.focusedWith = opts || {}; },
  };
  return el;
}
global.document = { createElement: makeEl };

// ---- fake clock (setTimeout/setInterval overridden globally) ---------------
const realSetImmediate = setImmediate;
const drain = () => new Promise((r) => realSetImmediate(r));
const clock = (() => {
  let now = 0, seq = 0;
  const timers = new Map();
  global.setTimeout = (fn, ms = 0) => { const id = ++seq; timers.set(id, { fn, at: now + ms, every: 0 }); return id; };
  global.setInterval = (fn, ms = 0) => { const id = ++seq; timers.set(id, { fn, at: now + (ms || 1), every: ms || 1 }); return id; };
  global.clearTimeout = (id) => { timers.delete(id); };
  global.clearInterval = (id) => { timers.delete(id); };
  async function tick(ms) {
    const target = now + ms;
    for (;;) {
      await drain(); // let pending promise chains queue their timers first
      let nid = 0, next = null;
      for (const [id, t] of timers) {
        if (t.at <= target && (!next || t.at < next.at || (t.at === next.at && id < nid))) { next = t; nid = id; }
      }
      if (!next) break;
      now = next.at;
      if (next.every) next.at = now + next.every; else timers.delete(nid);
      next.fn();
    }
    now = target;
    await drain();
  }
  return { tick, pending: () => timers.size };
})();

const EP = require('../web/js/edit-pane.js');

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed++;
};
const makeStatusEl = () => {
  const el = { textContent: '', errFlag: false, append() {}, appendChild() {} };
  el.classList = { toggle: (cls, on) => { if (cls === 'sn-save-err') el.errFlag = !!on; } };
  return el;
};
const deferred = () => { let res, rej; const p = new Promise((a, b) => { res = a; rej = b; }); return { p, res, rej }; };

(async () => {
  console.log('=== edit-pane units ===\n');

  // ---- autosaver-nochange-shortcut (edit-pane.js:84–88) --------------------
  {
    const el = makeStatusEl();
    let saves = 0;
    let dirtyLog = [];
    const s = EP.createAutosaver({
      getValue: () => 'same', initialValue: 'same', statusEl: el,
      save: async () => { saves++; },
      onDirty: (d) => dirtyLog.push(d),
    });
    const ok = await s.flush();
    check('nochange: flush returns true without calling save()', ok === true && saves === 0, `saves=${saves}`);
    check('nochange: onDirty(false) reported, status cleared', dirtyLog.pop() === false && el.textContent === '');
    check('nochange: isDirty() false', s.isDirty() === false);
    s.destroy();
  }

  // ---- autosaver-chase (:96–99) — typing during an in-flight save chains a
  // poke; flush resolves false until everything has settled.
  {
    const el = makeStatusEl();
    let value = 'v1';
    const calls = []; const defs = [];
    const s = EP.createAutosaver({
      getValue: () => value, initialValue: 'v0', statusEl: el,
      save: (v) => { calls.push(v); const d = deferred(); defs.push(d); return d.p; },
    });
    s.poke();
    await clock.tick(600); // debounce default
    check('chase: debounced save fired with snapshot', calls.length === 1 && calls[0] === 'v1', calls.join(','));
    check('chase: status shows saving…', el.textContent === 'saving…', el.textContent);
    value = 'v2'; // typed while the PUT is in flight
    defs[0].res();
    await drain();
    check('chase: still dirty after the stale save resolves', s.isDirty() === true);
    check('chase: no immediate second save (chase is debounced)', calls.length === 1);
    await clock.tick(600);
    check('chase: chained poke saves the newer value', calls.length === 2 && calls[1] === 'v2', calls.join(','));
    defs[1].res();
    await drain();
    check('chase: clean after the chase settles', s.isDirty() === false);

    // flush() returns false while a change raced the in-flight save…
    value = 'v3';
    const p = s.flush();
    await drain();
    value = 'v4';
    defs[2].res();
    check('chase: flush → false when typing raced the save', (await p) === false);
    await clock.tick(600);
    defs[3].res();
    await drain();
    check('chase: …and true once settled', (await s.flush()) === true && calls.length === 4, calls.join(','));
    s.destroy();
  }

  // ---- autosaver-retry-ladder (:100–115) — backoff 2,4,8,16,32,60 capped,
  // countdown ticks, success resets the attempt counter.
  {
    const el = makeStatusEl();
    let value = 'x1';
    let failing = true;
    let saves = 0;
    const s = EP.createAutosaver({
      getValue: () => value, initialValue: 'x0', statusEl: el,
      save: async () => { saves++; if (failing) { const e = new Error('boom'); e.status = 500; throw e; } },
    });
    const secsShown = () => { const m = /in (\d+)s/.exec(el.textContent); return m ? parseInt(m[1], 10) : -1; };
    s.poke();
    await clock.tick(600);
    const ladder = [secsShown()];
    check('ladder: failure is LOUD (sn-save-err set)', el.errFlag === true, el.textContent);
    check('ladder: countdown ticks down each second', (await clock.tick(1000), secsShown() === 1), el.textContent);
    // walk the remaining rungs: each retry fires when its countdown expires
    for (const expect of [4, 8, 16, 32, 60, 60]) {
      await clock.tick(secsShown() * 1000 + 1);
      ladder.push(secsShown());
      void expect;
    }
    check('ladder: 2,4,8,16,32 then capped at 60', ladder.join(',') === '2,4,8,16,32,60,60', ladder.join(','));
    check('ladder: attempt count observed (one save per rung)', saves === 7, String(saves));
    failing = false;
    await clock.tick(60 * 1000 + 1); // next retry succeeds
    check('ladder: success clears status + error class', el.textContent === '' && el.errFlag === false, el.textContent);
    check('ladder: saver clean after recovery', s.isDirty() === false);
    failing = true; value = 'x2';
    s.poke();
    await clock.tick(600);
    check('ladder: success reset the backoff (next failure back to 2s)', secsShown() === 2, el.textContent);
    s.destroy();
  }

  // ---- autosaver-fatal (:102–103) — onFatal string pins the status and
  // stops the ladder entirely.
  {
    const el = makeStatusEl();
    let saves = 0;
    const s = EP.createAutosaver({
      getValue: () => 'frozen-text', initialValue: '', statusEl: el,
      save: async () => { saves++; const e = new Error('conflict'); e.status = 409; throw e; },
      onFatal: (e) => (e.status === 409 ? 'frozen — not saved' : null),
    });
    s.poke();
    await clock.tick(600);
    check('fatal: status pinned to the onFatal string', el.textContent === 'frozen — not saved', el.textContent);
    check('fatal: marked as an error', el.errFlag === true);
    check('fatal: no retry scheduled', clock.pending() === 0, String(clock.pending()));
    await clock.tick(300000);
    check('fatal: no further save attempts', saves === 1, String(saves));
    check('fatal: flush reports unsaved (false)', (await s.flush()) === false && saves === 2);
    s.destroy();
  }

  // ---- autosaver-destroy (:130, :82) — timers cancelled; save refuses to
  // run after destroy.
  {
    const el = makeStatusEl();
    let saves = 0;
    let value = 'd1';
    const s = EP.createAutosaver({
      getValue: () => value, initialValue: 'd0', statusEl: el,
      save: async () => { saves++; const e = new Error('down'); e.status = 500; throw e; },
    });
    s.poke();
    s.destroy(); // before the debounce fires
    await clock.tick(5000);
    check('destroy: pending debounce cancelled', saves === 0, String(saves));
    check('destroy: flush after destroy → false without saving', (await s.flush()) === false && saves === 0);

    const s2 = EP.createAutosaver({
      getValue: () => 'e1', initialValue: 'e0', statusEl: makeStatusEl(),
      save: async () => { saves++; const e = new Error('down'); e.status = 500; throw e; },
    });
    s2.poke();
    await clock.tick(600); // fails → retry scheduled
    check('destroy: failure had scheduled a retry', clock.pending() > 0);
    s2.destroy();
    check('destroy: retry timers cancelled', clock.pending() === 0, String(clock.pending()));
    await clock.tick(300000);
    check('destroy: no retry after teardown', saves === 1, String(saves));
  }

  // ---- autosaver-draft-mirror (:44–51, :98, :101) --------------------------
  {
    const el = makeStatusEl();
    const KEY = 'test-draft-key';
    let value = 'w1';
    let failing = false;
    const s = EP.createAutosaver({
      getValue: () => value, initialValue: 'w0', statusEl: el, draftKey: KEY,
      save: async () => { if (failing) { const e = new Error('down'); e.status = 500; throw e; } },
    });
    s.poke();
    const draft = JSON.parse(localStorage.getItem(KEY));
    check('draft: poke mirrors the value into localStorage', draft && draft.t === 'w1' && typeof draft.at === 'number');
    await clock.tick(600); // save succeeds, no further typing
    check('draft: success + clean clears the draft', localStorage.getItem(KEY) === null);
    failing = true; value = 'w2';
    s.poke();
    await clock.tick(600); // save fails → draft rewritten
    const draft2 = JSON.parse(localStorage.getItem(KEY));
    check('draft: failure rewrites the draft with the unsaved value', draft2 && draft2.t === 'w2');
    s.destroy();
  }

  // ---- readdraft-expiry (:206–217) ----------------------------------------
  {
    localStorage.setItem('rd-fresh', JSON.stringify({ t: 'words', at: Date.now() - 1000 }));
    const fresh = EP.readDraft('rd-fresh');
    check('readDraft: fresh draft returned', fresh && fresh.t === 'words');

    localStorage.setItem('rd-old', JSON.stringify({ t: 'stale', at: Date.now() - 49 * 3600 * 1000 }));
    check('readDraft: >48h → null and key removed',
      EP.readDraft('rd-old') === null && localStorage.getItem('rd-old') === null);

    localStorage.setItem('rd-shape', JSON.stringify({ nope: 1 }));
    check('readDraft: malformed shape → null and key removed',
      EP.readDraft('rd-shape') === null && localStorage.getItem('rd-shape') === null);

    // Unparseable JSON: returns null; NOTE the key is NOT removed today (the
    // parse throws before the removeItem branch) — pinning current behavior.
    localStorage.setItem('rd-garbage', 'not json {');
    check('readDraft: unparseable → null (key left behind — current behavior)',
      EP.readDraft('rd-garbage') === null && localStorage.getItem('rd-garbage') === 'not json {');

    EP.clearDraft('rd-garbage');
    check('clearDraft removes the key', localStorage.getItem('rd-garbage') === null);
  }

  // ---- monoeditor-insertatcaret (:180–186) --------------------------------
  {
    let inputs = 0;
    const m = EP.createMonoEditor({ value: 'hello world', onInput: () => inputs++ });
    const ta = m.textarea;
    check('monoEditor: textarea seeded with the value', ta.value === 'hello world');
    ta.selectionStart = ta.selectionEnd = 5;
    m.insertAtCaret('XX');
    check('insertAtCaret: splices at the caret', ta.value === 'helloXX world', JSON.stringify(ta.value));
    check('insertAtCaret: caret lands after the insertion',
      ta.selectionStart === 7 && ta.selectionEnd === 7, `${ta.selectionStart},${ta.selectionEnd}`);
    check('insertAtCaret: dispatches input (host onInput ran)', inputs === 1, String(inputs));
    check('insertAtCaret: refocuses without scrolling',
      ta.focusedWith && ta.focusedWith.preventScroll === true);
    // Range selection is REPLACED by the insertion.
    ta.selectionStart = 0; ta.selectionEnd = 7;
    m.insertAtCaret('Hi');
    check('insertAtCaret: selection replaced', ta.value === 'Hi world' && ta.selectionStart === 2, JSON.stringify(ta.value));
    check('insertAtCaret: each insert fires exactly one input', inputs === 2, String(inputs));
  }

  // ---- tabmarkup (:199–202; 2026-08-20: newlines get ↵ spans too) ---------
  {
    check('tabMarkup: tab wrapped in sn-tab span keeping the REAL \\t',
      EP.tabMarkupHTML('a\tb') === 'a<span class="sn-tab">\t</span>b',
      JSON.stringify(EP.tabMarkupHTML('a\tb')));
    check('tabMarkup: newline wrapped in sn-nl span keeping the REAL \\n',
      EP.tabMarkupHTML('a\nb') === 'a<span class="sn-nl">\n</span>b',
      JSON.stringify(EP.tabMarkupHTML('a\nb')));
    check('tabMarkup: trailing newline wrapped AND followed by ZWSP',
      EP.tabMarkupHTML('x\n') === 'x<span class="sn-nl">\n</span>​',
      JSON.stringify(EP.tabMarkupHTML('x\n')));
    check('tabMarkup: HTML-escapes before wrapping',
      EP.tabMarkupHTML('<a & "q">\t') === '&lt;a &amp; &quot;q&quot;&gt;<span class="sn-tab">\t</span>',
      JSON.stringify(EP.tabMarkupHTML('<a & "q">\t')));
    check('tabMarkup: escape + tabs + newline spans together',
      EP.tabMarkupHTML('\ta<b\n') === '<span class="sn-tab">\t</span>a&lt;b<span class="sn-nl">\n</span>​',
      JSON.stringify(EP.tabMarkupHTML('\ta<b\n')));
  }

  console.log(failed === 0 ? '\n✅ Test passed' : `\n❌ ${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
