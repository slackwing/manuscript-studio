// WriteSys Annotations - Multi-Note Support
// Handles multiple annotations per sentence with per-note color controls

const WriteSysAnnotations = {
  apiBaseUrl: 'api',
  currentSentenceId: null,
  currentSentenceText: '',
  annotations: [], // Array of all annotations for current sentence

  // Available annotation colors
  COLORS: ['yellow', 'green', 'blue', 'purple', 'red', 'orange'],

  // Default color for new annotations
  DEFAULT_COLOR: 'yellow',

  // Track "never mind" state for auto-created notes
  neverMindState: {
    annotationId: null,  // ID of the auto-created annotation
    isCommitted: false   // Whether user has committed (clicked anything)
  },

  // Spacing constants - must match CSS variables in book.css
  SPACING: {
    PAGE_WIDTH: 576,           // Width of .pagedjs_page
    ANNOTATION_WIDTH: 272,     // --annotation-width (240 + 32px page gap)
    HORIZONTAL_GAP: 32,        // --horizontal-gap (page to annotation margin)
  },

  /**
   * Initialize annotations module
   */
  init() {
    // Click on grey background (margins) to unselect sentence
    document.addEventListener('click', (e) => {
      const annotationMargin = document.getElementById('annotation-margin');
      const annotationMarginInner = document.querySelector('.annotation-margin-inner');
      const appContainer = document.getElementById('app-container');
      const pagedPages = document.querySelector('.pagedjs_pages');

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

    // Initialize annotation margin positioning
    this.initAnnotationMargin();

    console.log('WriteSys Annotations (Multi-Note) initialized');
  },

  /**
   * Initialize and position the annotation margin container
   */
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

  /**
   * Show annotations for a specific sentence
   * @param {string} sentenceId - The ID of the sentence to annotate
   * @param {string} sentenceText - The full text of the sentence
   */
  async showAnnotationsForSentence(sentenceId, sentenceText) {
    // Switching sentences commits any pending note
    if (this.neverMindState.annotationId) {
      this.neverMindState.isCommitted = true;
    }

    this.currentSentenceId = sentenceId;
    this.currentSentenceText = sentenceText;

    // Show sentence preview (first 3 words)
    const preview = document.getElementById('sentence-preview');
    if (preview) {
      const words = sentenceText.trim().split(/\s+/);
      let firstThreeWords = words.slice(0, 3).join(' ');
      firstThreeWords = firstThreeWords.replace(/\W+$/, '');
      preview.textContent = `${firstThreeWords}...`;
      preview.classList.add('visible');
    }

    // Fetch annotations for this sentence
    try {
      const response = await authenticatedFetch(`${this.apiBaseUrl}/annotations/sentence/${sentenceId}`);
      if (!response.ok) {
        if (response.status === 404) {
          this.annotations = [];
        } else {
          throw new Error(`HTTP ${response.status}`);
        }
      } else {
        const data = await response.json();
        this.annotations = data.annotations || [];
      }

      // Render all sticky notes
      this.renderStickyNotes();

    } catch (error) {
      console.error('Failed to fetch annotations:', error);
      this.annotations = [];
      this.renderStickyNotes();
    }
  },

  /**
   * Render all sticky notes for the current sentence
   */
  renderStickyNotes() {
    const container = document.getElementById('sticky-notes-container');
    if (!container) return;

    // Clear container
    container.innerHTML = '';

    // Render each existing annotation
    this.annotations.forEach(annotation => {
      const noteElement = this.createStickyNoteElement(annotation);
      container.appendChild(noteElement);
    });

    // Add "add new note" element
    // First note: full grey UI, subsequent notes: gradient with + sign
    const isFirstNote = this.annotations.length === 0;
    const addNewNote = this.createAddNewNoteElement(isFirstNote);
    container.appendChild(addNewNote);

    // Show container
    container.classList.add('visible');
  },

  /**
   * Create a sticky note DOM element
   * @param {Object} annotation - The annotation object
   * @returns {HTMLElement} The sticky note element
   */
  createStickyNoteElement(annotation) {
    const note = document.createElement('div');
    note.className = 'sticky-note';
    note.dataset.annotationId = annotation.annotation_id;

    // Add color class if annotation has color
    if (annotation.color) {
      note.classList.add(`color-${annotation.color}`);
    }

    // Create note structure
    note.innerHTML = `
      <div class="note-container">
        <textarea class="note-input" placeholder="Write a note..." rows="3">${annotation.note || ''}</textarea>
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
          <div class="priority-chip" data-priority="P3">P3</div>
          <div class="flag-chip" data-flag="true" title="Flag">
            <svg width="20" height="20" viewBox="0 0 20 20" class="flag-icon">
              <path class="flag-staff" d="M4 1v18"/>
              <path class="flag-shape" d="M4 3h10l-2.5 5 2.5 5H4"/>
            </svg>
          </div>
        </div>
        <div class="note-trash" title="Delete note">
          <svg width="16" height="16" viewBox="0 0 20 20">
            <path d="M6 2h8M3 5h14M5 5l1 12h8l1-12M8 8v6M12 8v6"
                  stroke="currentColor" fill="none" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
        </div>
      </div>
    `;

    // Add color circle
    const colorCircle = this.createColorCircleElement(annotation);
    note.appendChild(colorCircle);

    // Setup event listeners
    this.setupNoteEventListeners(note, annotation);

    // Render tags
    this.renderTagsForNote(note, annotation.tags || []);

    // Update priority/flag UI
    this.updatePriorityFlagUIForNote(note, annotation);

    // Auto-resize textarea
    const textarea = note.querySelector('.note-input');
    this.autoResizeTextarea(textarea);

    return note;
  },

  /**
   * Create color circle element for a sticky note
   * @param {Object} annotation - The annotation object
   * @returns {HTMLElement} The color circle element
   */
  createColorCircleElement(annotation) {
    const circle = document.createElement('div');
    circle.className = 'sticky-note-color-circle';

    // Rainbow gradient for grey (uncommitted) notes
    if (!annotation.color) {
      circle.classList.add('rainbow');
    } else {
      circle.classList.add(`color-${annotation.color}`);
    }

    // Create palette
    const palette = this.createPaletteElement(annotation);
    circle.appendChild(palette);

    // Show palette on hover
    circle.addEventListener('mouseenter', () => {
      palette.classList.add('visible');
    });

    // Hide palette on mouse leave (with delay to allow clicking)
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

  /**
   * Create expandable palette element
   * @param {Object} annotation - The annotation object
   * @returns {HTMLElement} The palette element
   */
  createPaletteElement(annotation) {
    const palette = document.createElement('div');
    palette.className = 'sticky-note-palette';

    // Determine which colors to show
    const colorsToShow = annotation.color
      ? this.COLORS.filter(c => c !== annotation.color)  // Show 5 other colors
      : this.COLORS;  // Show all 6 colors for grey notes

    // Add color circles (wrapped in divs for hover zones)
    colorsToShow.forEach(color => {
      const wrapper = document.createElement('div');

      const colorCircle = document.createElement('div');
      colorCircle.className = 'color-circle';
      colorCircle.dataset.color = color;

      // Set background color using CSS variables
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

  /**
   * Create "add new note" element
   * @param {boolean} isFirstNote - Whether this is the first uncreated note
   * @returns {HTMLElement} The add new note element
   */
  createAddNewNoteElement(isFirstNote) {
    if (isFirstNote) {
      // First note: full grey sticky note UI
      return this.createFirstUncreatedNote();
    } else {
      // Subsequent notes: gradient with + sign
      return this.createSubsequentUncreatedNote();
    }
  },

  /**
   * Setup textarea handlers for creating a new note
   * @param {HTMLElement} note - The note element
   * @param {HTMLTextAreaElement} textarea - The textarea element
   * @param {HTMLElement} colorCircle - The color circle element
   * @param {boolean} requiresHover - Whether the note needs hover handling
   */
  setupUncreatedNoteHandlers(note, textarea, colorCircle, requiresHover) {
    let noteCreated = false;
    let isCreating = false; // Guard against multiple rapid inputs

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
        const currentText = e.target.value;
        const annotation = await this.handleAddNewNote(this.DEFAULT_COLOR, currentText);

        // Track this as a "never mind" candidate until user commits
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

  /**
   * Create first uncreated note (full grey UI)
   * @returns {HTMLElement} The note element
   */
  createFirstUncreatedNote() {
    const note = document.createElement('div');
    note.className = 'sticky-note uncreated-note first-uncreated';

    // Create note structure
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

    // Add color circle (rainbow)
    const colorCircle = this.createColorCircleForUncreated();
    note.appendChild(colorCircle);

    // Setup event handlers
    const textarea = note.querySelector('.note-input');
    this.setupUncreatedNoteHandlers(note, textarea, colorCircle, false);

    return note;
  },

  /**
   * Create subsequent uncreated note (gradient with + sign)
   * @returns {HTMLElement} The note element
   */
  createSubsequentUncreatedNote() {
    const note = document.createElement('div');
    note.className = 'sticky-note uncreated-note subsequent-uncreated';

    // Create note structure (same as first, but will be styled with gradient)
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

    // Add color circle (rainbow)
    const colorCircle = this.createColorCircleForUncreated();
    note.appendChild(colorCircle);

    // Setup event handlers
    const textarea = note.querySelector('.note-input');
    this.setupUncreatedNoteHandlers(note, textarea, colorCircle, true);

    // On hover, show full UI
    note.addEventListener('mouseenter', () => {
      note.classList.add('hovered');
      colorCircle.style.opacity = '1';
      colorCircle.style.transform = 'scale(1)';
    });

    note.addEventListener('mouseleave', () => {
      // Only remove hover if not focused
      if (document.activeElement !== textarea) {
        note.classList.remove('hovered');
        colorCircle.style.opacity = '0';
        colorCircle.style.transform = 'scale(0.8)';
      }
    });

    return note;
  },

  /**
   * Create color circle for uncreated notes
   * @returns {HTMLElement} The color circle element
   */
  createColorCircleForUncreated() {
    const colorCircle = document.createElement('div');
    colorCircle.className = 'sticky-note-color-circle rainbow';

    // Create palette with all 6 colors
    const palette = this.createAddNotePaletteElement();
    colorCircle.appendChild(palette);

    // Show palette on hover
    colorCircle.addEventListener('mouseenter', () => {
      palette.classList.add('visible');
    });

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

  /**
   * Create palette for add-new-note element
   * @returns {HTMLElement} The palette element
   */
  createAddNotePaletteElement() {
    const palette = document.createElement('div');
    palette.className = 'sticky-note-palette';

    // Add all 6 color circles (wrapped in divs for hover zones)
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

  /**
   * Setup event listeners for a sticky note
   * @param {HTMLElement} note - The sticky note element
   * @param {Object} annotation - The annotation object
   */
  setupNoteEventListeners(note, annotation) {
    // Note input
    const textarea = note.querySelector('.note-input');
    let saveTimeout;

    textarea.addEventListener('input', async () => {
      this.autoResizeTextarea(textarea);

      // Check for "never mind" - empty text on uncommitted auto-created note
      if (this.neverMindState.annotationId === annotation.annotation_id &&
          !this.neverMindState.isCommitted &&
          textarea.value.trim().length === 0) {
        // Never mind - delete the annotation and revert to grey
        clearTimeout(saveTimeout);
        await this.deleteAnnotation(annotation.annotation_id);
        this.neverMindState.annotationId = null;
        this.neverMindState.isCommitted = false;
        return; // Don't save
      }

      // Auto-save after 1 second
      clearTimeout(saveTimeout);
      saveTimeout = setTimeout(() => {
        this.saveNoteText(annotation.annotation_id, textarea.value);
      }, 1000);
    });

    textarea.addEventListener('blur', () => {
      // Losing focus commits the note
      if (this.neverMindState.annotationId === annotation.annotation_id) {
        this.neverMindState.isCommitted = true;
      }

      clearTimeout(saveTimeout);
      this.saveNoteText(annotation.annotation_id, textarea.value);
    });

    // Priority chips
    note.querySelectorAll('.priority-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        // Clicking commits the note
        if (this.neverMindState.annotationId === annotation.annotation_id) {
          this.neverMindState.isCommitted = true;
        }
        const priority = chip.dataset.priority;
        this.handlePriorityClick(annotation, priority, note);
      });
    });

    // Flag chip
    const flagChip = note.querySelector('.flag-chip');
    if (flagChip) {
      flagChip.addEventListener('click', () => {
        // Clicking commits the note
        if (this.neverMindState.annotationId === annotation.annotation_id) {
          this.neverMindState.isCommitted = true;
        }
        this.handleFlagClick(annotation, note);
      });
    }

    // Tags
    const tagsList = note.querySelector('.tags-list');
    if (tagsList) {
      tagsList.addEventListener('click', (e) => {
        // Clicking commits the note
        if (this.neverMindState.annotationId === annotation.annotation_id) {
          this.neverMindState.isCommitted = true;
        }

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

    // Trash icon
    const trash = note.querySelector('.note-trash');
    if (trash) {
      let clickCount = 0;
      let resetTimeout;

      trash.addEventListener('click', (e) => {
        e.stopPropagation();

        if (clickCount === 0) {
          // First click - show confirmation
          trash.classList.add('confirming');
          clickCount = 1;

          // Reset after 2 seconds
          resetTimeout = setTimeout(() => {
            trash.classList.remove('confirming');
            clickCount = 0;
          }, 2000);
        } else {
          // Second click - actually delete
          clearTimeout(resetTimeout);
          this.deleteAnnotation(annotation.annotation_id);
        }
      });
    }
  },

  /**
   * Auto-resize textarea to fit content
   * @param {HTMLTextAreaElement} textarea - The textarea element
   */
  autoResizeTextarea(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = textarea.scrollHeight + 'px';
  },

  /**
   * Handle color selection for a specific note
   * @param {number} annotationId - The annotation ID
   * @param {string} color - The color name
   */
  async handleColorSelectionForNote(annotationId, color) {
    const annotation = this.annotations.find(a => a.annotation_id === annotationId);
    if (!annotation) return;

    // Clicking color commits the note
    if (this.neverMindState.annotationId === annotationId) {
      this.neverMindState.isCommitted = true;
    }

    try {
      // Update annotation color via API
      await this.updateAnnotationColor(annotationId, color);

      // Update local annotation
      annotation.color = color;

      // Re-render to update UI
      this.renderStickyNotes();

      // Update sentence highlights
      this.updateSentenceHighlights();

      // Update rainbow bars for all sentences
      if (window.WriteSysRenderer && window.WriteSysRenderer.refreshRainbowBars) {
        await window.WriteSysRenderer.refreshRainbowBars();
      }

    } catch (error) {
      console.error('Failed to update color:', error);
      alert('Failed to update color');
    }
  },

  /**
   * Handle adding a new note
   * @param {string} color - The initial color
   * @param {string} initialNote - Optional initial note text
   */
  async handleAddNewNote(color, initialNote = null) {
    if (!this.currentSentenceId) return;

    try {
      // Create new annotation
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

      // Add to local array
      const newAnnotation = {
        annotation_id: apiResponse.annotation_id,
        sentence_id: this.currentSentenceId,
        color: color,
        note: initialNote,
        priority: 'none',
        flagged: false,
        tags: []
      };

      this.annotations.push(newAnnotation);

      // Re-render
      this.renderStickyNotes();

      // Restore focus to the newly created note's textarea
      const newNoteElement = document.querySelector(`.sticky-note[data-annotation-id="${apiResponse.annotation_id}"]`);
      if (newNoteElement) {
        const textarea = newNoteElement.querySelector('.note-input');
        if (textarea) {
          textarea.focus();
          // Move cursor to end
          textarea.setSelectionRange(textarea.value.length, textarea.value.length);
        }
      }

      // Update sentence highlights
      this.updateSentenceHighlights();

      // Update rainbow bars for all sentences
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

  /**
   * Update sentence highlights for all annotations
   */
  updateSentenceHighlights() {
    if (!this.currentSentenceId) return;

    const sentenceFragments = document.querySelectorAll(`.sentence[data-sentence-id="${this.currentSentenceId}"]`);

    // Remove all highlight classes
    sentenceFragments.forEach(fragment => {
      this.COLORS.forEach(c => fragment.classList.remove(`highlight-${c}`));
    });

    // Apply highlights based on annotations
    // If multiple annotations, apply the first color (could be customized)
    if (this.annotations.length > 0 && this.annotations[0].color) {
      const color = this.annotations[0].color;
      sentenceFragments.forEach(fragment => {
        fragment.classList.add(`highlight-${color}`);
      });
    }
  },

  /**
   * Delete annotation
   * @param {number} annotationId - The annotation ID
   */
  async deleteAnnotation(annotationId) {
    try {
      const response = await authenticatedFetch(`${this.apiBaseUrl}/annotations/${annotationId}`, {
        method: 'DELETE'
      });

      if (!response.ok && response.status !== 204) {
        throw new Error(`HTTP ${response.status}`);
      }

      console.log('Annotation deleted:', annotationId);

      // Remove from local array
      this.annotations = this.annotations.filter(a => a.annotation_id !== annotationId);

      // Re-render
      this.renderStickyNotes();

      // Update sentence highlights
      this.updateSentenceHighlights();

      // Update rainbow bars for all sentences
      if (window.WriteSysRenderer && window.WriteSysRenderer.refreshRainbowBars) {
        await window.WriteSysRenderer.refreshRainbowBars();
      }

    } catch (error) {
      console.error('Failed to delete annotation:', error);
      alert('Failed to delete annotation');
    }
  },

  /**
   * Update annotation color via API
   * @param {number} annotationId - The annotation ID
   * @param {string} color - The new color
   */
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

  /**
   * Save note text
   * @param {number} annotationId - The annotation ID
   * @param {string} noteText - The note text
   */
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

      // Update local annotation
      annotation.note = noteText.trim() || null;

    } catch (error) {
      console.error('Failed to save note:', error);
      alert('Failed to save note');
    }
  },

  /**
   * Handle priority chip click
   * @param {Object} annotation - The annotation object
   * @param {string} priority - The priority value (P0, P1, P2, P3)
   * @param {HTMLElement} note - The note element
   */
  async handlePriorityClick(annotation, priority, note) {
    // Toggle behavior
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

      // Update local annotation
      annotation.priority = newPriority;

      // Update UI
      this.updatePriorityFlagUIForNote(note, annotation);

    } catch (error) {
      console.error('Failed to update priority:', error);
      alert('Failed to update priority');
    }
  },

  /**
   * Handle flag chip click
   * @param {Object} annotation - The annotation object
   * @param {HTMLElement} note - The note element
   */
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

      // Update local annotation
      annotation.flagged = newFlagged;

      // Update UI
      this.updatePriorityFlagUIForNote(note, annotation);

    } catch (error) {
      console.error('Failed to update flag:', error);
      alert('Failed to update flag');
    }
  },

  /**
   * Update priority/flag UI for a note
   * @param {HTMLElement} note - The note element
   * @param {Object} annotation - The annotation object
   */
  updatePriorityFlagUIForNote(note, annotation) {
    // Update priority chips
    note.querySelectorAll('.priority-chip').forEach(chip => {
      const priority = chip.dataset.priority;
      if (annotation.priority === priority) {
        chip.classList.add('active');
      } else {
        chip.classList.remove('active');
      }
    });

    // Update flag chip
    const flagChip = note.querySelector('.flag-chip');
    if (flagChip) {
      if (annotation.flagged) {
        flagChip.classList.add('active');
      } else {
        flagChip.classList.remove('active');
      }
    }
  },

  /**
   * Render tags for a note
   * @param {HTMLElement} note - The note element
   * @param {Array} tags - The tags array
   */
  renderTagsForNote(note, tags) {
    const tagsList = note.querySelector('.tags-list');
    if (!tagsList) return;

    tagsList.innerHTML = '';

    // Render existing tags
    tags.forEach(tag => {
      const chip = document.createElement('div');
      chip.className = 'tag-chip';
      chip.dataset.tagId = tag.tag_id;
      chip.dataset.tagName = tag.tag_name;
      chip.innerHTML = `
        <span>${tag.tag_name}</span>
        <span class="tag-chip-remove">×</span>
      `;
      tagsList.appendChild(chip);
    });

    // Add "new tag" chip
    const newTagChip = document.createElement('div');
    newTagChip.className = 'tag-chip new-tag';
    newTagChip.innerHTML = '+ tag';
    tagsList.appendChild(newTagChip);
  },

  /**
   * Add new tag
   * @param {Object} annotation - The annotation object
   * @param {HTMLElement} note - The note element
   */
  async addNewTag(annotation, note) {
    const tagsList = note.querySelector('.tags-list');
    const newTagChip = tagsList.querySelector('.new-tag');

    // Create editable input
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

      // Validate tag name
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

  /**
   * Remove tag
   * @param {Object} annotation - The annotation object
   * @param {number} tagId - The tag ID
   * @param {string} tagName - The tag name
   * @param {HTMLElement} note - The note element
   */
  async removeTag(annotation, tagId, tagName, note) {
    try {
      const response = await authenticatedFetch(`${this.apiBaseUrl}/annotations/${annotation.annotation_id}/tags/${tagId}`, {
        method: 'DELETE'
      });

      if (!response.ok && response.status !== 204) {
        throw new Error(`HTTP ${response.status}`);
      }

      // Remove from local tags array
      annotation.tags = annotation.tags.filter(t => t.tag_id !== tagId);
      this.renderTagsForNote(note, annotation.tags);

    } catch (error) {
      console.error('Failed to remove tag:', error);
      alert('Failed to remove tag');
    }
  },

  /**
   * Unselect sentence - closes annotation UI
   */
  unselectSentence() {
    // Hide sentence preview
    const preview = document.getElementById('sentence-preview');
    if (preview) {
      preview.classList.remove('visible');
    }

    // Hide sticky notes container
    const container = document.getElementById('sticky-notes-container');
    if (container) {
      container.classList.remove('visible');
    }

    // Remove selection from sentences
    document.querySelectorAll('.sentence.selected').forEach(s => s.classList.remove('selected'));

    // Clear renderer's tracking
    if (window.WriteSysRenderer) {
      window.WriteSysRenderer.currentSelectedSentenceId = null;
    }

    // Clear state
    this.currentSentenceId = null;
    this.currentSentenceText = '';
    this.annotations = [];
  },
};

// Export for other modules BEFORE initialization
window.WriteSysAnnotations = WriteSysAnnotations;

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => WriteSysAnnotations.init());
} else {
  WriteSysAnnotations.init();
}
