/**
 * Settings page: task-type management (031/032/033). Two categories —
 * TASK types and NON-TASK types — each a chip group + slug input. No type
 * name is special; notes without a type are 'n/a'. Chips: name + color dot
 * (right). Clicking a chip ARMS it: the dot turns into an × that
 * soft-deletes the type (row survives; notes keeping the value keep it —
 * the type just stops being offered). Dragging a chip within its group
 * rewrites the manual order, which is also the note dropdown's order.
 */
const WriteSysSettings = {
  types: [],

  async init() {
    this.wireInput('tt-input', true);
    this.wireInput('nt-input', false);
    // Clicking anywhere off a chip disarms any pending delete.
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.tt-chip')) this.disarmAll();
    });
    await Promise.all([this.reload(), this.reloadActions()]);
  },

  csrf() {
    return sessionStorage.getItem('csrf_token') || localStorage.getItem('csrf_token') || '';
  },

  wireInput(id, isTask) {
    const input = document.getElementById(id);
    input.addEventListener('blur', () => this.addFromInput(id, isTask));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.addFromInput(id, isTask); });
  },

  disarmAll() {
    document.querySelectorAll('.tt-chip.tt-armed').forEach((c) => c.classList.remove('tt-armed'));
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
    const live = this.types.filter((t) => !t.deleted);
    this.renderGroup('tt-chips', live.filter((t) => t.is_task));
    this.renderGroup('nt-chips', live.filter((t) => !t.is_task));
  },

  renderGroup(rootId, types) {
    const root = document.getElementById(rootId);
    root.innerHTML = '';
    const W = window.WriteSysNoteWidget;
    types.forEach((t) => {
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
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'tt-del';
      del.textContent = '×';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          const r = await fetch(`api/task-types/${encodeURIComponent(t.name)}`, {
            method: 'DELETE',
            credentials: 'same-origin',
            headers: { 'X-CSRF-Token': this.csrf() },
          });
          if (!r.ok && r.status !== 404) throw new Error(`HTTP ${r.status}`);
        } catch (err) { /* chip stays on reload if the delete failed */ }
        await this.reload();
      });
      chip.appendChild(del);
      chip.addEventListener('click', (e) => {
        if (e.target.closest('.color-dot-solo, .tt-del')) return;
        const arming = !chip.classList.contains('tt-armed');
        this.disarmAll();
        chip.classList.toggle('tt-armed', arming);
      });
      this.makeDraggable(chip, t.name, rootId);
      root.appendChild(chip);
    });
  },

  // Drag a chip onto a sibling to drop it AT that sibling's position
  // (within its own group only). The new order is written as position =
  // index over [non-tasks…, tasks…] — also the dropdown's order.
  makeDraggable(chip, name, rootId) {
    chip.draggable = true;
    chip.addEventListener('dragstart', (e) => {
      this.dragName = name;
      this.dragRoot = rootId;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', name);
    });
    chip.addEventListener('dragover', (e) => {
      if (this.dragRoot === rootId && this.dragName !== name) e.preventDefault();
    });
    chip.addEventListener('drop', async (e) => {
      e.preventDefault();
      if (this.dragRoot !== rootId || this.dragName === name) return;
      const isTaskGroup = rootId === 'tt-chips';
      const live = this.types.filter((t) => !t.deleted);
      const group = live.filter((t) => t.is_task === isTaskGroup).map((t) => t.name);
      const other = live.filter((t) => t.is_task !== isTaskGroup).map((t) => t.name);
      const from = group.indexOf(this.dragName);
      const to = group.indexOf(name);
      if (from < 0 || to < 0) return;
      group.splice(to, 0, group.splice(from, 1)[0]);
      const names = isTaskGroup ? other.concat(group) : group.concat(other);
      try {
        const r = await fetch('api/task-types/order', {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrf() },
          body: JSON.stringify({ names }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        this.types = (await r.json()).task_types || this.types;
        this.render();
      } catch (err) {
        await this.reload(); // server order wins on failure
      }
    });
  },

  async addFromInput(id, isTask) {
    const input = document.getElementById(id);
    const status = document.getElementById(isTask ? 'tt-status' : 'nt-status');
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
        body: JSON.stringify({ names, is_task: isTask }),
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

// ---- Note actions: the last 20 (points awarded / deleted / completed),
// each with an undo. Icons are the EXACT svgs the note UI's bottom row
// uses (star / trash / check).
WriteSysSettings.ACTION_ICONS = {
  points: '<svg width="14" height="14" viewBox="0 0 20 20"><path d="M10 2.5l2.3 4.7 5.2.75-3.75 3.65.9 5.15L10 14.3l-4.65 2.45.9-5.15L2.5 7.95l5.2-.75z" stroke="currentColor" fill="none" stroke-width="1.4" stroke-linejoin="round"/></svg>',
  deleted: '<svg width="14" height="14" viewBox="0 0 20 20"><path d="M6 2h8M3 5h14M5 5l1 12h8l1-12M8 8v6M12 8v6" stroke="currentColor" fill="none" stroke-width="1.5" stroke-linecap="round"/></svg>',
  completed: '<svg width="14" height="14" viewBox="0 0 20 20"><path d="M4 10l4 4 8-8" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

WriteSysSettings.reloadActions = async function () {
  const status = document.getElementById('na-status');
  let actions;
  try {
    const r = await fetch('api/note-actions', { credentials: 'same-origin' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    actions = (await r.json()).actions || [];
  } catch (e) {
    status.textContent = 'Failed to load note actions.';
    return;
  }
  const rows = document.getElementById('na-rows');
  rows.innerHTML = '';
  status.textContent = actions.length ? '' : 'No actions yet.';
  actions.forEach((a) => {
    const tr = document.createElement('tr');
    tr.className = `na-row na-${a.kind}`;
    const d = new Date(a.at);
    const when = document.createElement('td');
    when.className = 'na-when';
    when.textContent = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      + ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    tr.appendChild(when);
    const prev = document.createElement('td');
    prev.className = 'na-prev';
    prev.textContent = a.body || '(no text)';
    tr.appendChild(prev);
    const icon = document.createElement('td');
    icon.className = 'na-icon';
    icon.innerHTML = this.ACTION_ICONS[a.kind] || '';
    tr.appendChild(icon);
    const undoTd = document.createElement('td');
    undoTd.className = 'na-undo-cell';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'na-undo';
    const req = { credentials: 'same-origin', headers: { 'X-CSRF-Token': this.csrf() } };
    if (a.kind === 'points') {
      btn.textContent = `unaward ${a.points} point${a.points === 1 ? '' : 's'}`;
      btn.onclick = () => fetch(`api/point-events/${a.event_id}`, { ...req, method: 'DELETE' }).then(() => this.reloadActions());
    } else if (a.kind === 'deleted') {
      btn.textContent = 'undo delete';
      btn.onclick = () => fetch(`api/notes/${a.note_id}/restore`, { ...req, method: 'POST' }).then(() => this.reloadActions());
    } else {
      btn.textContent = 'undo complete';
      btn.onclick = () => fetch(`api/notes/${a.note_id}/uncomplete`, { ...req, method: 'POST' }).then(() => this.reloadActions());
    }
    undoTd.appendChild(btn);
    tr.appendChild(undoTd);
    rows.appendChild(tr);
  });
};

if (typeof window !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => WriteSysSettings.init());
}
