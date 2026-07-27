/**
 * THE scratchpad modal (HOME_PLAN.md): the single host for the scratchpad
 * editor, summonable over the landing page or an open manuscript. Only one
 * open at a time — by construction. The open pad rides the URL
 * (#scratchpad=N) so a reload restores it. Close flushes autosave.
 */
import { createScratchpadEditor, setCurrentScratchpadId } from './editor-core.mjs?v=9';

function ensureCSS() {
  if (document.getElementById('scratchpad-css')) return;
  const link = document.createElement('link');
  link.id = 'scratchpad-css';
  link.rel = 'stylesheet';
  link.href = 'scratchpad/scratchpad.css?v=15';
  document.head.appendChild(link);
}

export const ScratchpadModal = {
  editor: null,
  overlay: null,
  opening: null,

  async open(scratchpadId) {
    // Serialize opens; close any current pad first (flushes its save).
    while (this.opening) await this.opening;
    this.opening = this._open(scratchpadId).finally(() => { this.opening = null; });
    return this.opening;
  },

  _currentId: 0,
  currentId() { return this.overlay ? this._currentId : 0; },

  async _open(scratchpadId) {
    await this.close();
    // close() refuses when a save keeps failing — don't stack a second pad.
    if (this.overlay) return;
    ensureCSS();
    // A newly-created sketch is homed in this scratchpad.
    setCurrentScratchpadId(scratchpadId);

    const overlay = document.createElement('div');
    overlay.className = 'spm-overlay';
    overlay.innerHTML = `
      <div class="spm-dialog" role="dialog" aria-label="Scratchpad">
        <div class="spm-header">
          <input id="spm-title" class="spm-title" type="text" placeholder="Untitled" autocomplete="off">
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
    // modal is not a navigation). Preserve a &sketch= deep-link if present so
    // it isn't clobbered before scrollToSketchWidget reads it.
    const url = new URL(window.location.href);
    const sketchM = (url.hash || '').match(/[#&]sketch=(\d+)/);
    url.hash = `scratchpad=${scratchpadId}` + (sketchM ? `&sketch=${sketchM[1]}` : '');
    history.replaceState(null, '', url);
    // Landing-page recency stamp (fire-and-forget; cards sort by this).
    fetch(`api/scratchpads/${scratchpadId}/opened`, {
      method: 'POST',
      headers: { 'X-CSRF-Token': sessionStorage.getItem('csrf_token') || '' },
    }).catch(() => {});
    window.WriteSysScratchpad = this.editor; // test / power-user hook
    window.dispatchEvent(new CustomEvent('scratchpad-modal-opened', { detail: { scratchpadId } }));

    // Deep link: #scratchpad=N&sketch=ID scrolls to that sketch's widget (the
    // peer preview's "navigate to source"). Retry briefly while widgets mount.
    const m = (window.location.hash || '').match(/[#&]sketch=(\d+)/);
    if (m) this.scrollToSketchWidget(parseInt(m[1], 10));
  },

  // Scroll the open scratchpad to the widget whose sketch id matches (its
  // NodeView sets data-sketch-id / data-variation-id on the dom).
  scrollToSketchWidget(sketchId) {
    if (!(sketchId > 0)) return;
    let tries = 0;
    const tick = () => {
      const el = this.overlay && this.overlay.querySelector(
        `.sn-widget[data-sketch-id="${sketchId}"], .sn-widget[data-variation-id="${sketchId}"]`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('sn-flash');
        setTimeout(() => el.classList.remove('sn-flash'), 1600);
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
