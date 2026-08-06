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
 *                 onDelete(), onComplete(points), onAddTag(name), onRemoveTag(tagId),
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
  // Manuscript list + picker are owned by the shared chip component
  // (js/manuscript-chip.js) — these names stay exported for back-compat.
  const listManuscripts = () => window.WriteSysManuscriptChip.listManuscripts();
  const openManuscriptPicker = (anchorEl, onPick) => window.WriteSysManuscriptChip.openPicker(anchorEl, onPick);

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
    // No manuscript chip on read-only cards — the context line carries it.
    if (!readOnly) appendManuscriptChip(noteEl, list, note, handlers);
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
  function appendManuscriptChip(noteEl, list, note, handlers) {
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
    });
    if (chip) list.appendChild(chip);
  }

  function updatePriorityFlagUI(noteEl, note) {
    const hasPriority = !!(note.priority && note.priority !== 'none');
    // Selecting a priority COLLAPSES the P row to just the chosen level (the
    // row reads Pn · flag · trash · ✓); clicking it again toggles back to
    // 'none' and the full P0–P3 palette returns. Buttons keep fixed slot
    // positions from the left (flex-start + fixed gap), so showing or
    // hiding any of them never shifts the others.
    noteEl.querySelectorAll('.priority-chip').forEach((chip) => {
      const active = chip.dataset.priority === note.priority;
      chip.classList.toggle('active', active);
      chip.style.display = (!hasPriority || active) ? '' : 'none';
    });
    const flag = noteEl.querySelector('.flag-chip');
    if (flag) flag.classList.toggle('active', !!note.flagged);
    // TERMINOLOGY: a note with a priority (P0–P3) is a TASK. Only tasks can
    // be completed (and pointed) — the checkmark exists only for them.
    const check = noteEl.querySelector('.complete-check');
    if (check) check.style.display = hasPriority ? '' : 'none';
  }

  function autoResize(ta) {
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  }

  // Completing a TASK, with optional points. First click arms the checkmark
  // (green, like the old two-click confirm). While armed:
  //   digit  — types a point value shown IN PLACE of the ✓ (small, so two
  //            digits fit). A second digit lands within 1s of the first;
  //            after that window closes, the next digit starts a NEW number.
  //            Typing points holds the armed state open.
  //   click / Enter — completes, passing the typed points (null if none).
  //   Escape — disarms. Arming with no typed points still auto-cancels
  //            after 2s, matching the old confirm.
  function armComplete(el, handlers) {
    if (!el) return;
    const checkSvg = el.innerHTML;
    let armed = false, points = null, digitOpen = false, digitTimer, disarmTimer;
    const show = () => {
      el.innerHTML = points == null ? checkSvg : `<span class="points-entry">${points}</span>`;
    };
    const disarm = () => {
      armed = false; points = null; digitOpen = false;
      clearTimeout(digitTimer); clearTimeout(disarmTimer);
      el.classList.remove('confirming');
      document.removeEventListener('keydown', onKey, true);
      show();
    };
    const finish = () => {
      const p = points;
      disarm();
      if (handlers.onComplete) handlers.onComplete(p);
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
        el.classList.add('confirming');
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
    const actionsHtml = readOnly ? '' : `
          <div class="note-trash" title="Delete note">
            <svg width="14" height="14" viewBox="0 0 20 20">
              <path d="M6 2h8M3 5h14M5 5l1 12h8l1-12M8 8v6M12 8v6" stroke="currentColor" fill="none" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
          </div>
          ${showComplete ? `<div class="complete-check" title="Mark complete">
            <svg width="14" height="14" viewBox="0 0 20 20">
              <path d="M4 10l4 4 8-8" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
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
          <div class="priority-chip" data-priority="P0">P0</div>
          <div class="priority-chip" data-priority="P1">P1</div>
          <div class="priority-chip" data-priority="P2">P2</div>
          <div class="priority-chip" data-priority="P3">P3</div>
          <div class="flag-chip" data-flag="true" title="Flag">
            <svg width="14" height="14" viewBox="0 0 20 20" class="flag-icon">
              <path class="flag-staff" d="M4 1v18"/>
              <path class="flag-shape" d="M4 3h10l-2.5 5 2.5 5H4"/>
            </svg>
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
      // In read-only the priority/flag are indicators, not toggles: drop the
      // inactive priority chips so only the set ones show (updatePriorityFlagUI
      // added .active). A cleaner card: hide unset priority chips + unset flag.
      noteEl.querySelectorAll('.priority-chip').forEach((c) => { if (!c.classList.contains('active')) c.remove(); });
      const fl = noteEl.querySelector('.flag-chip');
      if (fl && !fl.classList.contains('active')) fl.remove();
      // If nothing remains in the priority/flag row, hide it.
      const pfc = noteEl.querySelector('.priority-flag-chips');
      if (pfc && !pfc.querySelector('.priority-chip, .flag-chip.active')) {
        const cont = noteEl.querySelector('.priority-flag-container');
        if (cont) cont.style.display = 'none';
      }
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
    armComplete(noteEl.querySelector('.complete-check'), handlers);

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

  const WriteSysNoteWidget = { buildNoteElement, renderTags, updatePriorityFlagUI, COLORS, LINK_SVG, openManuscriptPicker, listManuscripts };
  if (typeof window !== 'undefined') window.WriteSysNoteWidget = WriteSysNoteWidget;
})();
