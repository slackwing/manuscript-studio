const WriteSysAnnotations = {
  apiBaseUrl: 'api',
  currentSentenceId: null,
  currentSentenceText: '',
  annotations: [],

  COLORS: ['yellow', 'green', 'blue', 'purple', 'red', 'orange'],

  DEFAULT_COLOR: 'yellow',

  // Auto-created notes commit only on interaction; until then, blurring
  // an empty textarea cancels the annotation ("never mind").
  neverMindState: {
    annotationId: null,
    isCommitted: false
  },

  // Must match the matching CSS variables in book.css.
  SPACING: {
    PAGE_WIDTH: 576,
    ANNOTATION_WIDTH: 272,
    HORIZONTAL_GAP: 32,
  },

  init() {
    document.addEventListener('click', (e) => {
      const annotationMargin = document.getElementById('annotation-margin');
      const annotationMarginInner = document.querySelector('.annotation-margin-inner');
      const appContainer = document.getElementById('app-container');
      const pagedPages = document.querySelector('.pagedjs_pages');

      // Grey-background clicks unselect the current sentence.
      const isGreyBackground =
        e.target === annotationMargin ||
        e.target === annotationMarginInner ||
        e.target === appContainer ||
        e.target === pagedPages ||
        e.target === document.body;

      if (isGreyBackground) {
        this.unselectSentence();
      }
    });

    this.initAnnotationMargin();

    // Click sentence-preview → scroll to the currently-selected sentence.
    const preview = document.getElementById('sentence-preview');
    if (preview) {
      preview.style.cursor = 'pointer';
      preview.addEventListener('click', () => this.scrollToCurrentSentence());
    }

    console.log('WriteSys Annotations (Multi-Note) initialized');
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
  // anymore (e.g. just-completed last annotation).
  jumpToNextAnnotatedSentence() {
    const renderer = window.WriteSysRenderer;
    if (!renderer || !renderer.currentAnnotations) return;

    const annotatedIds = new Set(
      renderer.currentAnnotations.map(a => a.sentence_id).filter(Boolean)
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
    this.showAnnotationsForSentence(nextId, fullText);

    fragments[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
  },

  initAnnotationMargin() {
    const margin = document.getElementById('annotation-margin');
    if (!margin) return;

    const positionMargin = () => {
      const windowWidth = window.innerWidth;
      const marginWidth = (windowWidth - this.SPACING.PAGE_WIDTH) / 2;
      const rightPosition = marginWidth - this.SPACING.HORIZONTAL_GAP - this.SPACING.ANNOTATION_WIDTH;
      margin.style.right = `${rightPosition}px`;
    };

    positionMargin();
    window.addEventListener('resize', positionMargin);
  },

  // Mark an auto-created note as committed so "never mind" won't delete it
  // on empty-blur. Pass null to commit whichever note is currently pending.
  commitPendingNote(annotationId) {
    if (annotationId == null) {
      if (this.neverMindState.annotationId) {
        this.neverMindState.isCommitted = true;
      }
      return;
    }
    if (this.neverMindState.annotationId === annotationId) {
      this.neverMindState.isCommitted = true;
    }
  },

  // Mirror of an annotation insert into the renderer's authoritative
  // cache. Property edits (color/note/priority/flag) mutate the
  // annotation object in place, so they propagate without help; only
  // array-shape changes (push/filter) need this.
  _cacheAdd(annotation) {
    const r = window.WriteSysRenderer;
    if (r && Array.isArray(r.currentAnnotations)) r.currentAnnotations.push(annotation);
  },

  _cacheRemove(annotationId) {
    const r = window.WriteSysRenderer;
    if (r && Array.isArray(r.currentAnnotations)) {
      r.currentAnnotations = r.currentAnnotations.filter(a => a.annotation_id !== annotationId);
    }
  },

  // Reads from WriteSysRenderer.currentAnnotations (preloaded with the
  // manuscript) rather than fetching per click — clicks need to feel
  // instant. Local mutations (create/delete/complete/color/note/priority/
  // flag) keep currentAnnotations in sync, so the cache is the truth.
  showAnnotationsForSentence(sentenceId, sentenceText) {
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

    const all = (window.WriteSysRenderer && window.WriteSysRenderer.currentAnnotations) || [];
    this.annotations = all.filter(a => a.sentence_id === sentenceId);

    this.renderStickyNotes();
    // Don't auto-focus the first note. Sentence stays grey-selected
    // until the user explicitly clicks into a note's textarea — at
    // which point the focus listener tints the sentence in that
    // note's color. (The uncreated/empty note still gets focus when
    // there are no real notes; see renderStickyNotes.)
    if (this.annotations.length === 0) {
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

    this.annotations.forEach(annotation => {
      const noteElement = this.createStickyNoteElement(annotation);
      container.appendChild(noteElement);
    });

    // First note shows full grey UI; subsequent show gradient with a + sign.
    const isFirstNote = this.annotations.length === 0;
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

  createStickyNoteElement(annotation) {
    const note = document.createElement('div');
    note.className = 'sticky-note';
    note.dataset.annotationId = annotation.annotation_id;

    if (annotation.color) {
      note.classList.add(`color-${annotation.color}`);
    }

    // Note text always goes via .value, never innerHTML — stored-XSS defense.
    // See test-xss-annotation.js.
    note.innerHTML = `
      <div class="note-container">
        <textarea class="note-input" placeholder="Write a note..." rows="3"></textarea>
      </div>
      <div class="sticky-bottom-controls">
        <div class="tags-container">
          <div class="tags-list"></div>
        </div>
      </div>
      <div class="priority-flag-container" style="display: ${annotation.color ? 'flex' : 'none'}">
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
              <path d="M6 2h8M3 5h14M5 5l1 12h8l1-12M8 8v6M12 8v6"
                    stroke="currentColor" fill="none" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
          </div>
          <div class="complete-check" title="Mark complete">
            <svg width="14" height="14" viewBox="0 0 20 20">
              <path d="M4 10l4 4 8-8"
                    stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>
        </div>
      </div>
    `;

    const colorCircle = this.createColorCircleElement(annotation);
    note.appendChild(colorCircle);

    this.setupNoteEventListeners(note, annotation);
    this.renderTagsForNote(note, annotation.tags || []);
    this.updatePriorityFlagUIForNote(note, annotation);

    const textarea = note.querySelector('.note-input');
    textarea.value = annotation.note || '';
    this.autoResizeTextarea(textarea);

    return note;
  },

  createColorCircleElement(annotation) {
    const circle = document.createElement('div');
    circle.className = 'sticky-note-color-circle';

    // Rainbow gradient for uncommitted notes.
    if (!annotation.color) {
      circle.classList.add('rainbow');
    } else {
      circle.classList.add(`color-${annotation.color}`);
    }

    const palette = this.createPaletteElement(annotation);
    circle.appendChild(palette);

    circle.addEventListener('mouseenter', () => {
      palette.classList.add('visible');
    });

    // Delay hide so the cursor can reach the palette.
    let hideTimeout;
    circle.addEventListener('mouseleave', () => {
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

    return circle;
  },

  createPaletteElement(annotation) {
    const palette = document.createElement('div');
    palette.className = 'sticky-note-palette';

    // Grey notes show all 6; a colored note shows the other 5 for swapping.
    const colorsToShow = annotation.color
      ? this.COLORS.filter(c => c !== annotation.color)
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
        this.handleColorSelectionForNote(annotation.annotation_id, color);
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
        const annotation = await this.handleAddNewNote(this.DEFAULT_COLOR, initialText, textarea);

        if (annotation && annotation.annotation_id) {
          this.neverMindState.annotationId = annotation.annotation_id;
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

  setupNoteEventListeners(note, annotation) {
    const textarea = note.querySelector('.note-input');
    let saveTimeout;

    // Caret-in-note → tint the sentence in this note's color. Caret-out
    // → strip the tint. The "second click on a sentence to edit" flow
    // is just blur of the note, so this handles it implicitly. If the
    // user moves caret between two notes on the same sentence, blur
    // fires for the first and focus for the second; net result is the
    // new colour, which is the correct end state.
    textarea.addEventListener('focus', () => {
      this.applyFocusHighlight(annotation.sentence_id, annotation.color);
    });
    textarea.addEventListener('blur', () => {
      this.clearFocusHighlight(annotation.sentence_id);
    });

    textarea.addEventListener('input', async () => {
      this.autoResizeTextarea(textarea);

      // "Never mind": empty an auto-created, uncommitted note → delete.
      if (this.neverMindState.annotationId === annotation.annotation_id &&
          !this.neverMindState.isCommitted &&
          textarea.value.trim().length === 0) {
        clearTimeout(saveTimeout);
        await this.deleteAnnotation(annotation.annotation_id);
        this.neverMindState.annotationId = null;
        this.neverMindState.isCommitted = false;
        const freshTextarea = document.querySelector(
          '.sticky-note.uncreated-note.first-uncreated .note-input'
        );
        if (freshTextarea) freshTextarea.focus();
        return;
      }

      clearTimeout(saveTimeout);
      saveTimeout = setTimeout(() => {
        this.saveNoteText(annotation.annotation_id, textarea.value);
      }, 1000);
    });

    textarea.addEventListener('blur', () => {
      this.commitPendingNote(annotation.annotation_id);

      clearTimeout(saveTimeout);
      this.saveNoteText(annotation.annotation_id, textarea.value);
    });

    note.querySelectorAll('.priority-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        this.commitPendingNote(annotation.annotation_id);
        const priority = chip.dataset.priority;
        this.handlePriorityClick(annotation, priority, note);
      });
    });

    const flagChip = note.querySelector('.flag-chip');
    if (flagChip) {
      flagChip.addEventListener('click', () => {
        this.commitPendingNote(annotation.annotation_id);
        this.handleFlagClick(annotation, note);
      });
    }

    const tagsList = note.querySelector('.tags-list');
    if (tagsList) {
      tagsList.addEventListener('click', (e) => {
        this.commitPendingNote(annotation.annotation_id);

        if (e.target.classList.contains('tag-chip-remove')) {
          const tagChip = e.target.closest('.tag-chip');
          const tagId = parseInt(tagChip.dataset.tagId);
          const tagName = tagChip.dataset.tagName;
          this.removeTag(annotation, tagId, tagName, note);
        } else if (e.target.classList.contains('new-tag') || e.target.closest('.new-tag')) {
          this.addNewTag(annotation, note);
        }
      });
    }

    // Two-click trash with 2s confirmation window.
    const trash = note.querySelector('.note-trash');
    if (trash) {
      let clickCount = 0;
      let resetTimeout;

      trash.addEventListener('click', (e) => {
        e.stopPropagation();

        if (clickCount === 0) {
          trash.classList.add('confirming');
          clickCount = 1;

          resetTimeout = setTimeout(() => {
            trash.classList.remove('confirming');
            clickCount = 0;
          }, 2000);
        } else {
          clearTimeout(resetTimeout);
          this.deleteAnnotation(annotation.annotation_id);
        }
      });
    }

    // Two-click complete with 2s confirmation window.
    const check = note.querySelector('.complete-check');
    if (check) {
      let clickCount = 0;
      let resetTimeout;

      check.addEventListener('click', (e) => {
        e.stopPropagation();

        if (clickCount === 0) {
          check.classList.add('confirming');
          clickCount = 1;

          resetTimeout = setTimeout(() => {
            check.classList.remove('confirming');
            clickCount = 0;
          }, 2000);
        } else {
          clearTimeout(resetTimeout);
          this.completeAnnotation(annotation.annotation_id);
        }
      });
    }
  },

  autoResizeTextarea(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = textarea.scrollHeight + 'px';
  },

  async handleColorSelectionForNote(annotationId, color) {
    const annotation = this.annotations.find(a => a.annotation_id === annotationId);
    if (!annotation) return;

    this.commitPendingNote(annotationId);

    try {
      await this.updateAnnotationColor(annotationId, color);
      annotation.color = color;

      this.renderStickyNotes();

      // renderStickyNotes recreates the DOM, dropping focus from the
      // old textarea (and with it the focus-tint). Restore focus to
      // the same annotation so the user keeps their typing context
      // and the sentence picks up the new color.
      const note = document.querySelector(`.sticky-note[data-annotation-id="${annotationId}"] .note-input`);
      if (note) {
        note.focus();
        note.setSelectionRange(note.value.length, note.value.length);
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
    if (!this.currentSentenceId) return;

    try {
      const response = await authenticatedFetch(`${this.apiBaseUrl}/annotations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sentence_id: this.currentSentenceId,
          color: color,
          note: initialNote,
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

      const newAnnotation = {
        annotation_id: apiResponse.annotation_id,
        sentence_id: this.currentSentenceId,
        color: color,
        note: liveText,
        priority: 'none',
        flagged: false,
        tags: []
      };

      this.annotations.push(newAnnotation);
      this._cacheAdd(newAnnotation);
      this.renderStickyNotes();

      // Move in-flight text into the new real-note textarea and persist any
      // characters typed past what we already POSTed.
      const newTextarea = document.querySelector(
        `.sticky-note[data-annotation-id="${apiResponse.annotation_id}"] .note-input`
      );
      if (newTextarea) {
        newTextarea.value = liveText || '';
        this.autoResizeTextarea(newTextarea);
        newTextarea.focus();
        const end = newTextarea.value.length;
        newTextarea.setSelectionRange(end, end);
        if (sourceTextarea && (liveText || '') !== (initialNote || '')) {
          this.saveNoteText(apiResponse.annotation_id, liveText);
        }
      }

      this.updateSentenceHighlights();

      if (window.WriteSysRenderer && window.WriteSysRenderer.refreshRainbowBars) {
        await window.WriteSysRenderer.refreshRainbowBars();
      }

      return newAnnotation;

    } catch (error) {
      console.error('Failed to create annotation:', error);
      alert('Failed to create annotation');
      return null;
    }
  },

  // No-op now. Sentence backgrounds are driven by note focus
  // (applyFocusHighlight / clearFocusHighlight) rather than annotation
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

  async deleteAnnotation(annotationId) {
    try {
      const response = await authenticatedFetch(`${this.apiBaseUrl}/annotations/${annotationId}`, {
        method: 'DELETE'
      });

      if (!response.ok && response.status !== 204) {
        throw new Error(`HTTP ${response.status}`);
      }

      console.log('Annotation deleted:', annotationId);

      this.annotations = this.annotations.filter(a => a.annotation_id !== annotationId);
      this._cacheRemove(annotationId);
      this.renderStickyNotes();
      this.updateSentenceHighlights();

      if (window.WriteSysRenderer && window.WriteSysRenderer.refreshRainbowBars) {
        await window.WriteSysRenderer.refreshRainbowBars();
      }

    } catch (error) {
      console.error('Failed to delete annotation:', error);
      alert('Failed to delete annotation');
    }
  },

  async completeAnnotation(annotationId) {
    try {
      const response = await authenticatedFetch(`${this.apiBaseUrl}/annotations/${annotationId}/complete`, {
        method: 'POST'
      });

      if (!response.ok && response.status !== 204) {
        throw new Error(`HTTP ${response.status}`);
      }

      console.log('Annotation completed:', annotationId);

      this.annotations = this.annotations.filter(a => a.annotation_id !== annotationId);
      this._cacheRemove(annotationId);

      // Jump first; refresh runs unawaited so the network roundtrip doesn't block UI.
      const shouldJump = this.annotations.length === 0;

      this.renderStickyNotes();
      this.updateSentenceHighlights();

      if (shouldJump) {
        this.jumpToNextAnnotatedSentence();
      }

      if (window.WriteSysRenderer && window.WriteSysRenderer.refreshRainbowBars) {
        window.WriteSysRenderer.refreshRainbowBars();
      }

    } catch (error) {
      console.error('Failed to complete annotation:', error);
      alert('Failed to complete annotation');
    }
  },

  async updateAnnotationColor(annotationId, color) {
    const annotation = this.annotations.find(a => a.annotation_id === annotationId);
    if (!annotation) return;

    const response = await authenticatedFetch(`${this.apiBaseUrl}/annotations/${annotationId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sentence_id: this.currentSentenceId,
        color: color,
        note: annotation.note || null,
        priority: annotation.priority || 'none',
        flagged: annotation.flagged || false
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.json();
  },

  async saveNoteText(annotationId, noteText) {
    const annotation = this.annotations.find(a => a.annotation_id === annotationId);
    if (!annotation) return;

    try {
      const response = await authenticatedFetch(`${this.apiBaseUrl}/annotations/${annotationId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sentence_id: this.currentSentenceId,
          color: annotation.color,
          note: noteText.trim() || null,
          priority: annotation.priority || 'none',
          flagged: annotation.flagged || false
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      annotation.note = noteText.trim() || null;

    } catch (error) {
      console.error('Failed to save note:', error);
      alert('Failed to save note');
    }
  },

  // Clicking the active priority toggles it off.
  async handlePriorityClick(annotation, priority, note) {
    const newPriority = (annotation.priority === priority) ? 'none' : priority;

    try {
      const response = await authenticatedFetch(`${this.apiBaseUrl}/annotations/${annotation.annotation_id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sentence_id: this.currentSentenceId,
          color: annotation.color,
          note: annotation.note || null,
          priority: newPriority,
          flagged: annotation.flagged || false
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      annotation.priority = newPriority;
      this.updatePriorityFlagUIForNote(note, annotation);

    } catch (error) {
      console.error('Failed to update priority:', error);
      alert('Failed to update priority');
    }
  },

  async handleFlagClick(annotation, note) {
    const newFlagged = !annotation.flagged;

    try {
      const response = await authenticatedFetch(`${this.apiBaseUrl}/annotations/${annotation.annotation_id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sentence_id: this.currentSentenceId,
          color: annotation.color,
          note: annotation.note || null,
          priority: annotation.priority || 'none',
          flagged: newFlagged
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      annotation.flagged = newFlagged;
      this.updatePriorityFlagUIForNote(note, annotation);

    } catch (error) {
      console.error('Failed to update flag:', error);
      alert('Failed to update flag');
    }
  },

  updatePriorityFlagUIForNote(note, annotation) {
    note.querySelectorAll('.priority-chip').forEach(chip => {
      const priority = chip.dataset.priority;
      if (annotation.priority === priority) {
        chip.classList.add('active');
      } else {
        chip.classList.remove('active');
      }
    });

    const flagChip = note.querySelector('.flag-chip');
    if (flagChip) {
      if (annotation.flagged) {
        flagChip.classList.add('active');
      } else {
        flagChip.classList.remove('active');
      }
    }
  },

  // Uses createElement + textContent — defense in depth even though tag
  // names are server-validated.
  renderTagsForNote(note, tags) {
    const tagsList = note.querySelector('.tags-list');
    if (!tagsList) return;

    tagsList.innerHTML = '';

    tags.forEach(tag => {
      const chip = document.createElement('div');
      chip.className = 'tag-chip';
      chip.dataset.tagId = tag.tag_id;
      chip.dataset.tagName = tag.tag_name;

      const nameSpan = document.createElement('span');
      nameSpan.textContent = tag.tag_name;
      chip.appendChild(nameSpan);

      const removeSpan = document.createElement('span');
      removeSpan.className = 'tag-chip-remove';
      removeSpan.textContent = '×';
      chip.appendChild(removeSpan);

      tagsList.appendChild(chip);
    });

    const newTagChip = document.createElement('div');
    newTagChip.className = 'tag-chip new-tag';
    newTagChip.textContent = '+ tag';
    tagsList.appendChild(newTagChip);
  },

  async addNewTag(annotation, note) {
    const tagsList = note.querySelector('.tags-list');
    const newTagChip = tagsList.querySelector('.new-tag');

    const editableChip = document.createElement('div');
    editableChip.className = 'tag-chip editable-tag';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'tag-input';
    input.placeholder = 'tag-name';
    input.maxLength = 50;

    editableChip.appendChild(input);
    tagsList.insertBefore(editableChip, newTagChip);
    input.focus();

    let cancelled = false;

    const finishTagCreation = async () => {
      if (cancelled) return;

      const tagName = input.value.trim();
      editableChip.remove();

      if (!tagName) return;

      const valid = /^[a-z0-9-]+$/.test(tagName);
      if (!valid) {
        alert('Invalid tag name. Use only lowercase letters, numbers, and dashes.');
        return;
      }

      try {
        const migrationId = window.WriteSysRenderer?.currentMigrationID;
        if (!migrationId) {
          throw new Error('Migration ID not available');
        }

        const response = await authenticatedFetch(`${this.apiBaseUrl}/annotations/${annotation.annotation_id}/tags`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tag_name: tagName,
            migration_id: migrationId
          })
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
        annotation.tags = data.tags;
        this.renderTagsForNote(note, data.tags);

      } catch (error) {
        console.error('Failed to add tag:', error);
        alert(`Failed to add tag: ${error.message}`);
      }
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Tab') {
        e.preventDefault();
        finishTagCreation();
      } else if (e.key === 'Escape') {
        cancelled = true;
        editableChip.remove();
      }
    });

    input.addEventListener('blur', finishTagCreation);
  },

  async removeTag(annotation, tagId, tagName, note) {
    try {
      const response = await authenticatedFetch(`${this.apiBaseUrl}/annotations/${annotation.annotation_id}/tags/${tagId}`, {
        method: 'DELETE'
      });

      if (!response.ok && response.status !== 204) {
        throw new Error(`HTTP ${response.status}`);
      }

      annotation.tags = annotation.tags.filter(t => t.tag_id !== tagId);
      this.renderTagsForNote(note, annotation.tags);

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
    this.annotations = [];
  },
};

// Attached BEFORE init() so other modules can reach it during init.
window.WriteSysAnnotations = WriteSysAnnotations;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => WriteSysAnnotations.init());
} else {
  WriteSysAnnotations.init();
}
