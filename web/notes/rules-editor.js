/**
 * Rules editor — ONE component for "which notes": the settings page's Daily
 * task rules and a board's rules (BOARDS_PLAN.md, 2026-11-25). A rule is the
 * shared criteria chip-row (note-widget.js buildCriteriaRow: type / priority /
 * impact / blocked / colour / tags, each wildcardable) plus a cap; the list
 * shows each saved rule as chips with its cap and a ×.
 *
 *   WriteSysRulesEditor.mount(host, {
 *     load:   async () => [rule],            // {rule_id, task_type?, priority?, impact?, color?, blocked?, tags, max_per_day}
 *     add:    async (rule) => void,          // the same shape, no rule_id
 *     remove: async (ruleId) => void,
 *     defaultMax: 1,                         // the builder's starting cap (-1 = unlimited)
 *     caps: [-1, 1, 2, 3, 4, 5, 8, 10, 16],   // the cap chip's choices (∞ = -1)
 *     capLabel: (n) => n === -1 ? '∞ / day' : `≤ ${n} / day`,
 *     empty: 'No rules — …',                 // status when there are none
 *     manuscripts: null | {                  // the picker — null hides it (settings)
 *       list: [{manuscript_id, name}], selected: [ids], onChange: async (ids) => void },
 *     onChange: () => void,                  // after any add/remove/pick (a board reloads its notes)
 *   })  → { reload() }
 */
(function () {
  const csrf = () => (localStorage.getItem('csrf_token') || sessionStorage.getItem('csrf_token')) || '';

  function mount(host, cfg) {
    const W = window.WriteSysNoteWidget;
    host.innerHTML = '';
    host.classList.add('rules-editor');
    const list = document.createElement('div');
    list.className = 'rules-list';
    const builder = document.createElement('div');
    builder.className = 'dr-row rules-builder';
    const status = document.createElement('div');
    status.className = 'settings-hint rules-status';
    let picker = null;
    if (cfg.manuscripts) {
      picker = document.createElement('div');
      picker.className = 'dr-row rules-manuscripts';
      host.appendChild(picker);
    }
    host.appendChild(list);
    host.appendChild(builder);
    host.appendChild(status);

    const capLabel = cfg.capLabel || ((n) => (n === -1 ? '∞' : `≤ ${n}`));
    const crit = { task_type: null, priority: null, impact: null, blocked: null, color: null, tags: [], max: cfg.defaultMax ?? 1 };
    const changed = () => { if (cfg.onChange) cfg.onChange(); };

    const renderPicker = () => {
      if (!picker) return;
      picker.innerHTML = '';
      const sel = new Set(cfg.manuscripts.selected || []);
      (cfg.manuscripts.list || []).forEach((m) => {
        const chip = document.createElement('span');
        chip.className = 'tag-chip dim-chip rules-ms' + (sel.has(m.manuscript_id) ? ' on' : '');
        chip.textContent = m.name || ('#' + m.manuscript_id);
        chip.title = sel.has(m.manuscript_id) ? 'Click: drop this book' : 'Click: only this book (none picked = all)';
        chip.dataset.manuscriptId = m.manuscript_id;
        chip.addEventListener('click', async () => {
          if (sel.has(m.manuscript_id)) sel.delete(m.manuscript_id); else sel.add(m.manuscript_id);
          cfg.manuscripts.selected = [...sel];
          renderPicker();
          try { await cfg.manuscripts.onChange(cfg.manuscripts.selected); } catch (e) { /* the next load shows the truth */ }
          changed();
        });
        picker.appendChild(chip);
      });
    };

    const renderList = async () => {
      let rules;
      try { rules = await cfg.load(); } catch (e) { status.textContent = 'Failed to load rules.'; return; }
      list.innerHTML = '';
      status.textContent = rules.length ? '' : (cfg.empty || '');
      rules.forEach((rule) => {
        const row = document.createElement('div');
        row.className = 'dr-row dr-rule';
        row.dataset.ruleId = rule.rule_id;
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
        n.textContent = capLabel(rule.max_per_day);
        row.appendChild(n);
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'tt-del dr-del';
        del.textContent = '×';
        del.addEventListener('click', async () => {
          try { await cfg.remove(rule.rule_id); } catch (e) { /* reload shows the truth */ }
          await renderList();
          changed();
        });
        row.appendChild(del);
        list.appendChild(row);
      });
    };

    const renderBuilder = () => {
      builder.innerHTML = '';
      W.buildCriteriaRow(builder, crit, renderBuilder);
      // The cap: a chip dropdown like the others — ∞ (unlimited) or ≤ N
      // (2026-11-25: it was a number box showing -1).
      const CAPS = cfg.caps || [-1, 1, 2, 3, 4, 5, 8, 10, 16];
      const capText = (n) => (n === -1 ? '∞' : '≤ ' + n);
      const capOf = (s) => (s === '∞' ? -1 : parseInt(String(s).replace('≤', '').trim(), 10));
      builder.appendChild(W.buildDimChip({
        cls: 'dim-cap',
        value: capText(crit.max),
        loadOptions: async () => CAPS.map((n) => ({ value: capText(n), label: capText(n) })),
        onPick: (v) => { crit.max = capOf(v); renderBuilder(); },
      }));
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'dr-add';
      add.textContent = 'Add rule';
      add.addEventListener('click', async () => {
        const body = {
          task_type: crit.task_type, priority: crit.priority, impact: crit.impact,
          color: crit.color, blocked: crit.blocked, tags: crit.tags,
          max_per_day: Number.isFinite(crit.max) ? crit.max : (cfg.defaultMax ?? 1),
        };
        try {
          await cfg.add(body);
          Object.assign(crit, { task_type: null, priority: null, impact: null, blocked: null, color: null, tags: [], max: cfg.defaultMax ?? 1 });
          renderBuilder();
          await renderList();
          changed();
        } catch (e) {
          status.textContent = 'Could not add rule: ' + (e.message || e);
        }
      });
      builder.appendChild(add);
    };

    renderPicker();
    renderBuilder();
    renderList();
    return { reload: renderList, renderPicker };
  }

  // A fetch that throws the server's text on a non-OK response.
  async function call(url, opts = {}) {
    const r = await fetch(url, Object.assign({ credentials: 'same-origin' }, opts, {
      headers: Object.assign({ 'X-CSRF-Token': csrf() }, opts.body ? { 'Content-Type': 'application/json' } : {}, opts.headers || {}),
    }));
    if (!r.ok) throw new Error((await r.text()).trim() || `HTTP ${r.status}`);
    return r.status === 204 ? null : r.json();
  }

  // Bindings for the two places the editor lives.
  const forDaily = () => ({
    load: async () => ((await call('api/daily-rules')).rules || []),
    add: (rule) => call('api/daily-rules', { method: 'POST', body: JSON.stringify(rule) }),
    remove: (id) => call(`api/daily-rules/${id}`, { method: 'DELETE' }),
    defaultMax: 1,
    caps: [-1, 1, 2, 3, 4, 5, 8, 10, 16],
    capLabel: (n) => (n === -1 ? '∞ / day' : `≤ ${n} / day`),
    empty: 'No rules — the daily page shows any 16 tasks.',
    manuscripts: null,
  });
  const forBoard = (boardId) => ({
    load: async () => ((await call(`api/boards/${boardId}/rules`)).rules || []),
    add: (rule) => call(`api/boards/${boardId}/rules`, { method: 'POST', body: JSON.stringify(rule) }),
    remove: (id) => call(`api/boards/${boardId}/rules/${id}`, { method: 'DELETE' }),
    defaultMax: -1,
    caps: [-1, 1, 2, 3, 5, 8, 10, 16, 32],
    capLabel: (n) => (n === -1 ? '∞' : `≤ ${n}`),
    empty: '',
  });

  window.WriteSysRulesEditor = { mount, forDaily, forBoard, call };
})();
