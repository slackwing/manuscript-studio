const WriteSysRenderer = {
  apiBaseUrl: 'api',
  currentSentences: [],
  currentAnnotations: [],
  currentMigrationID: null,
  currentCommitHash: null,
  currentSegmenter: null,
  sentenceMap: {}, // sentence id → full text (sentences may be split across pages)
  currentSelectedSentenceId: null,

  async init() {
    console.log('WriteSys Renderer initialized');

    const urlParams = new URLSearchParams(window.location.search);
    this.manuscriptId = parseInt(urlParams.get('manuscript_id') || '1', 10);
    console.log(`Using manuscript_id: ${this.manuscriptId}`);

    // Bind once at init, not per-render — saves trigger re-renders.
    window.addEventListener('resize', () => this.applyResponsiveScaling());

    await this.loadLatestMigration();
  },

  async loadLatestMigration() {
    try {
      this.showStatus('Loading latest migration...');

      const migration = await fetchJSON(`${this.apiBaseUrl}/migrations/latest?manuscript_id=${this.manuscriptId}`, {}, false);
      this.currentMigrationID = migration.migration_id;
      this.currentCommitHash = migration.commit_hash;
      this.currentSegmenter = migration.segmenter;

      const shortHash = migration.commit_hash.substring(0, 7);
      const date = new Date(migration.processed_at).toLocaleDateString();
      document.getElementById('migration-info').textContent =
        `${shortHash} (${migration.segmenter}, ${date}, ${migration.sentence_count} sentences)`;

      console.log(`Loading migration ${migration.migration_id}: ${shortHash} with segmenter ${migration.segmenter}`);

      await this.loadManuscriptByMigration(migration.migration_id);

    } catch (error) {
      console.error('Failed to load latest migration:', error);
      this.showStatus(`Error: ${error.message}`, 'error');
      document.getElementById('migration-info').textContent = 'Error loading migration';
    }
  },

  async loadManuscriptByMigration(migrationID) {
    try {
      this.showStatus('Loading manuscript...');

      // Parallel-fetch suggestions so an outage there never blocks the render.
      const url = `${this.apiBaseUrl}/migrations/${migrationID}/manuscript`;
      const [data] = await Promise.all([
        fetchJSON(url, {}, false),
        window.WriteSysSuggestions
          ? window.WriteSysSuggestions.loadForMigration(migrationID).catch(() => {})
          : Promise.resolve(),
      ]);
      this.currentSentences = data.sentences;
      this.currentAnnotations = data.annotations;

      this.sentenceMap = {};
      this.currentSentences.forEach(s => {
        this.sentenceMap[s.id] = s.text;
      });

      console.log(`Loaded ${this.currentSentences.length} sentences from migration ${migrationID}`);

      await this.renderManuscript();

      this.showStatus(`Loaded ${this.currentSentences.length} sentences`);
      document.getElementById('sentence-count').textContent = `${this.currentSentences.length} sentences`;

    } catch (error) {
      console.error('Failed to load manuscript:', error);
      this.showStatus(`Error: ${error.message}`, 'error');
    }
  },

  async renderManuscript() {
    const container = document.getElementById('manuscript-content');

    // Sentences carry structural markers (\n\t / \n\n) and inline markdown.
    // Build paragraphs by walking the list; each sentence becomes its own
    // <span class="sentence" data-sentence-id="...">. Smartquotes runs LAST
    // so straight apostrophes in suggestions don't diff against curly ones.
    const tempContainer = document.createElement('div');
    tempContainer.innerHTML = this.renderSentencesToHTML(this.currentSentences);

    this.applyAnnotations(tempContainer);

    if (window.WriteSysSuggestions && window.WriteSysSuggestions.applyToSpans) {
      window.WriteSysSuggestions.applyToSpans(tempContainer);
    }

    if (typeof smartquotes !== 'undefined') {
      smartquotes.element(tempContainer);
    }

    const wrappedHtml = tempContainer.innerHTML;

    if (typeof Paged !== 'undefined') {

      const paged = new Paged.Previewer();
      const appContainer = document.getElementById('app-container');

      // Paged.js appends; clear prior renders so spans don't double up.
      appContainer.querySelectorAll('.pagedjs_pages').forEach(el => el.remove());

      // base-aware absolute URL so Paged.js resolves under a prefix or root.
      const bookCssUrl = new URL('css/book.css', document.baseURI).href;
      await paged.preview(wrappedHtml, [bookCssUrl], appContainer);

      const originalContent = document.getElementById('manuscript-content');
      if (originalContent) {
        originalContent.style.display = 'none';
      }

      // setupSentenceHover() runs in pagedjs-config.js after Paged.js finishes.
      this.applyResponsiveScaling();
    } else {
      container.innerHTML = wrappedHtml;
      this.setupSentenceHover();
    }
  },

  applyResponsiveScaling() {
    const pagesContainer = document.querySelector(".pagedjs_pages");
    if (!pagesContainer) return;

    if (window.innerWidth <= 768) {
      const pageWidth = 600; // 6in @ 96dpi
      const viewportWidth = window.innerWidth;
      const scale = (viewportWidth * 0.7) / pageWidth; // 70% leaves border room
      pagesContainer.style.transform = `scale(${scale})`;
      pagesContainer.style.transformOrigin = "top center";
      pagesContainer.style.padding = "1em";
      pagesContainer.style.background = "transparent";
      document.body.style.background = "white";
    } else {
      pagesContainer.style.transform = "";
      pagesContainer.style.transformOrigin = "";
      pagesContainer.style.padding = "2em";
      pagesContainer.style.background = "#f5f5f5";
      document.body.style.background = "";
    }
  },

  // Build paginated HTML directly from the sentence list. Each sentence
  // becomes a <span class="sentence" data-sentence-id="...">, grouped into
  // <p> / <p class="indented"> / <h*> elements based on the sentence's
  // leading marker (\n\t = new indented paragraph, \n\n = new section,
  // # = heading).
  //
  // Replaces parseManuscript + wrapSentences. The DB is now the structural
  // source of truth — no need to re-parse the raw .manuscript file.
  renderSentencesToHTML(sentences) {
    if (!sentences || sentences.length === 0) return '';

    const out = [];
    let openP = null; // current <p> or <p class="indented"> contents

    const flush = () => {
      if (openP !== null) {
        out.push(openP.cls
          ? `<p class="${openP.cls}">${openP.spans.join(' ')}</p>`
          : `<p>${openP.spans.join(' ')}</p>`);
        openP = null;
      }
    };

    for (const s of sentences) {
      const text = s.text;
      const id = s.id;

      // Header sentence (# / ## / ### + space + content). Renders as <h*>.
      const headerMatch = text.match(/^(#+)\s+(.*)$/);
      if (headerMatch) {
        flush();
        const level = headerMatch[1].length;
        const headingText = headerMatch[2];
        out.push(`<h${level}><span class="sentence" data-sentence-id="${this.escapeHtml(id)}">${this.applyInlineFormatting(headingText)}</span></h${level}>`);
        continue;
      }

      // Strip the leading marker — it was structural, doesn't appear in
      // the visible text. The marker only chooses which <p> we live in.
      let body = text;
      let cls = '';
      if (body.startsWith('\n\n')) {
        flush();
        body = body.slice(2);
        cls = '';
      } else if (body.startsWith('\n\t')) {
        flush();
        body = body.slice(2);
        cls = 'indented';
      }

      const span = `<span class="sentence" data-sentence-id="${this.escapeHtml(id)}">${this.applyInlineFormatting(body)}</span>`;

      if (openP === null) {
        openP = { cls, spans: [span] };
      } else {
        openP.spans.push(span);
      }
    }

    flush();
    return out.join('\n');
  },

  // Escape first, then substitute *x* → <em> — otherwise the escape pass
  // would re-escape our own <em> tags.
  escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  },

  applyInlineFormatting(text) {
    const escaped = this.escapeHtml(text);
    return escaped.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  },


  applyAnnotations(container) {
    if (!this.currentAnnotations || this.currentAnnotations.length === 0) {
      console.log('No annotations to apply');
      return;
    }

    console.log(`Applying ${this.currentAnnotations.length} annotations...`);

    const annotationsBySentence = {};
    this.currentAnnotations.forEach(annotation => {
      if (!annotation.color) return;
      const sentenceId = annotation.sentence_id;
      if (!annotationsBySentence[sentenceId]) {
        annotationsBySentence[sentenceId] = [];
      }
      annotationsBySentence[sentenceId].push(annotation);
    });

    // Apply only the first color per sentence (API sorts by position);
    // extras surface via sidebar rainbow bars.
    Object.keys(annotationsBySentence).forEach(sentenceId => {
      const annotations = annotationsBySentence[sentenceId];
      if (annotations.length === 0) return;

      const firstAnnotation = annotations[0];
      const color = firstAnnotation.color;

      const sentenceElements = container.querySelectorAll(`.sentence[data-sentence-id="${sentenceId}"]`);

      if (sentenceElements.length === 0) {
        console.warn(`No sentence found with ID: ${sentenceId}`);
        return;
      }

      sentenceElements.forEach(el => {
        el.classList.add(`highlight-${color}`);
      });

      console.log(`Applied ${color} highlight to sentence ${sentenceId} (${sentenceElements.length} fragment(s), ${annotations.length} total annotations)`);
    });
  },

  // Must mirror Go normalizeText: lowercase, [^a-z0-9\s] stripped, ws collapsed.
  // Pages may split a sentence across fragments; events update all of them.
  setupSentenceHover() {
    document.querySelectorAll('.sentence').forEach(span => {
      span.addEventListener('mouseenter', () => {
        const sentenceId = span.dataset.sentenceId;
        document.querySelectorAll(`.sentence[data-sentence-id="${sentenceId}"]`).forEach(fragment => {
          fragment.classList.add('hover');
        });
      });

      span.addEventListener('mouseleave', () => {
        const sentenceId = span.dataset.sentenceId;
        document.querySelectorAll(`.sentence[data-sentence-id="${sentenceId}"]`).forEach(fragment => {
          fragment.classList.remove('hover');
        });
      });

      span.addEventListener('click', () => {
        const sentenceId = span.dataset.sentenceId;

        // Re-click on the selected sentence opens the suggested-edit modal.
        if (sentenceId === this.currentSelectedSentenceId && window.WriteSysSuggestions) {
          window.WriteSysSuggestions.openModal(sentenceId);
          return;
        }

        if (this.currentSelectedSentenceId) {
          document.querySelectorAll(`.sentence[data-sentence-id="${this.currentSelectedSentenceId}"]`).forEach(fragment => {
            fragment.classList.remove('selected');
          });
        }

        document.querySelectorAll(`.sentence[data-sentence-id="${sentenceId}"]`).forEach(fragment => {
          fragment.classList.add('selected');
        });

        this.currentSelectedSentenceId = sentenceId;

        if (window.WriteSysAnnotations) {
          // sentenceMap has the full text; the clicked span may be a fragment.
          const fullText = this.sentenceMap[sentenceId] || span.textContent;
          window.WriteSysAnnotations.showAnnotationsForSentence(sentenceId, fullText);

          // Pulse the first note (which owns the sentence's color).
          setTimeout(() => {
            const firstNote = document.querySelector('.sticky-note');
            if (firstNote) {
              firstNote.scrollIntoView({ behavior: 'smooth', block: 'center' });
              firstNote.classList.add('flash-highlight');
              setTimeout(() => {
                firstNote.classList.remove('flash-highlight');
              }, 600);
            }
          }, 300);
        }
      });
    });
  },

  // Re-insert single spaces between adjacent sentence spans (Paged.js
  // strips the whitespace text nodes).
  insertSpacesBetweenSentences(container) {
    const paragraphs = container.querySelectorAll('p');

    paragraphs.forEach(p => {
      const children = Array.from(p.childNodes);

      for (let i = children.length - 1; i > 0; i--) {
        const current = children[i];
        const prev = children[i - 1];

        if (current.nodeType === 1 && current.classList?.contains('sentence') &&
            prev.nodeType === 1 && prev.classList?.contains('sentence')) {
          p.insertBefore(document.createTextNode(' '), current);
        }
      }
    });
  },

  showStatus(message, type = 'info') {
    const statusEl = document.getElementById('status');
    statusEl.textContent = message;
    statusEl.className = type;
  },

  getColorValue(colorName) {
    return getComputedStyle(document.documentElement)
      .getPropertyValue(`--highlight-${colorName}`).trim();
  },

  getRainbowBarAnnotations(annotations) {
    if (annotations.length < 2) return [];

    const colors = annotations.map(a => a.color);
    const barColors = rainbowSlice(colors, { skip: 1, maxSize: 4 });

    const barAnnotations = [];
    let searchStartIndex = 1;

    barColors.forEach(colorName => {
      for (let i = searchStartIndex; i < annotations.length; i++) {
        if (annotations[i].color === colorName) {
          barAnnotations.push(annotations[i]);
          searchStartIndex = i + 1;
          break;
        }
      }
    });

    return barAnnotations;
  },

  calculateRainbowBarPosition(sentenceRect, pageRect) {
    return {
      top: Math.round(sentenceRect.top - pageRect.top),
      height: Math.round(sentenceRect.height)
    };
  },

  createRainbowBar(annotation, index, sentenceId) {
    const bar = document.createElement('div');
    bar.className = 'rainbow-bar';
    bar.style.position = 'absolute';
    bar.style.top = '0';
    bar.style.left = `${index * 0.5}em`;
    bar.style.width = '0.5em';
    bar.style.height = '100%';
    bar.style.backgroundColor = this.getColorValue(annotation.color) || '#ccc';
    bar.style.pointerEvents = 'auto';
    bar.style.cursor = 'pointer';

    const annId = annotation.annotation_id || annotation.id;
    bar.dataset.annotationId = annId;
    bar.dataset.sentenceId = sentenceId;
    bar.dataset.color = annotation.color;

    bar.addEventListener('click', (e) => {
      e.stopPropagation();
      this.handleRainbowBarClick(sentenceId, annId, annotation.color);
    });

    return bar;
  },

  // Sidebar bars for sentences with multiple annotations.
  addRainbowBars() {
    document.querySelectorAll('.rainbow-bar-container').forEach(el => el.remove());

    if (!this.currentAnnotations || this.currentAnnotations.length === 0) {
      return;
    }

    const annotationsBySentence = {};
    this.currentAnnotations.forEach(annotation => {
      if (!annotation.color) return;
      const sentenceId = annotation.sentence_id;
      if (!annotationsBySentence[sentenceId]) {
        annotationsBySentence[sentenceId] = [];
      }
      annotationsBySentence[sentenceId].push(annotation);
    });

    Object.keys(annotationsBySentence).forEach(sentenceId => {
      const annotations = annotationsBySentence[sentenceId];
      const barAnnotations = this.getRainbowBarAnnotations(annotations);

      if (barAnnotations.length === 0) return;

      const sentenceFragments = document.querySelectorAll(`.sentence[data-sentence-id="${sentenceId}"]`);

      sentenceFragments.forEach(sentence => {
        const page = sentence.closest('.pagedjs_page');
        if (!page) return;

        const pageArea = page.querySelector('.pagedjs_page_content');
        if (!pageArea) return;

        const sentenceRect = sentence.getBoundingClientRect();
        const pageRect = pageArea.getBoundingClientRect();
        const position = this.calculateRainbowBarPosition(sentenceRect, pageRect);

        const container = document.createElement('div');
        container.className = 'rainbow-bar-container';
        container.style.position = 'absolute';
        container.style.top = `${position.top}px`;
        container.style.left = 'calc(100% + 5px)';
        container.style.width = `${barAnnotations.length * 0.5}em`;
        container.style.height = `${position.height}px`;
        container.style.pointerEvents = 'none';
        container.style.zIndex = '10';

        barAnnotations.forEach((annotation, index) => {
          const bar = this.createRainbowBar(annotation, index, sentenceId);
          container.appendChild(bar);
        });

        pageArea.appendChild(container);
      });
    });

    const totalBars = document.querySelectorAll('.rainbow-bar-container').length;
    if (totalBars > 0) {
      console.log(`Added rainbow bars for ${totalBars} sentence fragments`);
    }
  },

  handleRainbowBarClick(sentenceId, annotationId, color) {
    console.log(`Rainbow bar clicked: sentence=${sentenceId}, annotation=${annotationId}, color=${color}`);

    if (this.currentSelectedSentenceId) {
      document.querySelectorAll(`.sentence[data-sentence-id="${this.currentSelectedSentenceId}"]`).forEach(fragment => {
        fragment.classList.remove('selected');
      });
    }

    document.querySelectorAll(`.sentence[data-sentence-id="${sentenceId}"]`).forEach(fragment => {
      fragment.classList.add('selected');
    });

    this.currentSelectedSentenceId = sentenceId;

    if (window.WriteSysAnnotations) {
      const fullText = this.sentenceMap[sentenceId] || '';
      window.WriteSysAnnotations.showAnnotationsForSentence(sentenceId, fullText);

      // Wait for notes to render before we scroll/flash.
      setTimeout(() => {
        this.scrollToAndHighlightAnnotation(annotationId);
      }, 300);
    }
  },

  scrollToAndHighlightAnnotation(annotationId) {
    const noteElement = document.querySelector(`.sticky-note[data-annotation-id="${annotationId}"]`);
    if (!noteElement) {
      console.warn(`Note element not found for annotation ${annotationId}`);
      const allNotes = document.querySelectorAll('.sticky-note');
      console.log(`Available notes (${allNotes.length}):`,
        Array.from(allNotes).map(n => n.dataset.annotationId));
      return;
    }

    noteElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    noteElement.classList.add('flash-highlight');

    setTimeout(() => {
      noteElement.classList.remove('flash-highlight');
    }, 600); // matches CSS animation
  },

  async refreshRainbowBars() {
    if (!this.currentMigrationID) {
      return;
    }

    try {
      const url = `${this.apiBaseUrl}/migrations/${this.currentMigrationID}/manuscript`;
      const data = await fetchJSON(url, {}, false);
      this.currentAnnotations = data.annotations || [];
      this.addRainbowBars();
    } catch (error) {
      console.error('Failed to refresh rainbow bars:', error);
    }
  }
};

window.WriteSysRenderer = WriteSysRenderer;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => WriteSysRenderer.init());
} else {
  WriteSysRenderer.init();
}
