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
      this._mod = await import(new URL('scratchpad/modal.mjs?v=5', document.baseURI).href);
    }
    return this._mod;
  },

  async open(scratchpadId) {
    const mod = await this._load();
    return mod.ScratchpadModal.open(scratchpadId);
  },

  async close() {
    if (!this._mod) return;
    return this._mod.ScratchpadModal.close();
  },

  restoreFromHash() {
    const m = (window.location.hash || '').match(/^#scratchpad=(\d+)$/);
    if (m) this.open(parseInt(m[1], 10));
  },
};

if (typeof window !== 'undefined') {
  window.WriteSysScratchpadModal = WriteSysScratchpadModal;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => WriteSysScratchpadModal.restoreFromHash());
  } else {
    WriteSysScratchpadModal.restoreFromHash();
  }
}
