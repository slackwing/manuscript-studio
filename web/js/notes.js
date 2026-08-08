const WriteSysNotes = {
  apiBaseUrl: 'api',
  currentSentenceId: null,
  currentSentenceText: '',
  notes: [],

  COLORS: ['yellow', 'green', 'blue', 'purple', 'red', 'orange'],

  DEFAULT_COLOR: 'yellow',

  // Auto-created notes commit only on interaction; until then, blurring
  // an empty textarea cancels the note ("never mind").
  neverMindState: {
    noteId: null,
    isCommitted: false
  },

  // Must match the matching CSS variables in book.css (see the "Gutter layout"
  // block there — these are the single source of truth for the symmetric
  // page-anchored gutters).
  SPACING: {
    PAGE_WIDTH: 576,
    ANNOTATION_WIDTH: 272,   // sticky-note content width (unchanged; notes keep their size)
    HORIZONTAL_GAP: 32,      // gap between the page edge and gutter content, BOTH sides
    GUTTER_BAND: 300,        // reserved band each side (outline / sticky) — the mirror width
  },

  // The desktop layout fits only when the centered page plus BOTH page-anchored
  // gutter bands (band + gap each side) fit the viewport. Below this the layout
  // switches to the mobile second-bar (see book.css @media). Keep this in sync
  // with the @media (max-width: …) there.
  //   2 × (GUTTER_BAND + HORIZONTAL_GAP) + PAGE_WIDTH = 2×332 + 576 = 1240
  DESKTOP_MIN_WIDTH: 1240,

  init() {
    document.addEventListener('click', (e) => {
      const noteMargin = document.getElementById('note-margin');
      const noteMarginInner = document.querySelector('.note-margin-inner');
      const appContainer = document.getElementById('app-container');
      const pagedPages = document.querySelector('.pagedjs_pages');

      // Grey-background clicks unselect the current sentence.
      const isGreyBackground =
        e.target === noteMargin ||
        e.target === noteMarginInner ||
        e.target === appContainer ||
        e.target === pagedPages ||
        e.target === document.body;

      if (isGreyBackground) {
        this.unselectSentence();
      }
    });

    this.initNoteMargin();

    // Click sentence-preview → scroll to the currently-selected sentence.
    const preview = document.getElementById('sentence-preview');
    if (preview) {
      preview.style.cursor = 'pointer';
      preview.addEventListener('click', () => this.scrollToCurrentSentence());
    }

    console.log('WriteSys Notes (Multi-Note) initialized');
  },

  scrollToCurrentSentence() {
    if (!this.currentSentenceId) return;
    const fragment = document.querySelector(`.sentence[data-sentence-id="${this.currentSentenceId}"]`);
    if (fragment) {
      fragment.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  },

  // First annotated sentence in DOM order strictly after the current one
  // (wrapping). Works even when the current sentence itself isn't annotated
  // anymore (e.g. just-completed last note).
  jumpToNextAnnotatedSentence() {
    const renderer = window.WriteSysRenderer;
    if (!renderer || !renderer.currentNotes) return;

    const annotatedIds = new Set(
      renderer.currentNotes.map(a => a.sentence_id).filter(Boolean)
    );
    if (annotatedIds.size === 0) return;

    const allSentences = Array.from(document.querySelectorAll('.sentence[data-sentence-id]'));
    const orderedIds = [];
    const seen = new Set();
    for (const el of allSentences) {
      const id = el.dataset.sentenceId;
      if (id && !seen.has(id)) {
        seen.add(id);
        orderedIds.push(id);
      }
    }
    if (orderedIds.length === 0) return;

    const annotatedOrdered = orderedIds.filter(id => annotatedIds.has(id));
    if (annotatedOrdered.length === 0) return;

    let nextId = null;
    if (this.currentSentenceId) {
      const currentDocIdx = orderedIds.indexOf(this.currentSentenceId);
      nextId = annotatedOrdered.find(id => orderedIds.indexOf(id) > currentDocIdx);
      if (!nextId) nextId = annotatedOrdered[0];
    } else {
      nextId = annotatedOrdered[0];
    }

    const fragments = document.querySelectorAll(`.sentence[data-sentence-id="${nextId}"]`);
    if (fragments.length === 0) return;

    document.querySelectorAll('.sentence.selected').forEach(s => s.classList.remove('selected'));
    fragments.forEach(f => f.classList.add('selected'));
    if (renderer) renderer.currentSelectedSentenceId = nextId;

    // sentenceMap has the full text; fragments[0] may only be a fragment.
    const fullText = (renderer && renderer.sentenceMap && renderer.sentenceMap[nextId])
      || fragments[0].textContent;
    this.showNotesForSentence(nextId, fullText);

    fragments[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
  },

  initNoteMargin() {
    const margin = document.getElementById('note-margin');
    if (!margin) return;

    // ONE source of truth for BOTH page-anchored gutters. The page is centered,
    // so the gutter each side is (winW − pageW)/2. Sticky notes sit
    // HORIZONTAL_GAP to the RIGHT of the page's right edge; the outline mirrors
    // that HORIZONTAL_GAP to the LEFT of the page's left edge — same gap, same
    // GUTTER_BAND width, mirror images. As the viewport widens, both stay glued
    // to the page and the extra space opens symmetrically at the far edges.
    // (On mobile the outline relocates to the second bar via CSS; this left
    // positioning is harmless there because #outline-margin.has-outline is
    // re-anchored by the @media rule.)
    const outline = document.getElementById('outline-margin');
    const stats = document.getElementById('stats-margin');
    const chrome = document.getElementById('manuscript-chrome');
    const positionGutters = () => {
      const gutter = (window.innerWidth - this.SPACING.PAGE_WIDTH) / 2;
      // Right edge of the note band: gutter minus the gap and the band.
      margin.style.right = `${gutter - this.SPACING.HORIZONTAL_GAP - this.SPACING.ANNOTATION_WIDTH}px`;
      // Mirror on the left: the outline band's left edge. The manuscript-chrome
      // info header sits in the same band directly above the outline, so it
      // shares the exact same left — as does the stats pane, the outline's
      // tab-switched sibling in the same band.
      const leftBand = Math.max(0, gutter - this.SPACING.HORIZONTAL_GAP - this.SPACING.GUTTER_BAND);
      if (outline) outline.style.left = `${leftBand}px`;
      if (stats) stats.style.left = `${leftBand}px`;
      if (chrome) chrome.style.left = `${leftBand}px`;
      // Panes start where the chrome ACTUALLY ends — its height varies (name
      // wraps, push button loads async, tab row), so the old fixed top:142px
      // either overlapped the rule or left a random gap. Desktop only: the
      // mobile second-bar pins its own top in the @media block, and an
      // inline top would beat it.
      if (window.innerWidth >= this.DESKTOP_MIN_WIDTH && chrome) {
        const bottom = Math.ceil(chrome.getBoundingClientRect().bottom);
        for (const el of [outline, stats]) {
          if (!el) continue;
          el.style.top = `${bottom}px`;
          el.style.maxHeight = `calc(100vh - ${bottom + 20}px)`;
        }
      } else {
        for (const el of [outline, stats]) {
          if (!el) continue;
          el.style.top = '';
          el.style.maxHeight = '';
        }
      }
    };

    positionGutters();
    window.addEventListener('resize', positionGutters);
    // The chrome's height changes as async content lands (manuscript name,
    // push button) — re-anchor the panes whenever it does.
    if (window.ResizeObserver && chrome) {
      new ResizeObserver(positionGutters).observe(chrome);
    }
  },

  // Mark an auto-created note as committed so "never mind" won't delete it
  // on empty-blur. Pass null to commit whichever note is currently pending.
  commitPendingNote(noteId) {
    if (noteId == null) {
      if (this.neverMindState.noteId) {
        this.neverMindState.isCommitted = true;
      }
      return;
    }
    if (this.neverMindState.noteId === noteId) {
      this.neverMindState.isCommitted = true;
    }
  },

  // Mirror of a note insert into the renderer's authoritative
  // cache. Property edits (color/body/priority/flag) mutate the
  // note object in place, so they propagate without help; only
  // array-shape changes (push/filter) need this.
  _cacheAdd(note) {
    const r = window.WriteSysRenderer;
    if (r && Array.isArray(r.currentNotes)) r.currentNotes.push(note);
  },

  _cacheRemove(noteId) {
    const r = window.WriteSysRenderer;
    if (r && Array.isArray(r.currentNotes)) {
      r.currentNotes = r.currentNotes.filter(a => a.note_id !== noteId);
    }
  },

  // Reads from WriteSysRenderer.currentNotes (preloaded with the
  // manuscript) rather than fetching per click — clicks need to feel
  // instant. Local mutations (create/delete/complete/color/body/priority/
  // flag) keep currentNotes in sync, so the cache is the truth.
  showNotesForSentence(sentenceId, sentenceText) {
    this.commitPendingNote(null);

    this.currentSentenceId = sentenceId;
    this.currentSentenceText = sentenceText;

    const preview = document.getElementById('sentence-preview');
    if (preview) {
      const words = sentenceText.trim().split(/\s+/);
      let firstThreeWords = words.slice(0, 3).join(' ');
      firstThreeWords = firstThreeWords.replace(/\W+$/, '');
      preview.textContent = `${firstThreeWords}...`;
      preview.classList.add('visible');
    }

    const all = (window.WriteSysRenderer && window.WriteSysRenderer.currentNotes) || [];
    this.notes = all.filter(a => a.sentence_id === sentenceId);

    this.renderStickyNotes();
    // Don't auto-focus the first note. Sentence stays grey-selected
    // until the user explicitly clicks into a note's textarea — at
    // which point the focus listener tints the sentence in that
    // note's color. (The uncreated/empty note still gets focus when
    // there are no real notes; see renderStickyNotes.)
    if (this.notes.length === 0) {
      this.focusFirstNoteTextarea();
    }
  },

  // Drop cursor into the first note's textarea so the user can type immediately.
  focusFirstNoteTextarea() {
    const container = document.getElementById('sticky-notes-container');
    if (!container) return;
    const textarea = container.querySelector('.sticky-note .note-input');
    if (textarea) {
      textarea.focus();
      const end = textarea.value.length;
      textarea.setSelectionRange(end, end);
    }
  },

  renderStickyNotes() {
    const container = document.getElementById('sticky-notes-container');
    if (!container) return;

    container.innerHTML = '';

    this.notes.forEach(note => {
      const noteElement = this.createStickyNoteElement(note);
      container.appendChild(noteElement);
    });

    // First note shows full grey UI; subsequent show gradient with a + sign.
    const isFirstNote = this.notes.length === 0;
    const addNewNote = this.createAddNewNoteElement(isFirstNote);
    container.appendChild(addNewNote);

    if (!isFirstNote) {
      container.appendChild(this.createNextAnnotatedSentenceButton());
    }

    container.classList.add('visible');

    // scrollHeight is 0 on detached elements — re-run after DOM-attach so
    // pre-existing long notes open at full height instead of waiting for input.
    container.querySelectorAll('.note-input').forEach(t => this.autoResizeTextarea(t));
  },

  createNextAnnotatedSentenceButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'next-annotated-sentence-btn';
    btn.title = 'Jump to next annotated sentence';
    btn.innerHTML = `
      <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
        <path d="M5 8l5 5 5-5"
              stroke="currentColor" fill="none" stroke-width="2"
              stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    `;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.jumpToNextAnnotatedSentence();
    });
    return btn;
  },

  // The manuscript margin now renders notes through the SHARED note-widget
  // (web/notes/note-widget.js) — the SAME component the scratchpad float and
  // landing cards use — so every note feature is delivered identically
  // everywhere. Margin-specific behavior (never-mind, focus tint, the cache +
  // rainbow-bar coupling) is wired via handlers/flags, not a forked component.
  createStickyNoteElement(note) {
    let saveTimeout;
    const W = window.WriteSysNoteWidget;
    const noteEl = W.buildNoteElement(note, {
      // Focus/blur tint the sentence in the note's color.
      onFocus: () => this.applyFocusHighlight(note.sentence_id, note.color),
      onBlur: () => this.clearFocusHighlight(note.sentence_id),
      // Never-mind: emptying a just-auto-created, uncommitted note deletes it.
      // Returning true tells the widget we handled this input (skip its save).
      onInput: (value) => {
        if (this.neverMindState.noteId === note.note_id &&
            !this.neverMindState.isCommitted &&
            value.trim().length === 0) {
          clearTimeout(saveTimeout);
          this.neverMindState.noteId = null;
          this.neverMindState.isCommitted = false;
          // deleteNote re-renders the panel; refocus the grey note AFTER that,
          // or the focus lands on a DOM node that's about to be replaced.
          this.deleteNote(note.note_id).then(() => {
            const fresh = document.querySelector('.sticky-note.uncreated-note.first-uncreated .note-input');
            if (fresh) fresh.focus();
          });
          return true;
        }
        return false;
      },
      // Any real interaction commits the note out of the never-mind window.
      onCommit: () => this.commitPendingNote(note.note_id),
      onSaveText: (text) => this.saveNoteText(note.note_id, text),
      onColor: (color) => this.handleColorSelectionForNote(note.note_id, color),
      onDims: (patch) => this.updateNoteDims(note, patch, noteEl),
      onDelete: () => this.deleteNote(note.note_id),
      onComplete: () => this.completeNote(note.note_id),
      onScorePoints: (points) => this.scorePoints(note.note_id, points),
      onAddTag: (name) => this.addTagByName(note, noteEl, name),
      onRemoveTag: (tagId, tagName) => this.removeTag(note, tagId, tagName, noteEl),
      // A sentence note is trivially in its manuscript — the chip would be
      // noise. Flag it off here (the scratchpad float leaves it on).
      showManuscriptChip: false,
    }, {});
    noteEl.dataset.annotationId = note.note_id;
    return noteEl;
  },

  createPaletteElement(note) {
    const palette = document.createElement('div');
    palette.className = 'sticky-note-palette';

    // Grey notes show all 6; a colored note shows the other 5 for swapping.
    const colorsToShow = note.color
      ? this.COLORS.filter(c => c !== note.color)
      : this.COLORS;

    // Wrapper gives each hover zone breathing room.
    colorsToShow.forEach(color => {
      const wrapper = document.createElement('div');

      const colorCircle = document.createElement('div');
      colorCircle.className = 'color-circle';
      colorCircle.dataset.color = color;

      const colorVar = `var(--highlight-${color})`;
      colorCircle.style.backgroundColor = colorVar;

      colorCircle.addEventListener('click', (e) => {
        e.stopPropagation();
        this.handleColorSelectionForNote(note.note_id, color);
      });

      wrapper.appendChild(colorCircle);
      palette.appendChild(wrapper);
    });

    return palette;
  },

  createAddNewNoteElement(isFirstNote) {
    return isFirstNote
      ? this.createFirstUncreatedNote()
      : this.createSubsequentUncreatedNote();
  },

  setupUncreatedNoteHandlers(note, textarea, colorCircle, requiresHover) {
    let noteCreated = false;
    let isCreating = false;

    textarea.addEventListener('focus', () => {
      if (requiresHover) {
        note.classList.add('hovered');
      }
      colorCircle.style.opacity = '1';
      colorCircle.style.transform = 'scale(1)';
    });

    if (requiresHover) {
      textarea.addEventListener('blur', () => {
        if (!noteCreated) {
          note.classList.remove('hovered');
          colorCircle.style.opacity = '0';
          colorCircle.style.transform = 'scale(0.8)';
        }
      });
    }

    textarea.addEventListener('input', async (e) => {
      if (!noteCreated && !isCreating && e.target.value.trim().length > 0) {
        isCreating = true;
        noteCreated = true;
        const initialText = e.target.value;
        // Pass the stale textarea so handleAddNewNote can recover characters
        // typed during the POST round-trip into the new real-note textarea.
        const newNote = await this.handleAddNewNote(this.DEFAULT_COLOR, initialText, textarea);

        if (newNote && newNote.note_id) {
          this.neverMindState.noteId = newNote.note_id;
          this.neverMindState.isCommitted = false;
        }
        isCreating = false;
      }
    });

    textarea.addEventListener('input', () => {
      this.autoResizeTextarea(textarea);
    });
  },

  createFirstUncreatedNote() {
    const note = document.createElement('div');
    note.className = 'sticky-note uncreated-note first-uncreated';

    note.innerHTML = `
      <div class="note-container">
        <textarea class="note-input" placeholder="Write a note..." rows="3"></textarea>
      </div>
      <div class="sticky-bottom-controls">
        <div class="tags-container">
          <div class="tags-list">
            <div class="tag-chip new-tag">+ tag</div>
          </div>
        </div>
      </div>
    `;

    const colorCircle = this.createColorCircleForUncreated();
    note.appendChild(colorCircle);

    const textarea = note.querySelector('.note-input');
    this.setupUncreatedNoteHandlers(note, textarea, colorCircle, false);

    return note;
  },

  createSubsequentUncreatedNote() {
    const note = document.createElement('div');
    note.className = 'sticky-note uncreated-note subsequent-uncreated';

    note.innerHTML = `
      <div class="uncreated-plus">+</div>
      <div class="note-container">
        <textarea class="note-input" placeholder="Write a note..." rows="3"></textarea>
      </div>
      <div class="sticky-bottom-controls">
        <div class="tags-container">
          <div class="tags-list">
            <div class="tag-chip new-tag">+ tag</div>
          </div>
        </div>
      </div>
    `;

    const colorCircle = this.createColorCircleForUncreated();
    note.appendChild(colorCircle);

    const textarea = note.querySelector('.note-input');
    this.setupUncreatedNoteHandlers(note, textarea, colorCircle, true);

    note.addEventListener('mouseenter', () => {
      note.classList.add('hovered');
      colorCircle.style.opacity = '1';
      colorCircle.style.transform = 'scale(1)';
    });

    note.addEventListener('mouseleave', () => {
      if (document.activeElement !== textarea) {
        note.classList.remove('hovered');
        colorCircle.style.opacity = '0';
        colorCircle.style.transform = 'scale(0.8)';
      }
    });

    return note;
  },

  createColorCircleForUncreated() {
    const colorCircle = document.createElement('div');
    colorCircle.className = 'sticky-note-color-circle rainbow';

    const palette = this.createAddNotePaletteElement();
    colorCircle.appendChild(palette);

    colorCircle.addEventListener('mouseenter', () => {
      palette.classList.add('visible');
    });

    // Delay hide so the cursor can reach the palette.
    let hideTimeout;
    colorCircle.addEventListener('mouseleave', () => {
      hideTimeout = setTimeout(() => {
        palette.classList.remove('visible');
      }, 200);
    });

    palette.addEventListener('mouseenter', () => {
      clearTimeout(hideTimeout);
    });

    palette.addEventListener('mouseleave', () => {
      hideTimeout = setTimeout(() => {
        palette.classList.remove('visible');
      }, 200);
    });

    return colorCircle;
  },

  createAddNotePaletteElement() {
    const palette = document.createElement('div');
    palette.className = 'sticky-note-palette';

    this.COLORS.forEach(color => {
      const wrapper = document.createElement('div');

      const colorCircle = document.createElement('div');
      colorCircle.className = 'color-circle';
      colorCircle.dataset.color = color;

      const colorVar = `var(--highlight-${color})`;
      colorCircle.style.backgroundColor = colorVar;

      colorCircle.addEventListener('click', (e) => {
        e.stopPropagation();
        this.handleAddNewNote(color);
      });

      wrapper.appendChild(colorCircle);
      palette.appendChild(wrapper);
    });

    return palette;
  },

  autoResizeTextarea(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = textarea.scrollHeight + 'px';
  },

  async handleColorSelectionForNote(noteId, color) {
    const note = this.notes.find(a => a.note_id === noteId);
    if (!note) return;

    this.commitPendingNote(noteId);

    try {
      await this.updateNoteColor(noteId, color);
      note.color = color;

      this.renderStickyNotes();

      // renderStickyNotes recreates the DOM, dropping focus from the
      // old textarea (and with it the focus-tint). Restore focus to
      // the same note so the user keeps their typing context
      // and the sentence picks up the new color.
      const noteInput = document.querySelector(`.sticky-note[data-annotation-id="${noteId}"] .note-input`);
      if (noteInput) {
        noteInput.focus();
        noteInput.setSelectionRange(noteInput.value.length, noteInput.value.length);
      }

      if (window.WriteSysRenderer && window.WriteSysRenderer.refreshRainbowBars) {
        await window.WriteSysRenderer.refreshRainbowBars();
      }

    } catch (error) {
      console.error('Failed to update color:', error);
      alert('Failed to update color');
    }
  },

  async handleAddNewNote(color, initialNote = null, sourceTextarea = null) {
    // Capture NOW: the user can click another sentence during the POST
    // round-trip below, repointing this.currentSentenceId — which used to
    // attach the local note object to the wrong sentence.
    const sentenceId = this.currentSentenceId;
    if (!sentenceId) return;

    try {
      const response = await authenticatedFetch(`${this.apiBaseUrl}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sentence_id: sentenceId,
          color: color,
          body: initialNote,
          priority: 'none',
          flagged: false
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const apiResponse = await response.json();

      // Recover any characters typed during the POST round-trip — they
      // landed in the about-to-be-destroyed uncreated textarea.
      let liveText = initialNote;
      if (sourceTextarea && typeof sourceTextarea.value === 'string') {
        liveText = sourceTextarea.value;
      }

      const newNote = {
        note_id: apiResponse.note_id,
        sentence_id: sentenceId,
        color: color,
        body: liveText,
        priority: 'none',
        flagged: false,
        tags: []
      };

      this._cacheAdd(newNote);

      // Only touch the side-panel when the user is still on the sentence
      // this note belongs to. If they clicked another sentence mid-flight,
      // this.notes already holds THAT sentence's notes — pushing here
      // (or re-rendering / stealing focus) would show the new note under
      // the wrong sentence. The cache add above is enough: re-selecting
      // the original sentence re-filters from the cache and shows it.
      if (this.currentSentenceId === sentenceId) {
        this.notes.push(newNote);
        this.renderStickyNotes();

        // Move in-flight text into the new real-note textarea and persist any
        // characters typed past what we already POSTed.
        const newTextarea = document.querySelector(
          `.sticky-note[data-annotation-id="${apiResponse.note_id}"] .note-input`
        );
        if (newTextarea) {
          newTextarea.value = liveText || '';
          this.autoResizeTextarea(newTextarea);
          newTextarea.focus();
          const end = newTextarea.value.length;
          newTextarea.setSelectionRange(end, end);
          if (sourceTextarea && (liveText || '') !== (initialNote || '')) {
            this.saveNoteText(apiResponse.note_id, liveText);
          }
        }
      }

      this.updateSentenceHighlights();

      if (window.WriteSysRenderer && window.WriteSysRenderer.refreshRainbowBars) {
        await window.WriteSysRenderer.refreshRainbowBars();
      }

      return newNote;

    } catch (error) {
      console.error('Failed to create note:', error);
      alert('Failed to create note');
      return null;
    }
  },

  // No-op now. Sentence backgrounds are driven by note focus
  // (applyFocusHighlight / clearFocusHighlight) rather than note
  // list shape; existing callers from tag/priority/flag flows keep
  // calling this so they can be left in place during partial refactors.
  updateSentenceHighlights() {},

  applyFocusHighlight(sentenceId, color) {
    if (!sentenceId || !color) return;
    document.querySelectorAll(`.sentence[data-sentence-id="${sentenceId}"]`).forEach(fragment => {
      this.COLORS.forEach(c => fragment.classList.remove(`highlight-${c}`));
      fragment.classList.add(`highlight-${color}`);
    });
  },

  clearFocusHighlight(sentenceId) {
    if (!sentenceId) return;
    document.querySelectorAll(`.sentence[data-sentence-id="${sentenceId}"]`).forEach(fragment => {
      this.COLORS.forEach(c => fragment.classList.remove(`highlight-${c}`));
    });
  },

  async deleteNote(noteId) {
    try {
      const response = await authenticatedFetch(`${this.apiBaseUrl}/notes/${noteId}`, {
        method: 'DELETE'
      });

      if (!response.ok && response.status !== 204) {
        throw new Error(`HTTP ${response.status}`);
      }

      console.log('Note deleted:', noteId);

      this.notes = this.notes.filter(a => a.note_id !== noteId);
      this._cacheRemove(noteId);
      this.renderStickyNotes();
      this.updateSentenceHighlights();

      if (window.WriteSysRenderer && window.WriteSysRenderer.refreshRainbowBars) {
        await window.WriteSysRenderer.refreshRainbowBars();
      }

    } catch (error) {
      console.error('Failed to delete note:', error);
      alert('Failed to delete note');
    }
  },

  // One point_event on the task (027) — repeatable; independent of completion.
  async scorePoints(noteId, points) {
    try {
      const response = await authenticatedFetch(`${this.apiBaseUrl}/notes/${noteId}/points`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ points }),
      });
      if (!response.ok && response.status !== 204) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      console.error('Failed to score points:', error);
    }
  },

  async completeNote(noteId) {
    try {
      const response = await authenticatedFetch(`${this.apiBaseUrl}/notes/${noteId}/complete`, {
        method: 'POST',
      });

      if (!response.ok && response.status !== 204) {
        throw new Error(`HTTP ${response.status}`);
      }

      console.log('Note completed:', noteId);

      this.notes = this.notes.filter(a => a.note_id !== noteId);
      this._cacheRemove(noteId);

      // Jump first; refresh runs unawaited so the network roundtrip doesn't block UI.
      const shouldJump = this.notes.length === 0;

      this.renderStickyNotes();
      this.updateSentenceHighlights();

      if (shouldJump) {
        this.jumpToNextAnnotatedSentence();
      }

      if (window.WriteSysRenderer && window.WriteSysRenderer.refreshRainbowBars) {
        window.WriteSysRenderer.refreshRainbowBars();
      }

    } catch (error) {
      console.error('Failed to complete note:', error);
      alert('Failed to complete note');
    }
  },

  async updateNoteColor(noteId, color) {
    const note = this.notes.find(a => a.note_id === noteId);
    if (!note) return;

    const response = await authenticatedFetch(`${this.apiBaseUrl}/notes/${noteId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sentence_id: this.currentSentenceId,
        color: color,
        body: note.body || null,
        priority: note.priority || 'none',
        flagged: note.flagged || false
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.json();
  },

  async saveNoteText(noteId, noteText) {
    const note = this.notes.find(a => a.note_id === noteId);
    if (!note) return;

    try {
      const response = await authenticatedFetch(`${this.apiBaseUrl}/notes/${noteId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sentence_id: this.currentSentenceId,
          color: note.color,
          body: noteText.trim() || null,
          priority: note.priority || 'none',
          flagged: note.flagged || false
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      note.body = noteText.trim() || null;

    } catch (error) {
      console.error('Failed to save note:', error);
      alert('Failed to save note');
    }
  },

  // Clicking the active priority toggles it off.
  // One PUT for any dimension change (task_type / priority / impact /
  // blocked) — the widget hands us a patch; we persist + refresh the UI.
  async updateNoteDims(note, patch, noteEl) {
    Object.assign(note, patch);
    try {
      const response = await authenticatedFetch(`${this.apiBaseUrl}/notes/${note.note_id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      console.error('Failed to update note dimensions:', error);
    }
    this.updatePriorityFlagUIForNote(noteEl, note);
  },


  // Delegates to the shared widget's updater — one place decides chip
  // active states AND whether the complete checkmark shows (tasks only,
  // i.e. priority set). A local copy here once drifted past that gating.
  updatePriorityFlagUIForNote(noteEl, note) {
    window.WriteSysNoteWidget.updatePriorityFlagUI(noteEl, note);
  },

  // Tag add/remove just mutate note.tags; the shared widget owns the chip
  // re-render (so this path can't drift out of sync). Tags are user-wide now
  // (migration 020) — no migration_id; the server scopes to the note's owner.
  async addTagByName(note, noteEl, tagName) {
    if (!tagName) return;
    try {
      const data = await window.WriteSysNoteAPI.addTag(note.note_id, tagName);
      note.tags = (data && data.tags) || note.tags;
    } catch (error) {
      console.error('Failed to add tag:', error);
      alert(`Failed to add tag: ${error.message}`);
    }
  },

  async removeTag(note, tagId, tagName, noteEl) {
    try {
      await window.WriteSysNoteAPI.removeTag(note.note_id, tagId);
      note.tags = (note.tags || []).filter(t => t.tag_id !== tagId);
    } catch (error) {
      console.error('Failed to remove tag:', error);
      alert('Failed to remove tag');
    }
  },

  unselectSentence() {
    const preview = document.getElementById('sentence-preview');
    if (preview) {
      preview.classList.remove('visible');
    }

    const container = document.getElementById('sticky-notes-container');
    if (container) {
      container.classList.remove('visible');
    }

    document.querySelectorAll('.sentence.selected').forEach(s => s.classList.remove('selected'));

    if (window.WriteSysRenderer) {
      window.WriteSysRenderer.currentSelectedSentenceId = null;
    }

    this.currentSentenceId = null;
    this.currentSentenceText = '';
    this.notes = [];
  },
};

// Attached BEFORE init() so other modules can reach it during init.
window.WriteSysNotes = WriteSysNotes;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => WriteSysNotes.init());
} else {
  WriteSysNotes.init();
}
