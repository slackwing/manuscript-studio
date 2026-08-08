/**
 * Settings page: task-type management (031/032). Types render as chips —
 * one color dot each (the shared sticky-note picker component) — and the
 * input adds new custom types as space-separated lowercase slugs on
 * Enter/blur. Colors: gray = inert; a real color means "picking this type
 * recolors the note".
 */
const WriteSysSettings = {
  types: [],

  async init() {
    const input = document.getElementById('tt-input');
    input.addEventListener('blur', () => this.addFromInput());
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.addFromInput(); });
    await this.reload();
  },

  csrf() {
    return sessionStorage.getItem('csrf_token') || localStorage.getItem('csrf_token') || '';
  },

  async reload() {
    try {
      const r = await fetch('api/task-types', { credentials: 'same-origin' });
      this.types = (await r.json()).task_types || [];
    } catch (e) {
      document.getElementById('tt-status').textContent = 'Failed to load task types.';
      return;
    }
    this.render();
  },

  render() {
    const root = document.getElementById('tt-chips');
    root.innerHTML = '';
    const W = window.WriteSysNoteWidget;
    this.types.forEach((t) => {
      const chip = document.createElement('div');
      chip.className = 'tag-chip tt-chip' + (t.built_in ? ' tt-builtin' : '');
      const name = document.createElement('span');
      name.textContent = t.name;
      chip.appendChild(name);
      const dot = W.buildColorDot({
        colors: ['gray', 'yellow', 'green', 'blue', 'purple', 'red', 'orange'],
        current: t.color || 'gray',
        // Throwing on failure makes buildColorDot revert the dot — the dot
        // must never show a color the server didn't accept.
        onPick: async (color) => {
          const r = await fetch(`api/task-types/${encodeURIComponent(t.name)}/color`, {
            method: 'PUT',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrf() },
            body: JSON.stringify({ color }),
          });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          t.color = color;
        },
      });
      chip.appendChild(dot);
      root.appendChild(chip);
    });
  },

  async addFromInput() {
    const input = document.getElementById('tt-input');
    const status = document.getElementById('tt-status');
    const names = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!names.length) return;
    const bad = names.filter((n) => !/^[a-z0-9][a-z0-9-]{0,39}$/.test(n));
    if (bad.length) {
      status.textContent = `Not lowercase slugs: ${bad.join(', ')}`;
      return;
    }
    try {
      const r = await fetch('api/task-types', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrf() },
        body: JSON.stringify({ names }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      this.types = (await r.json()).task_types || this.types;
      input.value = '';
      status.textContent = '';
      this.render();
    } catch (e) {
      status.textContent = 'Failed to add: ' + e.message;
    }
  },
};

if (typeof window !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => WriteSysSettings.init());
}
