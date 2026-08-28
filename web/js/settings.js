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
    await Promise.all([this.reload(), this.reloadActions(), this.initRules(),
      this.reloadSuggestionHistory()]);
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

// ---- Daily task rules: each rule ANDs its selectors (unset = any) and
// caps how many matching tasks the daily page shows (-1 = unlimited).
// The builder row wears the NOTE's own chips: type / priority / blast
// radius dropdowns, the blocked circle, a color dot sized like the
// blocked icon, +tags — then the max count and Add.
WriteSysSettings.rulesBuilder = { task_type: null, priority: null, impact: null, blocked: null, color: null, tags: [] };

WriteSysSettings.initRules = async function () {
  await Promise.all([this.renderRuleBuilder(), this.reloadRules()]);
};

WriteSysSettings.reloadRules = async function () {
  const list = document.getElementById('dr-list');
  try {
    const r = await fetch('api/daily-rules', { credentials: 'same-origin' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    this.rules = (await r.json()).rules || [];
  } catch (e) {
    document.getElementById('dr-status').textContent = 'Failed to load rules.';
    return;
  }
  list.innerHTML = '';
  document.getElementById('dr-status').textContent = this.rules.length ? '' : 'No rules — the daily page shows any 16 tasks.';
  this.rules.forEach((rule) => {
    const row = document.createElement('div');
    row.className = 'dr-row dr-rule';
    const chip = (text, cls) => {
      const c = document.createElement('span');
      c.className = 'tag-chip dim-chip ' + (cls || '');
      c.textContent = text;
      row.appendChild(c);
    };
    if (rule.task_type) chip(rule.task_type, 'dim-type');
    if (rule.priority) chip(rule.priority, 'dim-priority');
    if (rule.impact) chip(rule.impact, 'dim-impact');
    if (rule.blocked) chip('⊘ blocked', 'dim-blocked-ro');
    if (rule.color) {
      const dot = document.createElement('span');
      dot.className = 'dr-colordot';
      dot.style.background = `var(--highlight-${rule.color})`;
      row.appendChild(dot);
    }
    (rule.tags || []).forEach((t) => chip(t, ''));
    const n = document.createElement('span');
    n.className = 'dr-count-label';
    n.textContent = rule.max_per_day === -1 ? '∞ / day' : `≤ ${rule.max_per_day} / day`;
    row.appendChild(n);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'tt-del dr-del';
    del.textContent = '×';
    del.addEventListener('click', async () => {
      try {
        await fetch(`api/daily-rules/${rule.rule_id}`, {
          method: 'DELETE', credentials: 'same-origin',
          headers: { 'X-CSRF-Token': this.csrf() },
        });
      } catch (e) { /* reload shows the truth */ }
      this.reloadRules();
    });
    row.appendChild(del);
    list.appendChild(row);
  });
};

WriteSysSettings.renderRuleBuilder = async function () {
  const W = window.WriteSysNoteWidget;
  const b = this.rulesBuilder;
  const host = document.getElementById('dr-builder');
  host.innerHTML = '';
  const rerender = () => this.renderRuleBuilder();

  // The SHARED criteria chip-row (note-widget.js) — the identical selectors
  // the All-notes search filters use. Rule-only extras (count + Add) follow.
  W.buildCriteriaRow(host, b, rerender);

  const count = document.createElement('input');
  count.type = 'number';
  count.className = 'dr-count';
  count.min = '-1';
  count.max = '16';
  count.value = String(b.max ?? 1);
  count.title = 'Max matching tasks per day (-1 = unlimited)';
  count.addEventListener('change', () => { b.max = parseInt(count.value, 10); });
  host.appendChild(count);

  const add = document.createElement('button');
  add.type = 'button';
  add.id = 'dr-add';
  add.textContent = 'Add rule';
  add.addEventListener('click', async () => {
    const body = {
      task_type: b.task_type, priority: b.priority, impact: b.impact,
      color: b.color, blocked: b.blocked, tags: b.tags,
      max_per_day: Number.isFinite(b.max) ? b.max : 1,
    };
    try {
      const r = await fetch('api/daily-rules', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrf() },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error((await r.text()).trim() || String(r.status));
      this.rulesBuilder = { task_type: null, priority: null, impact: null, blocked: null, color: null, tags: [] };
      await this.renderRuleBuilder();
      await this.reloadRules();
    } catch (e) {
      document.getElementById('dr-status').textContent = 'Could not add rule: ' + e.message;
    }
  });
  host.appendChild(add);
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
    tr.className = `na-row na-${a.kind} na-color-${a.color || 'yellow'}`;
    const d = new Date(a.at);
    const when = document.createElement('td');
    when.className = 'na-when';
    when.textContent = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      + ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    // The DATE is editable (click → native date input): move the action to
    // another day — e.g. assign points to yesterday. Time-of-day is kept.
    when.classList.add('na-when-edit');
    when.addEventListener('click', () => {
      if (when.querySelector('input')) return;
      const iso = d.toLocaleDateString('en-CA'); // YYYY-MM-DD, local tz
      when.textContent = '';
      const inp = document.createElement('input');
      inp.type = 'date';
      inp.className = 'na-date-input';
      inp.value = iso;
      when.appendChild(inp);
      inp.focus();
      let settled = false;
      const done = async (commit) => {
        if (settled) return;
        settled = true;
        if (commit && inp.value && inp.value !== iso) {
          try {
            await fetch('api/note-actions/date', {
              method: 'PUT',
              credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrf() },
              body: JSON.stringify({
                kind: a.kind,
                id: a.kind === 'points' ? a.event_id : a.note_id,
                date: inp.value,
              }),
            });
          } catch (err) { /* reload shows the truth either way */ }
        }
        this.reloadActions();
      };
      inp.addEventListener('change', () => done(true));
      inp.addEventListener('blur', () => done(inp.value !== iso));
      inp.addEventListener('keydown', (e) => { if (e.key === 'Escape') done(false); });
    });
    tr.appendChild(when);
    // Go-to arrow: the action's note itself, on the landing notes grid.
    const gotoTd = document.createElement('td');
    gotoTd.className = 'na-goto-cell';
    const gotoA = document.createElement('a');
    gotoA.className = 'na-goto';
    gotoA.href = `home.html?view=notes&note=${a.note_id}`;
    gotoA.title = 'Go to note';
    gotoA.innerHTML = window.WriteSysIcons.goto(13);
    gotoTd.appendChild(gotoA);
    tr.appendChild(gotoTd);
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
      // "edit N points" → inline number input. Enter/blur commits: 0 unawards
      // (deletes the event), any other value edits it in place.
      btn.textContent = `edit ${a.points} point${a.points === 1 ? '' : 's'}`;
      btn.onclick = () => {
        if (undoTd.querySelector('input')) return;
        const inp = document.createElement('input');
        inp.type = 'number';
        inp.min = '0';
        inp.max = '99';
        inp.value = String(a.points);
        inp.className = 'na-points-input';
        btn.replaceWith(inp);
        inp.focus();
        inp.select();
        let settled = false;
        const done = async (commit) => {
          if (settled) return;
          settled = true;
          const n = parseInt(inp.value, 10);
          if (commit && Number.isFinite(n) && n >= 0 && n !== a.points) {
            try {
              if (n === 0) {
                await fetch(`api/point-events/${a.event_id}`, { ...req, method: 'DELETE' });
              } else {
                await fetch(`api/point-events/${a.event_id}`, {
                  ...req,
                  method: 'PUT',
                  headers: { ...req.headers, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ points: n }),
                });
              }
            } catch (err) { /* reload shows the truth either way */ }
          }
          this.reloadActions();
        };
        inp.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') done(true);
          if (e.key === 'Escape') done(false);
        });
        inp.addEventListener('blur', () => done(true));
      };
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

// ---- Suggested-edit history: recent accept/reject verdicts across the
// user's manuscripts. A row opens the read-only two-pane dialog
// (suggestions.js openHistoryDialog — the manuscript modal's components)
// so the edit is reviewable without opening the manuscript.
WriteSysSettings.SE_ICONS = {
  accepted: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M3 8.5l3.5 3.5L13 4.5"/></svg>',
  rejected: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" d="M4 4l8 8M12 4l-8 8"/></svg>',
};

WriteSysSettings.reloadSuggestionHistory = async function () {
  const status = document.getElementById('se-status');
  let events;
  try {
    const r = await fetch('api/suggestion-history', { credentials: 'same-origin' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    events = (await r.json()).events || [];
  } catch (e) {
    status.textContent = 'Failed to load suggested-edit history.';
    return;
  }
  const rows = document.getElementById('se-rows');
  rows.innerHTML = '';
  status.textContent = events.length ? '' : 'No reviews yet.';
  events.forEach((ev) => {
    const tr = document.createElement('tr');
    tr.className = `na-row se-row se-${ev.status}`;
    const d = new Date(ev.created_at);
    const when = document.createElement('td');
    when.className = 'na-when';
    when.textContent = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      + ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    tr.appendChild(when);
    const manu = document.createElement('td');
    manu.className = 'se-manu';
    manu.textContent = ev.manuscript_name || '';
    tr.appendChild(manu);
    const who = document.createElement('td');
    who.className = 'se-who';
    who.textContent = ev.owner_id;
    who.title = `${ev.status} by ${ev.reviewer_id}`;
    tr.appendChild(who);
    const icon = document.createElement('td');
    icon.className = `na-icon se-icon-${ev.status}`;
    icon.innerHTML = this.SE_ICONS[ev.status] || '';
    tr.appendChild(icon);
    const prev = document.createElement('td');
    prev.className = 'na-prev';
    prev.textContent = ev.suggested_text || '(deletion)';
    tr.appendChild(prev);
    tr.addEventListener('click', () => window.WriteSysSuggestions.openHistoryDialog(ev));
    rows.appendChild(tr);
  });
};
