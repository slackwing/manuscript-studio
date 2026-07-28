/**
 * note-widget.js — the placement-agnostic note widget (NOTES_PLAN.md Phase 1c).
 *
 * buildNoteElement(note, handlers, opts) renders the EXACT sticky-note DOM the
 * manuscript margin uses (same classes → same book.css styling), but wired to
 * INJECTED handlers instead of the manuscript margin's cache/rainbow flow. This
 * is what the scratchpad float (Phase 2) and the landing card (Phase 3) mount,
 * so all three read as one component.
 *
 * The manuscript margin (js/notes.js) still uses its own createStickyNoteElement
 * for now (its never-mind/cache coupling is battle-tested); this is the shared
 * path for the NEW contexts.
 *
 *   note      — { note_id, color, body, priority, flagged, tags:[{tag_id,tag_name}] }
 *   handlers  — { onSaveText(text), onColor(color), onPriority(p), onFlag(),
 *                 onDelete(), onComplete(), onAddTag(name), onRemoveTag(tagId),
 *                 onFocus(), onBlur() }  (all optional)
 *   opts      — { collapsed:false, colors:[...], showComplete:true }
 *
 * Text always goes in via `.value` / `.textContent` — never innerHTML — as the
 * manuscript widget does (stored-XSS defense; see test-xss-annotation.js).
 */
(function () {
  const COLORS = ['yellow', 'green', 'blue', 'purple', 'red', 'orange'];
  const esc = (s) => String(s == null ? '' : s);

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
    circle.appendChild(buildPalette(note, handlers));
    return circle;
  }

  function renderTags(noteEl, tags, handlers) {
    const list = noteEl.querySelector('.tags-list');
    if (!list) return;
    list.innerHTML = '';
    (tags || []).forEach((tag) => {
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
    renderTags(noteEl, note.tags, handlers);
    updatePriorityFlagUI(noteEl, note);

    const ta = noteEl.querySelector('.note-input');
    ta.value = note.body || '';
    autoResize(ta);

    // --- events wired to injected handlers ---
    let saveTimer;
    ta.addEventListener('focus', () => handlers.onFocus && handlers.onFocus());
    ta.addEventListener('blur', () => handlers.onBlur && handlers.onBlur());
    ta.addEventListener('input', () => {
      autoResize(ta);
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => handlers.onSaveText && handlers.onSaveText(ta.value), 1000);
    });
    ta.addEventListener('blur', () => {
      clearTimeout(saveTimer);
      const normalized = ta.value.trim() || null;
      if (normalized !== (note.body || null)) handlers.onSaveText && handlers.onSaveText(ta.value);
    });

    noteEl.querySelectorAll('.priority-chip').forEach((chip) => {
      chip.addEventListener('click', () => handlers.onPriority && handlers.onPriority(chip.dataset.priority));
    });
    const flag = noteEl.querySelector('.flag-chip');
    if (flag) flag.addEventListener('click', () => handlers.onFlag && handlers.onFlag());

    const tagsList = noteEl.querySelector('.tags-list');
    if (tagsList) {
      tagsList.addEventListener('click', (e) => {
        if (e.target.classList.contains('tag-chip-remove')) {
          const chip = e.target.closest('.tag-chip');
          handlers.onRemoveTag && handlers.onRemoveTag(parseInt(chip.dataset.tagId, 10), chip.dataset.tagName);
        } else if (e.target.classList.contains('new-tag') || e.target.closest('.new-tag')) {
          startTagInput(noteEl, handlers);
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
  function startTagInput(noteEl, handlers) {
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
    const commit = () => {
      if (done) return; done = true;
      const name = input.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
      editable.remove();
      if (name && handlers.onAddTag) handlers.onAddTag(name);
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
