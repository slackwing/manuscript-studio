/**
 * THE scratchpad modal (HOME_PLAN.md): the single host for the scratchpad
 * editor, summonable over the landing page or an open manuscript. Only one
 * open at a time — by construction. The open pad rides the URL
 * (#scratchpad=N) so a reload restores it. Close flushes autosave.
 */
import { createScratchpadEditor, setCurrentScratchpadId, suspendScrollHolds } from './editor-core.mjs?v=73';

function ensureCSS() {
  if (document.getElementById('scratchpad-css')) return;
  const link = document.createElement('link');
  link.id = 'scratchpad-css';
  link.rel = 'stylesheet';
  link.href = 'scratchpad/scratchpad.css?v=54';
  document.head.appendChild(link);
}

export const ScratchpadModal = {
  editor: null,
  overlay: null,
  opening: null,

  // opts.noteId — after opening, scroll to that note's inline anchor and flash it
  // (deep-link from the landing Notes grid).
  async open(scratchpadId, opts) {
    // Serialize opens; close any current pad first (flushes its save).
    while (this.opening) await this.opening;
    this.opening = this._open(scratchpadId, opts || {}).finally(() => { this.opening = null; });
    return this.opening;
  },

  _currentId: 0,
  currentId() { return this.overlay ? this._currentId : 0; },

  async _open(scratchpadId, opts) {
    opts = opts || {};
    await this.close();
    // close() refuses when a save keeps failing — don't stack a second pad.
    if (this.overlay) return;
    ensureCSS();
    // A newly-created variation is homed in this scratchpad.
    setCurrentScratchpadId(scratchpadId);

    const overlay = document.createElement('div');
    overlay.className = 'spm-overlay';
    overlay.innerHTML = `
      <div class="spm-dialog" role="dialog" aria-label="Scratchpad">
        <div class="spm-header">
          <input id="spm-title" class="spm-title" type="text" placeholder="Untitled" autocomplete="off">
          <span id="spm-link" tabindex="0" role="button"></span>
          <span class="spm-header-spacer"></span>
          <span id="spm-status" class="spm-status">Saved</span>
          <button type="button" id="spm-expand" title="Expand">⤢</button>
          <button type="button" id="spm-close" title="Close (Esc)">×</button>
        </div>
        <div id="spm-toolbar" class="sp-toolbar spm-toolbar"></div>
        <div id="spm-editor" class="spm-editor"></div>
        <input type="file" id="spm-image-input" accept="image/png,image/jpeg,image/gif,image/webp" hidden>
      </div>`;
    document.body.appendChild(overlay);
    this.overlay = overlay;

    overlay.querySelector('#spm-close').addEventListener('click', () => this.close());
    // Clicking the backdrop closes too (the guard below still flushes —
    // and refuses to close — before anything is lost).
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) this.close();
    });
    overlay.querySelector('#spm-expand').addEventListener('click', () =>
      overlay.querySelector('.spm-dialog').classList.toggle('spm-full'));
    this._esc = (e) => { if (e.key === 'Escape') this.close(); };
    document.addEventListener('keydown', this._esc);

    try {
      this.editor = await createScratchpadEditor({
        titleInput: overlay.querySelector('#spm-title'),
        statusEl: overlay.querySelector('#spm-status'),
        toolbarEl: overlay.querySelector('#spm-toolbar'),
        editorEl: overlay.querySelector('#spm-editor'),
        imageInput: overlay.querySelector('#spm-image-input'),
      }, scratchpadId);
    } catch (e) {
      overlay.querySelector('#spm-editor').innerHTML =
        `<p style="color:#b33b3a;font:13px Helvetica,sans-serif;padding:20px">Failed to open scratchpad: ${String(e.message).replace(/</g, '&lt;')}</p>`;
    }

    this._currentId = scratchpadId;
    // The open pad rides the URL so reload restores it (replaceState — a
    // modal is not a navigation). Preserve a &sketch=&variation= deep-link if
    // present so it isn't clobbered before scrollToVariationWidget reads it.
    // (ONE hash grammar — the loader's parseHash; scratchpad-modal.js.)
    const url = new URL(window.location.href);
    const dl = window.WriteSysScratchpadModal.parseHash(url.hash);
    url.hash = `scratchpad=${scratchpadId}` +
      (dl.sketchId && dl.ordinal ? `&sketch=${dl.sketchId}&variation=${dl.ordinal}` : '');
    history.replaceState(null, '', url);
    // Landing-page recency stamp (fire-and-forget; cards sort by this).
    fetch(`api/scratchpads/${scratchpadId}/opened`, {
      method: 'POST',
      headers: { 'X-CSRF-Token': window.getCSRFToken() || '' },
    }).catch(() => {});
    window.WriteSysScratchpad = this.editor; // test / power-user hook
    this.setupManuscriptLink(scratchpadId);
    window.dispatchEvent(new CustomEvent('scratchpad-modal-opened', { detail: { scratchpadId } }));

    // Deep link: #scratchpad=N&sketch=ID&variation=ORDINAL scrolls to that
    // variation's widget (the peer preview's "navigate to source"). Identity is
    // (sketch, ordinal). Retry briefly while widgets mount.
    if (dl.sketchId && dl.ordinal) this.scrollToVariationWidget(dl.sketchId, dl.ordinal);

    // Deep link from the landing Notes grid: scroll to the note's inline anchor.
    if (opts.noteId) this.scrollToNoteAnchor(opts.noteId);
  },

  // The scratchpad's manuscript-link control in the header. Linking the pad
  // makes NEW notes/sketches in it inherit the manuscript by default (live
  // default, not retroactive). Reuses the shared note-widget manuscript picker.
  async setupManuscriptLink(scratchpadId) {
    const el = this.overlay && this.overlay.querySelector('#spm-link');
    if (!el || !window.WriteSysNoteWidget) return;
    let linkedId = null, linkedName = '';
    try {
      const r = await fetch(`api/scratchpads/${scratchpadId}`, { credentials: 'same-origin' });
      if (r.ok) {
        const d = await r.json();
        linkedId = (d.scratchpad && d.scratchpad.linked_manuscript_id) || null;
        linkedName = (d.scratchpad && d.scratchpad.linked_manuscript_name) || '';
      }
    } catch (e) { /* leave unlinked */ }

    const HINT = 'Link scratchpad to manuscript. Causes all NEW elements (sketches, notes, etc.) in the scratchpad to be linked to the manuscript by default.';
    const put = async (mid) => {
      const r = await fetch(`api/scratchpads/${scratchpadId}/link`, {
        method: 'PUT', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window.getCSRFToken() || '' },
        body: JSON.stringify({ manuscript_id: mid }),
      });
      return r.ok ? r.json() : Promise.reject(new Error('link ' + r.status));
    };

    // THE shared manuscript chip (js/manuscript-chip.js) — identical look and
    // behavior to sketch widgets and note cards.
    const render = () => {
      el.innerHTML = '';
      const chip = window.WriteSysManuscriptChip.build({
        linkedId: linkedId,
        linkedName: linkedName,
        hintLinked: 'Linked to ' + linkedName + ' — new elements inherit it. Click × to unlink.',
        hintUnlinked: HINT,
        onUnlink: async () => {
          try { await put(0); linkedId = null; linkedName = ''; render(); }
          catch (err) { alert('Could not unlink scratchpad: ' + err.message); }
        },
        onPick: async (mid) => {
          // Don't leave the UI showing "linked" if the write failed — surface it.
          try { const d = await put(mid); linkedId = d.linked_manuscript_id || null; linkedName = d.linked_manuscript_name || ''; render(); }
          catch (err) { alert('Could not link scratchpad: ' + err.message); }
        },
        extraClass: 'spm-link-chip', // hook only
      });
      if (chip) el.appendChild(chip);
    };
    render();
  },

  // Scroll to a note's inline anchor square and flash it. Sketch widgets around
  // the note load ASYNC and grow after mounting, which shifts the note's
  // position — so once found, re-scroll a few times as layout settles, then a
  // final smooth pass, so we actually land on the note (not short of it).
  scrollToNoteAnchor(noteId) {
    if (!noteId) return;
    const sel = `.sn-note-ref[data-note-id="${CSS.escape(String(noteId))}"]`;
    const find = () => this.overlay && this.overlay.querySelector(sel);
    let tries = 0;
    const waitForEl = () => {
      const el = find();
      if (el && window.msScrollDiag) window.msScrollDiag.push('scroll-to-note', { noteId });
      if (el) return this.settleScrollTo(el, () => {
        el.classList.add('sn-note-anchor-flash');
        setTimeout(() => el.classList.remove('sn-note-anchor-flash'), 1600);
      });
      if (++tries < 40) setTimeout(waitForEl, 150);
    };
    setTimeout(waitForEl, 200);
  },

  // Scroll `el` to center, re-correcting as async content settles (widgets
  // mounting/growing shift positions for a while after the first scroll). Snaps
  // instantly a few times, then a final smooth pass, then runs `done`.
  settleScrollTo(el, done) {
    let n = 0;
    const step = () => {
      if (!el.isConnected) return;
      const last = n >= 6;
      // This scroll is DELIBERATE — widget-render scroll holds must follow it,
      // not fight it (suspension covers the smooth pass and the tail of async
      // widget growth).
      suspendScrollHolds(1500);
      if (window.msScrollDiag) window.msScrollDiag.push('settle-step', { n, last });
      el.scrollIntoView({ behavior: last ? 'smooth' : 'auto', block: 'center' });
      if (last) { if (done) done(); return; }
      n++;
      setTimeout(step, 120);
    };
    step();
  },

  // Scroll the open scratchpad to the widget for (sketch, ordinal). The
  // NodeView tags each widget with data-sketch-id + data-ordinal.
  scrollToVariationWidget(sketchId, ordinal) {
    if (!sketchId || !(ordinal > 0)) return;
    let tries = 0;
    const tick = () => {
      const el = this.overlay && this.overlay.querySelector(
        `.sn-widget[data-sketch-id="${CSS.escape(sketchId)}"][data-ordinal="${ordinal}"]`);
      if (el) {
        if (window.msScrollDiag) window.msScrollDiag.push('scroll-to-widget', { sketchId, ordinal });
        suspendScrollHolds(3200); // deliberate scroll — holds follow, not fight
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('sn-flash');
        setTimeout(() => el.classList.remove('sn-flash'), 2400);
        // Widgets ABOVE the target may still be mounting — each mount shifts
        // the layout and drags the target away from where the first scroll
        // left it. Re-pin (instant, no visible fighting) while things settle.
        [700, 1400, 2200].forEach((ms) => setTimeout(() => {
          if (el.isConnected) el.scrollIntoView({ behavior: 'auto', block: 'center' });
        }, ms));
        return;
      }
      if (++tries < 30) setTimeout(tick, 200);
    };
    setTimeout(tick, 300);
  },

  async close() {
    if (!this.overlay) return;
    // Flush before closing; a failed save keeps the pad open (the status
    // slot shows the retry countdown) so nothing is ever lost.
    if (this.editor && this.editor.isDirty()) {
      const ok = await this.editor.saveNow();
      if (!ok) return;
    }
    const overlay = this.overlay;
    this.overlay = null;
    document.removeEventListener('keydown', this._esc);
    if (this.editor) {
      try { await this.editor.destroy(); } catch (e) { console.error('flush on close failed', e); }
      this.editor = null;
    }
    overlay.remove();
    window.WriteSysScratchpad = null;
    if ((window.location.hash || '').startsWith('#scratchpad=')) {
      const url = new URL(window.location.href);
      url.hash = '';
      history.replaceState(null, '', url);
    }
    window.dispatchEvent(new CustomEvent('scratchpad-modal-closed'));
  },
};
