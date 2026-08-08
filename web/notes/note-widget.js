/**
 * note-widget.js — the placement-agnostic note widget (NOTES_PLAN.md Phase 1c).
 *
 * buildNoteElement(note, handlers, opts) renders the EXACT sticky-note DOM the
 * manuscript margin uses (same classes → same book.css styling), but wired to
 * INJECTED handlers instead of the manuscript margin's cache/rainbow flow. This
 * is what the scratchpad float (Phase 2) and the landing card (Phase 3) mount,
 * so all three read as one component.
 *
 * Every context — manuscript margin, scratchpad float, landing card — mounts
 * THIS component, so a feature added here lands identically everywhere.
 * Location differences are expressed as handlers/flags, never forks.
 *
 *   note      — { note_id, color, body, priority, flagged, tags:[{tag_id,tag_name}],
 *                 manuscript_id, manuscript_name }
 *   handlers  — { onSaveText(text), onColor(color), onDims(patch) — patch is any of
 *                 {task_type}/{priority}/{impact}/{blocked},
 *                 onDelete(), onComplete(), onScorePoints(points), onAddTag(name), onRemoveTag(tagId),
 *                 onLinkManuscript(id), onUnlinkManuscript(),
 *                 onFocus(), onBlur() }  (all optional)
 *   opts      — { collapsed:false, colors:[...], showComplete:true }
 *
 * Text always goes in via `.value` / `.textContent` — never innerHTML — as the
 * manuscript widget does (stored-XSS defense; see test-xss-annotation.js).
 */
(function () {
  const COLORS = ['yellow', 'green', 'blue', 'purple', 'red', 'orange'];
  const esc = (s) => String(s == null ? '' : s);

  // Link glyph shown on the manuscript-link chip (matches the sketch linker).
  const LINK_SVG = '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6.2 9.8l3.6-3.6"/><path d="M7.3 4.3l1.4-1.4a2.75 2.75 0 013.9 3.9l-1.4 1.4"/><path d="M8.7 11.7l-1.4 1.4a2.75 2.75 0 01-3.9-3.9l1.4-1.4"/></svg>';

  // The user's manuscripts, fetched once per page from /api/home (the same list
  // the sketch linker and global search use). Cached; a failure resets so a
  // later open retries. [{id, name}]
  let manuscriptsPromise = null;
  // Manuscript list + picker are owned by the shared chip component
  // (js/manuscript-chip.js) — these names stay exported for back-compat.
  const listManuscripts = () => window.WriteSysManuscriptChip.listManuscripts();
  const openManuscriptPicker = (anchorEl, onPick) => window.WriteSysManuscriptChip.openPicker(anchorEl, onPick);

  // Task types from the settings page (built-ins + customs, each with a
  // color: gray = inert, a real color recolors the note when picked).
  let taskTypesPromise = null;
  let taskTypesAt = 0;
  // Sync mirror of the last fetch — isTask() runs during synchronous
  // renders and can't await. Refreshed on every listTaskTypes resolve.
  let taskTypesByName = null;
  function listTaskTypes() {
    // 30s TTL: colors edited on the settings page must reach already-open
    // pages — a page-lifetime cache recolored notes with stale colors.
    if (!taskTypesPromise || Date.now() - taskTypesAt > 30000) {
      taskTypesAt = Date.now();
      taskTypesPromise = fetch('api/task-types', { credentials: 'same-origin' })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error('task-types ' + r.status))))
        .then((d) => d.task_types || []);
      taskTypesPromise
        .then((types) => {
          taskTypesByName = {};
          types.forEach((t) => { taskTypesByName[t.name] = t; });
        })
        .catch(() => { taskTypesPromise = null; });
    }
    return taskTypesPromise;
  }
  // Prefetch so the sync mirror is warm before the first note renders.
  if (typeof window !== 'undefined') setTimeout(() => { listTaskTypes().catch(() => {}); }, 0);

  const PRIORITIES = ['can', 'would', 'should', 'must'];
  const IMPACTS = ['n/a', 'sentence', 'chapter', 'novel', 'recurring'];

  // A dropdown chip: looks like a tag chip, opens a small option menu.
  function buildDimChip({ cls, value, loadOptions, onPick }) {
    const chip = document.createElement('div');
    chip.className = 'tag-chip dim-chip ' + cls;
    const label = document.createElement('span');
    label.className = 'dim-label';
    label.textContent = value || 'n/a'; // '' = the untyped state
    chip.appendChild(label);
    const caret = document.createElement('span');
    caret.className = 'dim-caret';
    caret.textContent = '▾';
    chip.appendChild(caret);
    chip.addEventListener('click', async (e) => {
      e.stopPropagation();
      document.querySelectorAll('.note-linkpop').forEach((el) => el.remove());
      const pop = document.createElement('div');
      pop.className = 'note-linkpop dim-pop';
      pop.innerHTML = '<div class="note-linkpop-list"><span class="note-linkpop-empty">Loading…</span></div>';
      document.body.appendChild(pop);
      const r = chip.getBoundingClientRect();
      pop.style.position = 'absolute';
      pop.style.top = (window.scrollY + r.bottom + 4) + 'px';
      pop.style.left = (window.scrollX + Math.min(r.left, window.innerWidth - 200)) + 'px';
      const close = () => { document.removeEventListener('mousedown', outside, true); pop.remove(); };
      const outside = (ev) => { if (!pop.contains(ev.target)) close(); };
      setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
      let options;
      try { options = await loadOptions(); } catch (err) { options = []; }
      if (!pop.isConnected) return;
      const list = pop.querySelector('.note-linkpop-list');
      list.innerHTML = options.length ? options.map((o) =>
        `<button type="button" data-v="${esc(o.value)}"${o.value === value ? ' class="dim-current"' : ''}></button>`).join('')
        : '<span class="note-linkpop-empty">No options</span>';
      const btns = list.querySelectorAll('button[data-v]');
      options.forEach((o, i) => { btns[i].textContent = o.label; });
      list.addEventListener('click', (ev) => {
        const b = ev.target.closest('button[data-v]');
        if (!b) return;
        close();
        onPick(b.dataset.v);
      });
    });
    return chip;
  }

  function buildPalette(note, handlers) {
    const palette = document.createElement('div');
    palette.className = 'sticky-note-palette';
    const show = note.color ? COLORS.filter((c) => c !== note.color) : COLORS;
    show.forEach((color) => {
      const wrapper = document.createElement('div');
      const dot = document.createElement('div');
      dot.className = 'color-circle';
      dot.dataset.color = color;
      dot.style.backgroundColor = `var(--highlight-${color})`;
      dot.addEventListener('click', (e) => {
        e.stopPropagation();
        handlers.onColor && handlers.onColor(color);
      });
      wrapper.appendChild(dot);
      palette.appendChild(wrapper);
    });
    return palette;
  }

  function buildColorCircle(note, handlers) {
    const circle = document.createElement('div');
    circle.className = 'sticky-note-color-circle';
    if (!note.color) circle.classList.add('rainbow');
    else circle.classList.add(`color-${note.color}`);
    const palette = buildPalette(note, handlers);
    circle.appendChild(palette);
    // Hover reveals the palette (via the .visible class the CSS keys on). The
    // 200ms hide delay lets the cursor travel from the circle to the palette.
    // (This logic used to live only in the manuscript's js/notes.js — porting it
    // here is what makes the color picker work in EVERY context.)
    let hideTimer;
    const show = () => { clearTimeout(hideTimer); palette.classList.add('visible'); };
    const hideSoon = () => { hideTimer = setTimeout(() => palette.classList.remove('visible'), 200); };
    circle.addEventListener('mouseenter', show);
    circle.addEventListener('mouseleave', hideSoon);
    palette.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    palette.addEventListener('mouseleave', hideSoon);
    return circle;
  }

  // Renders the tag chips + the "+ tag" add chip + the manuscript-link chip
  // (always last). Takes the whole `note` so the link chip can read
  // manuscript_id / manuscript_name. handlers may carry onLinkManuscript /
  // onUnlinkManuscript; without them the link chip is omitted.
  function renderTags(noteEl, note, handlers, opts) {
    const readOnly = !!(opts && opts.readOnly);
    const list = noteEl.querySelector('.tags-list');
    if (!list) return;
    list.innerHTML = '';
    // Derived "sketch" chip (026): present iff the note belongs to a
    // sketch — unremovable BY CONSTRUCTION (no tag row, no ×), first in
    // the row. Wears the plain tag skin.
    // --- Dimension chips: task TYPE first; priority + impact appear right
    //     after it once the type is non-reminder. Dropdowns when editable,
    //     static chips on read-only cards (defaults hidden there). ---
    const task = isTask(note);
    if (readOnly) {
      if (task) {
        const t = document.createElement('div');
        t.className = 'tag-chip dim-chip dim-type';
        t.textContent = note.task_type;
        list.appendChild(t);
        if (note.priority && note.priority !== 'none') {
          const pr = document.createElement('div');
          pr.className = 'tag-chip dim-chip dim-priority';
          pr.textContent = note.priority;
          list.appendChild(pr);
        }
        if (note.impact && note.impact !== 'n/a') {
          const im = document.createElement('div');
          im.className = 'tag-chip dim-chip dim-impact';
          im.textContent = note.impact;
          list.appendChild(im);
        }
        if (note.blocked) {
          const bl = document.createElement('div');
          bl.className = 'tag-chip dim-chip dim-blocked-ro';
          bl.textContent = '⊘ blocked';
          list.appendChild(bl);
        }
      }
    } else if (handlers.onDims) {
      list.appendChild(buildDimChip({
        cls: 'dim-type',
        // '' = untyped, shown as 'n/a'. Deleted types never offered — a
        // note KEEPING one still shows it on the chip, but once changed
        // there's no way back.
        value: note.task_type || '',
        loadOptions: async () => [{ value: '', label: 'n/a' }]
          .concat((await listTaskTypes()).filter((t) => !t.deleted).map((t) => ({ value: t.name, label: t.name }))),
        onPick: async (v) => {
          note.task_type = v;
          const picked = v ? (taskTypesByName && taskTypesByName[v]) : null;
          const taskNow = !!(picked && picked.is_task);
          if (taskNow && (!note.priority || note.priority === 'none')) note.priority = 'can';
          if (!note.impact) note.impact = 'n/a';
          await handlers.onDims({ task_type: v, priority: note.priority, impact: note.impact });
          // Type color: gray = inert; a real color recolors the note.
          if (picked && picked.color && picked.color !== 'gray' && handlers.onColor) handlers.onColor(picked.color);
          renderTags(noteEl, note, handlers, opts);
          updateDims(noteEl, note);
        },
      }));
      if (task) {
        list.appendChild(buildDimChip({
          cls: 'dim-priority',
          value: note.priority && note.priority !== 'none' ? note.priority : 'can',
          loadOptions: async () => PRIORITIES.map((v) => ({ value: v, label: v })),
          onPick: async (v) => {
            note.priority = v;
            await handlers.onDims({ priority: v });
            renderTags(noteEl, note, handlers, opts);
          },
        }));
        list.appendChild(buildDimChip({
          cls: 'dim-impact',
          value: note.impact || 'n/a',
          loadOptions: async () => IMPACTS.map((v) => ({ value: v, label: v })),
          onPick: async (v) => {
            note.impact = v;
            await handlers.onDims({ impact: v });
            renderTags(noteEl, note, handlers, opts);
          },
        }));
      }
    }
    if (note.sketch_id) {
      const sc = document.createElement('div');
      sc.className = 'tag-chip sketch-chip';
      sc.title = 'This is a sketch\u2019s note — it lives with the sketch';
      const nm = document.createElement('span');
      nm.textContent = 'sketch';
      sc.appendChild(nm);
      list.appendChild(sc);
    }
    (note.tags || []).forEach((tag) => {
      const chip = document.createElement('div');
      chip.className = 'tag-chip';
      chip.dataset.tagId = tag.tag_id;
      chip.dataset.tagName = tag.tag_name;
      const name = document.createElement('span');
      name.textContent = tag.tag_name;
      chip.appendChild(name);
      if (!readOnly) {
        const rm = document.createElement('span');
        rm.className = 'tag-chip-remove';
        rm.textContent = '×';
        chip.appendChild(rm);
      }
      list.appendChild(chip);
    });
    if (!readOnly) {
      const add = document.createElement('div');
      add.className = 'tag-chip new-tag';
      add.textContent = '+ tag';
      list.appendChild(add);
    }
    // The manuscript chip lives in the BOTTOM row's 4-slot span now (not
    // among the tags); read-only cards carry context in their footer line.
    if (!readOnly) appendManuscriptChip(noteEl, note, handlers);
  }

  // The manuscript-link chip — always the LAST chip, marked with the link glyph.
  //   linked   → [🔗 The Wildfire ×]   (× unlinks)
  //   unlinked → [🔗]                  (click opens the manuscript picker)
  // Present in every view (it's built here), so linking a note to a manuscript
  // works identically everywhere. Omitted only if the location doesn't wire the
  // link handlers.
  // The manuscript chip is a CONTEXT display first, a link control second:
  //   - If the note has a manuscript_id, the chip ALWAYS shows (its manuscript
  //     is part of what the note is), regardless of location. This is the
  //     "every manuscript note shows its manuscript" invariant.
  //   - Whether it can be UNLINKED depends on onUnlinkManuscript being wired.
  //     A sentence note is inherently in its manuscript, so the margin shows the
  //     chip read-only (no ×). A scratchpad/free note's link is optional, so the
  //     float wires unlink and shows the ×.
  //   - The unlinked-but-linkable state (bare glyph → picker) shows only where
  //     onLinkManuscript is wired.
  function appendManuscriptChip(noteEl, note, handlers) {
    const slot = noteEl.querySelector('.note-ms-slot');
    if (!slot) return;
    slot.innerHTML = '';
    // Location flag: the manuscript margin sets showManuscriptChip:false — a
    // sentence note is trivially in its manuscript, so the chip is noise there.
    if (handlers.showManuscriptChip === false) return;
    const chip = window.WriteSysManuscriptChip.build({
      linkedId: note.manuscript_id,
      linkedName: note.manuscript_name,
      removable: !!handlers.onUnlinkManuscript,
      onUnlink: handlers.onUnlinkManuscript && (async () => {
        await handlers.onUnlinkManuscript();
        renderTags(noteEl, note, handlers);
      }),
      onPick: handlers.onLinkManuscript && (async (manuscriptId) => {
        await handlers.onLinkManuscript(manuscriptId);
        renderTags(noteEl, note, handlers);
      }),
      // Context hooks only (tests + card-compact CSS) — skin comes from .ms-chip.
      extraClass: 'tag-chip manuscript-chip',
      circle: true, // bottom-row slot 1: a 26px circle like its neighbors
    });
    if (chip) slot.appendChild(chip);
  }

  // A note is a TASK iff its task TYPE is in the task category (033:
  // task_type.is_task). Untyped ('' / NULL, shown as n/a) and non-task
  // types are plain notes. No type NAME is special anywhere. Task-ness
  // unlocks priority/impact (dropdown chips in the tag row), the blocked
  // flag, points, and completion. Soft-deleted types keep their category —
  // a note holding one is unchanged. Before the type list arrives, a typed
  // note renders as a task (the common case; corrected on the next render).
  function isTask(note) {
    if (!note.task_type) return false;
    const t = taskTypesByName && taskTypesByName[note.task_type];
    return t ? !!t.is_task : true;
  }

  function updateDims(noteEl, note) {
    const task = isTask(note);
    const blocked = noteEl.querySelector('.blocked-chip');
    if (blocked) {
      blocked.style.display = task ? '' : 'none';
      blocked.classList.toggle('active', !!note.blocked);
    }
    const check = noteEl.querySelector('.complete-check');
    if (check) check.style.display = task ? '' : 'none';
    const star = noteEl.querySelector('.points-star');
    if (star) star.style.display = task ? '' : 'none';
  }
  // Back-compat alias (older call sites).
  const updatePriorityFlagUI = updateDims;

  function autoResize(ta) {
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  }

  // Scoring points on a TASK (the yellow star). First click arms it. While
  // armed:
  //   digit  — types a point value shown IN PLACE of the star (small, so
  //            two digits fit). A second digit lands within 1s of the
  //            first; after that window closes, the next digit starts a
  //            NEW number. Typing holds the armed state open.
  //   click / Enter — submits the typed points as one point_event (a task
  //            can be scored again and again; completion is independent).
  //   Escape — disarms. Arming with nothing typed auto-cancels after 2s.
  function armStar(el, handlers) {
    if (!el) return;
    const checkSvg = el.innerHTML;
    let armed = false, points = null, digitOpen = false, digitTimer, disarmTimer;
    const show = () => {
      el.innerHTML = points == null ? checkSvg : `<span class="points-entry">${points}</span>`;
    };
    const disarm = () => {
      armed = false; points = null; digitOpen = false;
      clearTimeout(digitTimer); clearTimeout(disarmTimer);
      el.classList.remove('scoring');
      document.removeEventListener('keydown', onKey, true);
      show();
    };
    const finish = () => {
      const p = points;
      disarm();
      if (p != null && handlers.onScorePoints) handlers.onScorePoints(p);
    };
    const onKey = (e) => {
      if (!armed) return;
      // Never hijack real typing (note body, tag input, etc.).
      if (e.target && /^(input|textarea)$/i.test(e.target.tagName)) return;
      if (/^[0-9]$/.test(e.key)) {
        e.preventDefault(); e.stopPropagation();
        clearTimeout(disarmTimer);
        const d = parseInt(e.key, 10);
        points = (digitOpen && points != null && points < 10) ? points * 10 + d : d;
        digitOpen = true;
        clearTimeout(digitTimer);
        digitTimer = setTimeout(() => { digitOpen = false; }, 1000);
        show();
      } else if (e.key === 'Enter') {
        e.preventDefault(); e.stopPropagation();
        finish();
      } else if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation();
        disarm();
      }
    };
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!armed) {
        armed = true;
        el.classList.add('scoring');
        document.addEventListener('keydown', onKey, true);
        disarmTimer = setTimeout(() => { if (points == null) disarm(); }, 2000);
      } else {
        finish();
      }
    });
  }

  // Two-click confirm on an icon (trash), matching the manuscript flow.
  function twoClick(el, action) {
    if (!el) return;
    let count = 0, timer;
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      if (count === 0) {
        el.classList.add('confirming');
        count = 1;
        timer = setTimeout(() => { el.classList.remove('confirming'); count = 0; }, 2000);
      } else {
        clearTimeout(timer);
        action();
      }
    });
  }

  function buildNoteElement(note, handlers, opts) {
    handlers = handlers || {};
    opts = opts || {};
    const showComplete = opts.showComplete !== false;
    // Two ORTHOGONAL axes:
    //   readOnly — not editable (no ×, no +tag, no textarea, no toggles). What.
    //   card     — the compact landing-card LOOK (miniature rectangular chips,
    //              clamped preview body). How it presents.
    // A landing note card sets both; they're independent by design (the "card
    // style" comes from `card`, not from read-only-ness). The card frame +
    // context line are added by the caller around this element.
    const readOnly = !!opts.readOnly;
    const card = !!opts.card;

    const noteEl = document.createElement('div');
    noteEl.className = 'sticky-note';
    if (opts.collapsed) noteEl.classList.add('sticky-note-collapsed');
    if (readOnly) noteEl.classList.add('sticky-note-readonly');
    if (card) noteEl.classList.add('sticky-note-card'); // compact-chips + clamp look
    noteEl.dataset.noteId = esc(note.note_id);
    if (note.color) noteEl.classList.add(`color-${note.color}`);

    // The body: an editable textarea live, a clamped preview when read-only.
    const bodyHtml = readOnly
      ? `<div class="note-readonly-body"></div>`
      : `<textarea class="note-input" placeholder="Write a note..." rows="3"></textarea>`;
    // The action icons (trash/complete) and color circle are edit-only.
    const showDelete = opts.showDelete !== false;
    // Bottom row = EIGHT fixed slots: the linked-manuscript chip spans
    // slots 1-4 (or empty space), then ⊘blocked(5) ★(6) ✓(7), and the
    // trash ALWAYS holds slot 8 (right-pinned). Blocked/star/check only
    // exist for TASKS (task_type ≠ reminder) — updateDims toggles them.
    const actionsHtml = readOnly ? '' : `
          ${showComplete ? `<div class="points-star" title="Score points — click, type 1-2 digits, Enter or click again">
            <svg width="14" height="14" viewBox="0 0 20 20">
              <path d="M10 2.5l2.3 4.7 5.2.75-3.75 3.65.9 5.15L10 14.3l-4.65 2.45.9-5.15L2.5 7.95l5.2-.75z" stroke="currentColor" fill="none" stroke-width="1.4" stroke-linejoin="round"/>
            </svg>
          </div>` : ''}
          ${showComplete ? `<div class="complete-check" title="Mark complete">
            <svg width="14" height="14" viewBox="0 0 20 20">
              <path d="M4 10l4 4 8-8" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>` : ''}
          ${showDelete ? `<div class="note-trash" title="Delete note">
            <svg width="14" height="14" viewBox="0 0 20 20">
              <path d="M6 2h8M3 5h14M5 5l1 12h8l1-12M8 8v6M12 8v6" stroke="currentColor" fill="none" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
          </div>` : ''}`;

    noteEl.innerHTML = `
      <div class="note-container">
        ${bodyHtml}
      </div>
      <div class="sticky-bottom-controls">
        <div class="tags-container"><div class="tags-list"></div></div>
      </div>
      <div class="priority-flag-container" style="display: ${note.color ? 'flex' : 'none'}">
        <div class="priority-flag-chips">
          <span class="note-ms-slot"></span>
          <div class="blocked-chip" title="Blocked — no further action possible right now (independent of priority/impact)">
            <svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="10" cy="10" r="7"/><path d="M5.5 5.5l9 9"/></svg>
          </div>${actionsHtml}
        </div>
      </div>`;

    if (!readOnly) noteEl.appendChild(buildColorCircle(note, handlers));
    renderTags(noteEl, note, handlers, opts);
    updatePriorityFlagUI(noteEl, note);

    if (readOnly) {
      // Preview body: same Caveat font (via CSS), clamped to a few lines. No
      // events. Read-only notes carry only priority/flag/tags/context — nothing
      // interactive — so we return right after populating the preview.
      noteEl.querySelector('.note-readonly-body').textContent = note.body || '(empty note)';
      // Cards carry the dimensions as static chips in the tag row (rendered
      // above); the interactive bottom row is edit-only.
      const cont = noteEl.querySelector('.priority-flag-container');
      if (cont) cont.style.display = 'none';
      return noteEl;
    }

    const ta = noteEl.querySelector('.note-input');
    ta.value = note.body || '';
    autoResize(ta);

    // --- events wired to injected handlers ---
    // onCommit fires on any REAL interaction (blur, priority, flag, tag) — the
    // manuscript margin uses it to "commit" a just-auto-created note out of its
    // never-mind window. onInput fires on every keystroke (margin's never-mind
    // consults it to delete an emptied, uncommitted note). Both are optional so
    // the scratchpad float simply doesn't pass them.
    const commit = () => handlers.onCommit && handlers.onCommit();
    let saveTimer;
    ta.addEventListener('focus', () => handlers.onFocus && handlers.onFocus());
    ta.addEventListener('blur', () => handlers.onBlur && handlers.onBlur());
    ta.addEventListener('input', () => {
      autoResize(ta);
      // Let the owner intercept (never-mind may delete an emptied note); if it
      // returns true it handled this input and we skip the debounced save.
      if (handlers.onInput && handlers.onInput(ta.value) === true) { clearTimeout(saveTimer); return; }
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => handlers.onSaveText && handlers.onSaveText(ta.value), 1000);
    });
    ta.addEventListener('blur', () => {
      commit();
      clearTimeout(saveTimer);
      const normalized = ta.value.trim() || null;
      if (normalized !== (note.body || null)) handlers.onSaveText && handlers.onSaveText(ta.value);
    });

    const blockedChip = noteEl.querySelector('.blocked-chip');
    if (blockedChip) blockedChip.addEventListener('click', async () => {
      commit();
      note.blocked = !note.blocked;
      blockedChip.classList.toggle('active', note.blocked);
      if (handlers.onDims) handlers.onDims({ blocked: note.blocked });
    });

    const tagsList = noteEl.querySelector('.tags-list');
    if (tagsList) {
      tagsList.addEventListener('click', async (e) => {
        commit();
        if (e.target.classList.contains('tag-chip-remove')) {
          const chip = e.target.closest('.tag-chip');
          if (handlers.onRemoveTag) {
            await handlers.onRemoveTag(parseInt(chip.dataset.tagId, 10), chip.dataset.tagName);
            // The component owns the re-render: every call site's handler just
            // mutates note.tags, and the chips redraw here — no site has to
            // remember to re-render (that drift is how the float lost its live
            // chip update). note is captured in closure.
            renderTags(noteEl, note, handlers);
          }
        } else if (e.target.classList.contains('new-tag') || e.target.closest('.new-tag')) {
          startTagInput(noteEl, note, handlers);
        }
      });
    }

    twoClick(noteEl.querySelector('.note-trash'), () => handlers.onDelete && handlers.onDelete());
    twoClick(noteEl.querySelector('.complete-check'), () => handlers.onComplete && handlers.onComplete());
    armStar(noteEl.querySelector('.points-star'), handlers);

    // Collapsed cards expand on click (anywhere not on an interactive control).
    if (opts.collapsed && opts.expandable !== false) {
      noteEl.addEventListener('click', (e) => {
        if (e.target.closest('.note-trash, .complete-check, .points-star, .blocked-chip, .dim-chip, .color-circle, .tag-chip, .note-input')) return;
        noteEl.classList.remove('sticky-note-collapsed');
        if (handlers.onExpand) handlers.onExpand();
      });
    }

    return noteEl;
  }

  // Inline tag input — the manuscript flow, but committing via handlers.onAddTag.
  // After the handler mutates note.tags, the component re-renders its own chips
  // (one place, so no call site drifts out of sync).
  function startTagInput(noteEl, note, handlers) {
    const list = noteEl.querySelector('.tags-list');
    const addChip = list.querySelector('.new-tag');
    if (!addChip || list.querySelector('.editable-tag')) return;
    const editable = document.createElement('div');
    editable.className = 'tag-chip editable-tag';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'tag-input';
    input.maxLength = 32;
    editable.appendChild(input);
    list.insertBefore(editable, addChip);
    input.focus();
    let done = false;
    const commit = async () => {
      if (done) return; done = true;
      const name = input.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
      editable.remove();
      if (name && handlers.onAddTag) {
        await handlers.onAddTag(name);
        renderTags(noteEl, note, handlers);
      }
    };
    const cancel = () => { if (done) return; done = true; editable.remove(); };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'Tab' || e.key === ' ') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });
    input.addEventListener('blur', commit);
  }

  // The colored note square (the same one that sits left of highlighted
  // text in a pad) as a standalone component — text is optional; without
  // it you get JUST the square (e.g. a sketch widget's corner note).
  // completed=true renders the green-check state instead of the color.
  function buildNoteSquare({ color, completed, text, title, onClick }) {
    const el = document.createElement('span');
    el.className = 'sn-note-ref sn-note-solo color-' + (color || 'yellow') + (completed ? ' sn-note-done' : '');
    if (title) el.title = title;
    el.innerHTML = completed
      ? '<span class="sn-note-ref-sq sn-note-done-sq"><svg width="9" height="9" viewBox="0 0 20 20"><path d="M4 10l4 4 8-8" stroke="currentColor" fill="none" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/></svg></span>'
      : '<span class="sn-note-ref-sq"></span>';
    if (text) {
      const t = document.createElement('span');
      t.className = 'sn-note-ref-text';
      t.textContent = text;
      el.appendChild(t);
    }
    if (onClick) {
      el.style.cursor = 'pointer';
      el.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); onClick(el); });
      el.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); });
    }
    return el;
  }

  // Generic color dot + hover palette (settings page task-type colors).
  // The palette is its own small horizontal popover — NOT the sticky-note
  // palette, whose absolute layout only works hanging off a note corner.
  // A failed onPick (rejected promise) reverts the dot to its prior color.
  function buildColorDot({ colors, current, onPick }) {
    const wrap = document.createElement('span');
    wrap.className = 'color-dot-solo';
    const dot = document.createElement('span');
    dot.className = 'color-dot-current';
    const fill = (c) => (c === 'gray' ? '#c9c4b8' : `var(--highlight-${c})`);
    let cur = current;
    const paint = (c) => { dot.style.background = fill(c); };
    paint(cur);
    wrap.appendChild(dot);
    const palette = document.createElement('div');
    palette.className = 'dot-palette';
    (colors || COLORS).forEach((color) => {
      const d = document.createElement('span');
      d.className = 'dot-option';
      d.dataset.color = color;
      d.style.background = fill(color);
      d.addEventListener('click', async (e) => {
        e.stopPropagation();
        const prev = cur;
        cur = color;
        paint(color);
        palette.classList.remove('visible');
        try {
          if (onPick) await onPick(color);
        } catch (err) {
          cur = prev;
          paint(prev);
        }
      });
      palette.appendChild(d);
    });
    wrap.appendChild(palette);
    let hideTimer;
    const show = () => { clearTimeout(hideTimer); palette.classList.add('visible'); };
    const hideSoon = () => { hideTimer = setTimeout(() => palette.classList.remove('visible'), 200); };
    wrap.addEventListener('mouseenter', show);
    wrap.addEventListener('mouseleave', hideSoon);
    wrap.addEventListener('click', show);
    return wrap;
  }

  const WriteSysNoteWidget = { buildNoteElement, buildNoteSquare, buildColorDot, renderTags, updatePriorityFlagUI, updateDims, isTask, listTaskTypes, COLORS, LINK_SVG, openManuscriptPicker, listManuscripts };
  if (typeof window !== 'undefined') window.WriteSysNoteWidget = WriteSysNoteWidget;
})();
