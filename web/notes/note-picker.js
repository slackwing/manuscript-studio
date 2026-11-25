/**
 * note-picker.js — ONE picker of existing notes (NOTE_UI_PLAN.md phase 2),
 * opened from the pad's ↗ button and the margin's ↗ chip. A body-level
 * search popover (the manuscript picker's look): each row is the note's
 * colour square, its text (body, else its default), and where it lives
 * (manuscript · pad, "nowhere" for a free note; the owner when not mine).
 *
 *   WriteSysNotePicker.open(anchorEl, { onPick(note), exclude: Set<id> })
 *
 * Text goes in via textContent — never innerHTML (stored-XSS defense).
 */
(function () {
  const COLORS = ['yellow', 'green', 'blue', 'purple', 'red', 'orange'];

  function open(anchorEl, opts) {
    opts = opts || {};
    const exclude = opts.exclude || new Set();
    const api = window.WriteSysNoteAPI;
    if (!api || !api.recent) return null;
    document.querySelectorAll('.note-linkpop').forEach((el) => el.remove());
    const pop = document.createElement('div');
    pop.className = 'note-linkpop note-pick';
    pop.innerHTML =
      '<input type="text" class="note-linkpop-q" placeholder="Search notes…" autocomplete="off">' +
      '<div class="note-linkpop-list"><span class="note-linkpop-empty">Loading…</span></div>';
    document.body.appendChild(pop);
    // VIEWPORT coordinates (position: fixed): the phone suggest-edit view
    // pins the body at -scrollY, where document coordinates land the
    // popover a screenful above the anchor — invisible (2026-11-25). A
    // transient popover never needs to scroll with the page; it closes on
    // the next outside press. Kept inside the viewport on both axes.
    const r = anchorEl.getBoundingClientRect();
    const H = 340; // input + list (max-height 220) + padding
    pop.style.position = 'fixed';
    pop.style.top = Math.max(8, Math.min(r.bottom + 4, window.innerHeight - H)) + 'px';
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 310)) + 'px';

    const close = () => { document.removeEventListener('mousedown', outside, true); pop.remove(); };
    const outside = (e) => { if (!pop.contains(e.target)) close(); };
    setTimeout(() => document.addEventListener('mousedown', outside, true), 0);

    const q = pop.querySelector('.note-linkpop-q');
    const list = pop.querySelector('.note-linkpop-list');
    let rows = [];
    const render = () => {
      list.replaceChildren();
      if (!rows.length) {
        const e = document.createElement('span'); e.className = 'note-linkpop-empty'; e.textContent = 'No notes'; list.appendChild(e); return;
      }
      rows.forEach((n) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'note-pick-row'; b.dataset.nid = String(n.note_id);
        const sq = document.createElement('span');
        sq.className = 'note-pick-sq color-' + (COLORS.includes(n.color) ? n.color : 'yellow');
        const text = document.createElement('span');
        text.className = 'note-pick-text';
        text.textContent = (n.body && n.body.trim()) || (n.default_body && n.default_body.trim()) || '(blank note)';
        if (!(n.body && n.body.trim())) text.classList.add('note-pick-default');
        const ctx = document.createElement('span');
        ctx.className = 'note-pick-ctx';
        const where = n.context || 'nowhere';
        ctx.textContent = n.owner && window.currentSession && window.currentSession.username && n.owner !== window.currentSession.username
          ? `${where} · ${n.owner}` : where;
        b.append(sq, text, ctx);
        list.appendChild(b);
      });
    };
    let seq = 0;
    const load = async () => {
      const mine = ++seq;
      let res;
      try { res = await api.recent(q.value.trim(), 40); }
      catch (e) { if (mine === seq) { list.innerHTML = '<span class="note-linkpop-empty">Could not load notes</span>'; } return; }
      if (mine !== seq || !pop.isConnected) return;
      rows = (res && res.notes ? res.notes : []).filter((n) => !exclude.has(n.note_id));
      render();
    };
    let t;
    q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 200); });
    q.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
      if (e.key === 'Enter') { const b = list.querySelector('button[data-nid]'); if (b) b.click(); }
    });
    list.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-nid]');
      if (!b) return;
      const note = rows.find((n) => String(n.note_id) === b.dataset.nid);
      close();
      if (note && opts.onPick) opts.onPick(note);
    });
    q.focus();
    load();
    return pop;
  }

  if (typeof window !== 'undefined') window.WriteSysNotePicker = { open };
})();
