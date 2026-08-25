/**
 * Loader for THE scratchpad modal (HOME_PLAN.md). Classic script so any
 * page can call window.WriteSysScratchpadModal.open(id); the ProseMirror
 * bundle and modal module lazy-load on first open — the book page pays
 * nothing until a pad is summoned. Also restores a pad from the URL
 * (#scratchpad=N) on load.
 */
const WriteSysScratchpadModal = {
  _mod: null,   // resolved module (sync checks: close(), restoreFromHash)
  _modP: null,  // the ONE import() promise — concurrent first opens must
                // share it, not race two imports (the loser's open could
                // land last and steal the "second open wins" contract).

  async _load() {
    if (!this._modP) {
      this._modP = import(new URL('scratchpad/modal.mjs?v=75', document.baseURI).href)
        .then((m) => { this._mod = m; return m; });
    }
    return this._modP;
  },

  // ONE grammar for the pad deep-link hash — modal.mjs (writer) and
  // restoreFromHash (reader) both parse through here.
  parseHash(h) {
    h = h || '';
    const sp = h.match(/[#&]scratchpad=(\d+)/);
    const sk = h.match(/[#&]sketch=([a-z0-9]+)/i);
    const ord = h.match(/[#&]variation=(\d+)/);
    return {
      scratchpadId: sp ? parseInt(sp[1], 10) : 0,
      sketchId: sk ? sk[1] : null,
      ordinal: ord ? parseInt(ord[1], 10) : 0,
    };
  },

  async open(scratchpadId, opts) {
    const mod = await this._load();
    return mod.ScratchpadModal.open(scratchpadId, opts);
  },

  async close() {
    if (!this._mod) return;
    return this._mod.ScratchpadModal.close();
  },

  // Restore/react to the URL hash. Accepts #scratchpad=N and the deep-link form
  // #scratchpad=N&variation=ID (navigate-to-source). If a pad is already open,
  // just scroll to the variation; otherwise open the pad (which then scrolls).
  restoreFromHash() {
    const dl = this.parseHash(window.location.hash);
    if (!dl.scratchpadId) return;
    if (this._mod && this._mod.ScratchpadModal.currentId() === dl.scratchpadId) {
      // Same pad already open — just scroll to the variation, if any.
      if (dl.sketchId && dl.ordinal) this._mod.ScratchpadModal.scrollToVariationWidget(dl.sketchId, dl.ordinal);
    } else {
      this.open(dl.scratchpadId);
    }
  },
};

if (typeof window !== 'undefined') {
  window.WriteSysScratchpadModal = WriteSysScratchpadModal;
  const restore = () => WriteSysScratchpadModal.restoreFromHash();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', restore);
  } else {
    restore();
  }
  window.addEventListener('hashchange', restore);
}
