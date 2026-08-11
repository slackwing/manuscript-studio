/**
 * Loader for THE scratchpad modal (HOME_PLAN.md). Classic script so any
 * page can call window.WriteSysScratchpadModal.open(id); the ProseMirror
 * bundle and modal module lazy-load on first open — the book page pays
 * nothing until a pad is summoned. Also restores a pad from the URL
 * (#scratchpad=N) on load.
 */
const WriteSysScratchpadModal = {
  _mod: null,

  async _load() {
    if (!this._mod) {
      this._mod = await import(new URL('scratchpad/modal.mjs?v=55', document.baseURI).href);
    }
    return this._mod;
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
    const h = window.location.hash || '';
    const sp = h.match(/[#&]scratchpad=(\d+)/);
    if (!sp) return;
    const snM = h.match(/[#&]sketch=([a-z0-9]+)/i);
    const ordM = h.match(/[#&]variation=(\d+)/);
    const spid = parseInt(sp[1], 10);
    if (this._mod && this._mod.ScratchpadModal.currentId() === spid) {
      // Same pad already open — just scroll to the variation, if any.
      if (snM && ordM) this._mod.ScratchpadModal.scrollToVariationWidget(snM[1], parseInt(ordM[1], 10));
    } else {
      this.open(spid);
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
