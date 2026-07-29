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
 *   handlers  — { onSaveText(text), onColor(color), onPriority(p), onFlag(),
 *                 onDelete(), onComplete(), onAddTag(name), onRemoveTag(tagId),
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

  // Link glyph shown on the manuscript-link chip (matches the snippet linker).
  const LINK_SVG = '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6.2 9.8l3.6-3.6"/><path d="M7.3 4.3l1.4-1.4a2.75 2.75 0 013.9 3.9l-1.4 1.4"/><path d="M8.7 11.7l-1.4 1.4a2.75 2.75 0 01-3.9-3.9l1.4-1.4"/></svg>';

  // The user's manuscripts, fetched once per page from /api/home (the same list
  // the snippet linker and global search use). Cached; a failure resets so a
  // later open retries. [{id, name}]
  let manuscriptsPromise = null;
  function listManuscripts() {
    if (!manuscriptsPromise) {
      manuscriptsPromise = fetch('api/home', { credentials: 'same-origin' })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error('home ' + r.status))))
        .then((d) => (d.manuscripts || []).map((m) => ({ id: m.manuscript_id, name: m.display_name || m.name })));
      manuscriptsPromise.catch(() => { manuscriptsPromise = null; });
    }
    return manuscriptsPromise;
  }

  // A small search-and-pick popover anchored to `anchorEl`. Calls onPick(id) with
  // the chosen manuscript_id. Shared by every note's link chip (one picker, so
  // the linking UX is identical in margin / float / landing).
  function openManuscriptPicker(anchorEl, onPick) {
    document.querySelectorAll('.note-linkpop').forEach((el) => el.remove());
    const pop = document.createElement('div');
    pop.className = 'note-linkpop';
    pop.innerHTML =
      '<input type="text" class="note-linkpop-q" placeholder="Search manuscripts…" autocomplete="off">' +
      '<div class="note-linkpop-list"><span class="note-linkpop-empty">Loading…</span></div>';
    document.body.appendChild(pop);
    const r = anchorEl.getBoundingClientRect();
    pop.style.position = 'absolute';
    pop.style.top = (window.scrollY + r.bottom + 4) + 'px';
    pop.style.left = (window.scrollX + Math.min(r.left, window.innerWidth - 240)) + 'px';

    const close = () => { document.removeEventListener('mousedown', outside, true); pop.remove(); };
    const outside = (e) => { if (!pop.contains(e.target)) close(); };
    setTimeout(() => document.addEventListener('mousedown', outside, true), 0);

    const q = pop.querySelector('.note-linkpop-q');
    const list = pop.querySelector('.note-linkpop-list');
    q.focus();
    listManuscripts().then((all) => {
      if (!pop.isConnected) return;
      const render = () => {
        const needle = q.value.trim().toLowerCase();
        const hits = all.filter((m) => m.name.toLowerCase().includes(needle));
        list.innerHTML = hits.length
          ? hits.map((m) => `<button type="button" data-mid="${m.id}"></button>`).join('')
          : '<span class="note-linkpop-empty">No matches</span>';
        // textContent (not innerHTML) for names — XSS-safe.
        const btns = list.querySelectorAll('button[data-mid]');
        hits.forEach((m, i) => { btns[i].textContent = m.name; });
      };
      render();
      q.addEventListener('input', render);
      q.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') close();
        if (e.key === 'Enter') { const b = list.querySelector('button[data-mid]'); if (b) b.click(); }
      });
      list.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-mid]');
        if (!b) return;
        close();
        onPick(parseInt(b.dataset.mid, 10));
      });
    }).catch(() => { list.innerHTML = '<span class="note-linkpop-empty">Could not load manuscripts</span>'; });
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
  function renderTags(noteEl, note, handlers) {
    const list = noteEl.querySelector('.tags-list');
    if (!list) return;
    list.innerHTML = '';
    (note.tags || []).forEach((tag) => {
      const chip = document.createElement('div');
      chip.className = 'tag-chip';
      chip.dataset.tagId = tag.tag_id;
      chip.dataset.tagName = tag.tag_name;
      const name = document.createElement('span');
      name.textContent = tag.tag_name;
      chip.appendChild(name);
      const rm = document.createElement('span');
      rm.className = 'tag-chip-remove';
      rm.textContent = '×';
      chip.appendChild(rm);
      list.appendChild(chip);
    });
    const add = document.createElement('div');
    add.className = 'tag-chip new-tag';
    add.textContent = '+ tag';
    list.appendChild(add);
    appendManuscriptChip(noteEl, list, note, handlers);
  }

  // The manuscript-link chip — always the LAST chip, marked with the link glyph.
  //   linked   → [🔗 The Wildfire ×]   (× unlinks)
  //   unlinked → [🔗]                  (click opens the manuscript picker)
  // Present in every view (it's built here), so linking a note to a manuscript
  // works identically everywhere. Omitted only if the location doesn't wire the
  // link handlers.
  function appendManuscriptChip(noteEl, list, note, handlers) {
    if (!handlers.onLinkManuscript && !handlers.onUnlinkManuscript) return;
    const chip = document.createElement('div');
    chip.className = 'tag-chip manuscript-chip';
    const icon = document.createElement('span');
    icon.className = 'manuscript-chip-icon';
    icon.innerHTML = LINK_SVG;
    chip.appendChild(icon);

    if (note.manuscript_id) {
      chip.classList.add('linked');
      const name = document.createElement('span');
      name.className = 'manuscript-chip-name';
      name.textContent = note.manuscript_name || 'Manuscript';
      chip.appendChild(name);
      const rm = document.createElement('span');
      rm.className = 'manuscript-chip-remove';
      rm.textContent = '×';
      rm.title = 'Unlink from manuscript';
      chip.appendChild(rm);
      rm.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (handlers.onUnlinkManuscript) {
          await handlers.onUnlinkManuscript();
          renderTags(noteEl, note, handlers);
        }
      });
    } else {
      chip.classList.add('unlinked');
      chip.title = 'Link to a manuscript';
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!handlers.onLinkManuscript) return;
        openManuscriptPicker(chip, async (manuscriptId) => {
          await handlers.onLinkManuscript(manuscriptId);
          renderTags(noteEl, note, handlers);
        });
      });
    }
    list.appendChild(chip);
  }

  function updatePriorityFlagUI(noteEl, note) {
    noteEl.querySelectorAll('.priority-chip').forEach((chip) => {
      chip.classList.toggle('active', chip.dataset.priority === note.priority);
    });
    const flag = noteEl.querySelector('.flag-chip');
    if (flag) flag.classList.toggle('active', !!note.flagged);
  }

  function autoResize(ta) {
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  }

  // Two-click confirm on an icon (trash/complete), matching the manuscript flow.
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

    const noteEl = document.createElement('div');
    noteEl.className = 'sticky-note';
    if (opts.collapsed) noteEl.classList.add('sticky-note-collapsed');
    noteEl.dataset.noteId = esc(note.note_id);
    if (note.color) noteEl.classList.add(`color-${note.color}`);

    noteEl.innerHTML = `
      <div class="note-container">
        <textarea class="note-input" placeholder="Write a note..." rows="3"></textarea>
      </div>
      <div class="sticky-bottom-controls">
        <div class="tags-container"><div class="tags-list"></div></div>
      </div>
      <div class="priority-flag-container" style="display: ${note.color ? 'flex' : 'none'}">
        <div class="priority-flag-chips">
          <div class="priority-chip" data-priority="P0">P0</div>
          <div class="priority-chip" data-priority="P1">P1</div>
          <div class="priority-chip" data-priority="P2">P2</div>
          <div class="flag-chip" data-flag="true" title="Flag">
            <svg width="14" height="14" viewBox="0 0 20 20" class="flag-icon">
              <path class="flag-staff" d="M4 1v18"/>
              <path class="flag-shape" d="M4 3h10l-2.5 5 2.5 5H4"/>
            </svg>
          </div>
          <div class="note-trash" title="Delete note">
            <svg width="14" height="14" viewBox="0 0 20 20">
              <path d="M6 2h8M3 5h14M5 5l1 12h8l1-12M8 8v6M12 8v6" stroke="currentColor" fill="none" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
          </div>
          ${showComplete ? `<div class="complete-check" title="Mark complete">
            <svg width="14" height="14" viewBox="0 0 20 20">
              <path d="M4 10l4 4 8-8" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>` : ''}
        </div>
      </div>`;

    noteEl.appendChild(buildColorCircle(note, handlers));
    renderTags(noteEl, note, handlers);
    updatePriorityFlagUI(noteEl, note);

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

    noteEl.querySelectorAll('.priority-chip').forEach((chip) => {
      chip.addEventListener('click', () => { commit(); handlers.onPriority && handlers.onPriority(chip.dataset.priority); });
    });
    const flag = noteEl.querySelector('.flag-chip');
    if (flag) flag.addEventListener('click', () => { commit(); handlers.onFlag && handlers.onFlag(); });

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

    // Collapsed cards expand on click (anywhere not on an interactive control).
    if (opts.collapsed && opts.expandable !== false) {
      noteEl.addEventListener('click', (e) => {
        if (e.target.closest('.note-trash, .complete-check, .priority-chip, .flag-chip, .color-circle, .tag-chip, .note-input')) return;
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

  const WriteSysNoteWidget = { buildNoteElement, renderTags, updatePriorityFlagUI, COLORS };
  if (typeof window !== 'undefined') window.WriteSysNoteWidget = WriteSysNoteWidget;
})();
