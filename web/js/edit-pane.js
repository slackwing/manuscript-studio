/**
 * WriteSysEditPane — the SHARED monospace edit pane machinery, used by BOTH
 * the scratchpad snippet widget (mode SNIPPET) and the manuscript's
 * suggest-edit modal (mode SUGGESTED_EDIT). One implementation of the things
 * that must never diverge again:
 *
 *   - autosave-as-you-type (debounced), so accidental closes lose nothing;
 *   - the retry ladder (2s → 60s backoff with a live countdown) on failure;
 *   - dirty tracking + flush() so hosts can refuse to close while unsaved;
 *   - the session-expired re-login link on 401 (session-guard.js);
 *   - the auto-growing monospace textarea (never scrolls internally).
 *
 * Mode differences stay in the HOSTS as thin wiring (Tab-inserts-\t and the
 * tab-glyph overlay for snippets; §/¶ glyph conversion for suggest-edit) —
 * the pane takes callbacks, not flags, wherever practical.
 */
(function () {
  'use strict';

  // ---- autosaver -----------------------------------------------------------
  // createAutosaver({ getValue, save, statusEl, debounceMs, onDirty, onSaved,
  //                   onFatal }):
  //   getValue()        → current UI value (storage form)
  //   save(text)        → async; performs the write; throw err (.status) on fail
  //   statusEl          → element whose textContent shows saving…/failure text
  //   onDirty(bool)     → dirty-state transitions (host tracks its registry)
  //   onSaved(text, changed) → after a successful save
  //   onFatal(err)      → return a STATUS STRING to stop retrying and pin that
  //                       text (e.g. 409 "frozen — not saved"); return null to
  //                       use the retry ladder.
  // returns { poke, flush, isDirty, destroy }
  function createAutosaver(opts) {
    const statusEl = opts.statusEl;
    const debounceMs = opts.debounceMs || 600;
    let lastSaved = opts.initialValue;
    let t = null, retryTimer = null, countdown = null;
    let attempt = 0;
    let destroyed = false;

    // LOCAL DRAFT SAFETY NET: every keystroke mirrors the text into
    // localStorage (per draftKey); a successful save clears it. Whatever
    // kills the saves — CSRF skew, expiry, network, a crash, a reload —
    // the words survive on THIS machine and the host restores them.
    const draftWrite = (v) => {
      if (!opts.draftKey) return;
      try { localStorage.setItem(opts.draftKey, JSON.stringify({ t: v, at: Date.now() })); } catch (_) {}
    };
    const draftClear = () => {
      if (!opts.draftKey) return;
      try { localStorage.removeItem(opts.draftKey); } catch (_) {}
    };

    const clearRetry = () => {
      clearTimeout(retryTimer); retryTimer = null;
      clearInterval(countdown); countdown = null;
    };
    const setStatus = (text, failing) => {
      if (!statusEl) return;
      statusEl.textContent = text;
      // A failing save must be LOUD — the tiny grey status was overlooked
      // for four minutes of lost writing once.
      statusEl.classList.toggle('sn-save-err', !!failing);
    };
    const appendRelogin = () => {
      if (!statusEl || !window.WriteSysSessionGuard) return;
      statusEl.append(' · ');
      const a = document.createElement('a');
      a.href = '#';
      a.textContent = 'Session expired — log in';
      a.style.cssText = 'color:#a33;text-decoration:underline;cursor:pointer;';
      a.addEventListener('click', (e) => {
        e.preventDefault();
        window.WriteSysSessionGuard.requireLogin();
      });
      statusEl.appendChild(a);
    };

    const dirty = () => opts.getValue() !== lastSaved;

    const save = async () => {
      clearTimeout(t); clearRetry();
      if (destroyed) return false;
      const value = opts.getValue();
      if (value === lastSaved) {
        if (opts.onDirty) opts.onDirty(false);
        setStatus('');
        return true;
      }
      setStatus('saving…');
      try {
        await opts.save(value);
        lastSaved = value;
        attempt = 0;
        setStatus('');
        if (opts.onDirty) opts.onDirty(dirty());
        if (opts.onSaved) opts.onSaved(value, true);
        // Typed more while the save was in flight → chase it.
        if (dirty()) poke(); else draftClear();
        return !dirty();
      } catch (e) {
        draftWrite(value);
        const fatal = opts.onFatal && opts.onFatal(e);
        if (fatal) { setStatus(fatal, true); return false; }
        attempt = Math.min(attempt + 1, 6);
        let secs = Math.min(60, Math.pow(2, attempt));
        const authFail = e.status === 401;
        const show = () => {
          setStatus(`Failed to save. Trying again in ${secs}s`, true);
          if (authFail) appendRelogin();
        };
        show();
        countdown = setInterval(() => { secs -= 1; if (secs > 0) show(); }, 1000);
        retryTimer = setTimeout(() => { clearRetry(); save(); }, secs * 1000);
        return false;
      }
    };

    const poke = () => {
      if (opts.onDirty) opts.onDirty(true);
      draftWrite(opts.getValue());
      clearTimeout(t); clearRetry();
      t = setTimeout(save, debounceMs);
    };

    return {
      poke,
      flush: save,          // returns true when everything is saved
      isDirty: dirty,
      setSavedValue(v) { lastSaved = v; },
      destroy() { destroyed = true; clearTimeout(t); clearRetry(); },
    };
  }

  // ---- monospace auto-grow editor -----------------------------------------
  // createMonoEditor({ value, placeholder, onInput, overlayHTML }):
  //   builds .sn-text-wrap > [.sn-text-overlay?, textarea.sn-text]; the
  //   textarea auto-grows (never scrolls internally — the host scrolls).
  //   overlayHTML(value) → mirror markup (the snippet tab-glyph overlay);
  //   omit for no overlay (suggest-edit shows glyphs as literal chars).
  // returns { wrap, textarea, autoGrow, insertAtCaret }
  function createMonoEditor(opts) {
    const wrap = document.createElement('div');
    wrap.className = 'sn-text-wrap';
    let overlay = null;
    if (opts.overlayHTML) {
      overlay = document.createElement('div');
      overlay.className = 'sn-text-overlay';
      overlay.setAttribute('aria-hidden', 'true');
      wrap.appendChild(overlay);
    }
    const ta = document.createElement('textarea');
    ta.className = 'sn-text';
    ta.spellcheck = false;
    if (opts.placeholder) ta.placeholder = opts.placeholder;
    ta.value = opts.value || '';
    ta.rows = Math.max(6, (opts.value || '').split('\n').length + 2);
    const autoGrow = () => {
      // Pin the wrap's height while the textarea is momentarily 'auto': the
      // instant collapse shrinks the scroll host's content, and a reader
      // scrolled near the bottom gets their scrollTop CLAMPED up — the
      // "every keystroke scrolls the pad" bug. All synchronous, so the pin
      // never renders.
      wrap.style.minHeight = wrap.offsetHeight + 'px';
      ta.style.height = 'auto';
      ta.style.height = ta.scrollHeight + 'px';
      wrap.style.minHeight = '';
      if (overlay && opts.overlayHTML) overlay.innerHTML = opts.overlayHTML(ta.value);
    };
    ta.addEventListener('input', () => {
      autoGrow();
      if (opts.onInput) opts.onInput();
    });
    // Alt+D types today's date at the caret — same shortcut as the pad prose.
    ta.addEventListener('keydown', (e) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.code === 'KeyD' || e.key === 'd' || e.key === 'D')) {
        e.preventDefault();
        insertAtCaret(dateString());
      }
    });
    const insertAtCaret = (text) => {
      const s = ta.selectionStart, e = ta.selectionEnd;
      ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
      ta.selectionStart = ta.selectionEnd = s + text.length;
      ta.focus({ preventScroll: true });
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    };
    wrap.appendChild(ta);
    return { wrap, textarea: ta, autoGrow, insertAtCaret };
  }

  // tabMarkupHTML mirrors a textarea's raw value into overlay HTML, rendering
  // each literal tab as a faint grey → glyph so \t whitespace is visible. The
  // span keeps the REAL tab character (identical width to the textarea's own
  // tab, given the shared tab-size); the → paints via CSS ::before with zero
  // advance width. A trailing newline gets a zero-width space so the overlay's
  // last line keeps height.
  const escHTML = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  function tabMarkupHTML(value) {
    const withNL = value.endsWith('\n') ? value + '\u200b' : value;
    return escHTML(withNL).replace(/\t/g, '<span class="sn-tab">\t</span>');
  }

  // readDraft(key): the crash-recovery counterpart of the autosaver's draft
  // mirror. Returns { t, at } or null; drafts older than 48h are discarded.
  function readDraft(key) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const d = JSON.parse(raw);
      if (!d || typeof d.t !== 'string' || Date.now() - d.at > 48 * 3600 * 1000) {
        localStorage.removeItem(key);
        return null;
      }
      return d;
    } catch (_) { return null; }
  }
  function clearDraft(key) {
    try { localStorage.removeItem(key); } catch (_) {}
  }

  // The Alt+D date: "Saturday, August 1" (weekday, month day — no year).
  function dateString(d) {
    return (d || new Date()).toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric',
    });
  }

  window.WriteSysEditPane = { createAutosaver, createMonoEditor, tabMarkupHTML, dateString, readDraft, clearDraft };
})();
