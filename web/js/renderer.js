// JS-segmenter-based renderer.

const WriteSysRenderer = {
  apiBaseUrl: 'api',
  currentManuscript: null,
  currentSentences: [],
  currentAnnotations: [],
  currentMigrationID: null,
  currentCommitHash: null,
  currentSegmenter: null,
  sentenceMap: {}, // sentence id → full text (used when a sentence is split across pages)
  currentSelectedSentenceId: null,

  async init() {
    console.log('WriteSys Renderer initialized');

    const urlParams = new URLSearchParams(window.location.search);
    this.manuscriptId = parseInt(urlParams.get('manuscript_id') || '1', 10);
    console.log(`Using manuscript_id: ${this.manuscriptId}`);

    await this.loadLatestMigration();
  },

  async loadLatestMigration() {
    try {
      this.showStatus('Loading latest migration...');

      // fetchJSON validates both status and Content-Type so a stray HTML
      // error page can't blow up JSON.parse.
      const migration = await fetchJSON(`${this.apiBaseUrl}/migrations/latest?manuscript_id=${this.manuscriptId}`, {}, false);
      this.currentMigrationID = migration.migration_id;
      this.currentCommitHash = migration.commit_hash;
      this.currentSegmenter = migration.segmenter;

      const shortHash = migration.commit_hash.substring(0, 7);
      const date = new Date(migration.processed_at).toLocaleDateString();
      document.getElementById('migration-info').textContent =
        `${shortHash} (${migration.segmenter}, ${date}, ${migration.sentence_count} sentences)`;

      console.log(`Loading migration ${migration.migration_id}: ${shortHash} with segmenter ${migration.segmenter}`);

      // Load manuscript for this migration
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

      // Server resolves repo/file from config.
      const url = `${this.apiBaseUrl}/migrations/${migrationID}/manuscript`;
      const data = await fetchJSON(url, {}, false);
      this.currentManuscript = data.markdown;
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

    const html = this.parseManuscript(this.currentManuscript);

    // Wrap sentences BEFORE pagination so Paged.js can duplicate the spans
    // cleanly across page breaks.
    const tempContainer = document.createElement('div');
    tempContainer.innerHTML = html;

    if (typeof smartquotes !== 'undefined') {
      smartquotes.element(tempContainer);
    }

    await this.wrapSentences(tempContainer);

    this.applyAnnotations(tempContainer);

    const wrappedHtml = tempContainer.innerHTML;

    if (typeof Paged !== 'undefined') {

      const paged = new Paged.Previewer();
      const appContainer = document.getElementById('app-container');

      // base-aware absolute URL so Paged.js fetches /<prefix>/css/book.css
      // when hosted under a prefix, and /css/book.css at the root.
      const bookCssUrl = new URL('css/book.css', document.baseURI).href;
      await paged.preview(wrappedHtml, [bookCssUrl], appContainer);

      // Paged.js rendered its own DOM; hide the original.
      const originalContent = document.getElementById('manuscript-content');
      if (originalContent) {
        originalContent.style.display = 'none';
      }

      // setupSentenceHover() runs in pagedjs-config.js after Paged.js finishes.
      this.applyResponsiveScaling();

      window.addEventListener("resize", () => this.applyResponsiveScaling());
    } else {
      // Fallback if Paged.js not available
      container.innerHTML = wrappedHtml;
      this.setupSentenceHover();
    }
  },

  /**
   * Apply or remove mobile scaling based on viewport width
   */
  applyResponsiveScaling() {
    const pagesContainer = document.querySelector(".pagedjs_pages");
    if (!pagesContainer) return;

    if (window.innerWidth <= 768) {
      const pageWidth = 600; // 6in = ~600px at 96dpi
      const viewportWidth = window.innerWidth;
      const scale = (viewportWidth * 0.7) / pageWidth; // 70% to leave room for borders
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

  // .manuscript format:
  //   # … → heading; \t at start → its own indented paragraph; bare lines join
  //   into one paragraph; blank line separates; *x* → <em>.
  parseManuscript(text) {
    const lines = text.split('\n');
    const html = [];
    let paragraphLines = [];

    const flushParagraph = () => {
      if (paragraphLines.length > 0) {
        const content = paragraphLines.join(' ');
        const hasIndent = paragraphLines[0].startsWith('\t');
        const cleaned = content.replace(/^\t/, '');
        const withFormatting = this.applyInlineFormatting(cleaned);

        if (hasIndent) {
          html.push(`<p class="indented">${withFormatting}</p>`);
        } else {
          html.push(`<p>${withFormatting}</p>`);
        }
        paragraphLines = [];
      }
    };

    // Anyone with commit access can put arbitrary content here, so every
    // chunk is HTML-escaped via applyInlineFormatting before reaching the DOM.

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.trim() === '') {
        flushParagraph();
        continue;
      }

      if (line.startsWith('#')) {
        flushParagraph();
        const level = line.match(/^#+/)[0].length;
        const text = line.replace(/^#+\s*/, '');
        html.push(`<h${level}>${this.applyInlineFormatting(text)}</h${level}>`);
        continue;
      }

      if (line.startsWith('\t')) {
        flushParagraph();
        const cleaned = line.substring(1);
        const withFormatting = this.applyInlineFormatting(cleaned);
        html.push(`<p class="indented">${withFormatting}</p>`);
        continue;
      }

      paragraphLines.push(line);
    }

    flushParagraph();

    return html.join('\n');
  },

  // Escape first, then substitute HTML we want: if we substituted *first*, a
  // subsequent escape would re-escape our own <em> tags.
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

  // Skip already-wrapped .sentence spans so we don't double-wrap.
  getUnwrappedText(container) {
    const walker = document.createTreeWalker(
      container,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: function(node) {
          let parent = node.parentElement;
          while (parent && parent !== container) {
            if (parent.classList && parent.classList.contains('sentence')) {
              return NodeFilter.FILTER_REJECT;
            }
            parent = parent.parentElement;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    let text = '';
    let node = walker.nextNode();
    while (node) {
      text += node.textContent;
      node = walker.nextNode();
    }
    return text;
  },

  // Segment the raw markdown with the JS segmenter, then zipper-match against
  // server-produced sentences by deterministic id to locate wrap positions.
  async wrapSentences(container) {
    console.log(`Server provided ${this.currentSentences.length} sentences`);

    // Must mirror the Go cleanSentenceBoundaries() so ids match the server's.
    const rawSegments = segment(this.currentManuscript);
    const segments = rawSegments.map(s => this.cleanSentenceBoundaries(s)).filter(s => s !== '');
    console.log(`JS segmenter found ${segments.length} segments in markdown (after cleaning)`);

    const serverSentenceMap = new Map();
    this.currentSentences.forEach(s => {
      serverSentenceMap.set(s.id, s);
    });

    let wrapped = 0;
    let disparities = [];
    const wrapQueue = [];

    // Phase 1: calculate positions against the initial (unmodified) text so
    // duplicate sentences can be disambiguated by searchOffset.
    const initialFullText = this.getUnwrappedText(container);
    let searchOffset = 0;

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const segmentClean = this.stripMarkdown(segment);

      const expectedId = await this.generateSentenceID(segmentClean, i, this.currentCommitHash);

      const serverSentence = serverSentenceMap.get(expectedId);

      if (!serverSentence) {
        console.warn(`Disparity at segment ${i}: Expected ID "${expectedId}" not found in server sentences`);
        console.warn(`  Segment text: "${segmentClean.substring(0, 80)}..."`);
        disparities.push({
          index: i,
          reason: 'id-not-found',
          expectedId,
          segmentText: segmentClean
        });
        continue;
      }

      let segmentTextToWrap = segmentClean;
      let segmentIndex = initialFullText.indexOf(segmentClean, searchOffset);

      // Fallback: smartquotes may have transformed the DOM's copy.
      if (segmentIndex === -1) {
        const tempDiv = document.createElement('div');
        tempDiv.textContent = segmentClean;
        if (typeof smartquotes !== 'undefined') {
          smartquotes.element(tempDiv);
        }
        segmentTextToWrap = tempDiv.textContent;
        segmentIndex = initialFullText.indexOf(segmentTextToWrap, searchOffset);
      }

      if (segmentIndex === -1) {
        console.warn(`Disparity at segment ${i}: Text not found in DOM`);
        console.warn(`  Expected ID: "${expectedId}"`);
        console.warn(`  Segment text: "${segmentClean.substring(0, 80)}..."`);
        disparities.push({
          index: i,
          reason: 'text-not-in-dom',
          expectedId,
          segmentText: segmentClean
        });
        continue;
      }

      wrapQueue.push({
        startOffset: segmentIndex,
        endOffset: segmentIndex + segmentTextToWrap.length,
        sentenceId: expectedId
      });

      searchOffset = segmentIndex + segmentTextToWrap.length;
    }

    // Phase 2: re-find each queued sentence in the current (partially wrapped)
    // text, since wrapping shifts node boundaries. Because we wrap in order,
    // each lookup is near the front of the unwrapped remainder.
    console.log(`Executing ${wrapQueue.length} wraps...`);
    for (let i = 0; i < wrapQueue.length; i++) {
      const wrap = wrapQueue[i];

      const currentUnwrapped = this.getUnwrappedText(container);

      const sentenceLength = wrap.endOffset - wrap.startOffset;
      const sentenceText = initialFullText.substring(wrap.startOffset, wrap.endOffset);

      const currentIndex = currentUnwrapped.indexOf(sentenceText);

      if (currentIndex === -1) {
        console.warn(`Could not find sentence in current unwrapped text: ${wrap.sentenceId}`);
        console.warn(`  Looking for: "${sentenceText.substring(0, 60)}..."`);
        continue;
      }

      // Wrap at the current position
      this.wrapTextRange(container, currentIndex, currentIndex + sentenceLength, wrap.sentenceId);
      wrapped++;
    }

    console.log(`Sentence wrapping complete: ${wrapped}/${segments.length} wrapped`);

    if (disparities.length > 0) {
      console.warn(`DISPARITIES: ${disparities.length} sentence(s) could not be matched`);
      console.log('Disparity summary:', disparities.map(d => `${d.index}: ${d.reason} (${d.expectedId})`).join(', '));
    }

    // Check for server sentences that weren't matched
    const wrappedIds = new Set();
    container.querySelectorAll('.sentence').forEach(span => {
      wrappedIds.add(span.dataset.sentenceId);
    });

    const unmatchedServerSentences = this.currentSentences.filter(s => !wrappedIds.has(s.id));
    if (unmatchedServerSentences.length > 0) {
      console.warn(`WARNING: ${unmatchedServerSentences.length} server sentence(s) were not wrapped:`);
      unmatchedServerSentences.forEach(s => {
        console.warn(`  - ${s.id}: "${s.text.substring(0, 80)}..."`);
      });
    }
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

    // Apply only the first annotation's color per sentence (API returns them
    // sorted by position). Extra colors surface via sidebar rainbow bars.
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

  // Must mirror Go normalizeText: lowercase, [^a-z0-9\s] removed, whitespace collapsed.
  normalizeText(text) {
    text = text.toLowerCase();
    text = text.replace(/[^a-z0-9\s]/g, '');
    text = text.replace(/\s+/g, ' ').trim();
    return text;
  },

  extractWordsForId(text) {
    const normalized = this.normalizeText(text);
    return normalized.split(/\s+/).filter(w => w.length > 0);
  },

  // Must mirror Go GenerateSentenceID byte-for-byte.
  // "{first-three-words}-{8 hex}" where hex = SHA-256(normText + ordinal + commit)[:4].
  async generateSentenceID(text, ordinal, commitHash) {
    const words = this.extractWordsForId(text);

    let prefix;
    const numWords = Math.min(3, words.length);
    if (numWords === 0) {
      prefix = 'heading';
    } else {
      prefix = words.slice(0, numWords).join('-');
    }

    const normalizedText = this.normalizeText(text);
    const data = `${normalizedText}-${ordinal}-${commitHash}`;

    const encoder = new TextEncoder();
    const dataBuffer = encoder.encode(data);
    const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
    const hashArray = new Uint8Array(hashBuffer);

    const suffix = Array.from(hashArray.slice(0, 4))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    return `${prefix}-${suffix}`;
  },

  // Must mirror Go cleanSentenceBoundaries().
  cleanSentenceBoundaries(text) {
    let trimmed = text.trim();

    // Remove leading punctuation (except quotes)
    while (trimmed.length > 0) {
      const firstChar = trimmed[0];

      if (firstChar === '"' || firstChar === "'" ||
          firstChar === '\u201c' || firstChar === '\u201d' ||
          firstChar === '\u2018' || firstChar === '\u2019' ||
          firstChar === '\u201e') {
        break;
      }

      if (firstChar === '.' || firstChar === ',' || firstChar === ';' ||
          firstChar === ':' || firstChar === '!' || firstChar === '?' ||
          firstChar === '—' || firstChar === '-') {
        trimmed = trimmed.substring(1).trimStart();
      } else {
        break;
      }
    }

    return trimmed;
  },

  // Double-newline separators keep block-level text from concatenating and
  // match what the segmenter's paragraph-break rule expects.
  getTextWithBlockSpacing(element) {
    const blockElements = ['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'SECTION', 'ARTICLE'];
    const parts = [];

    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent;
        if (text.trim()) {
          parts.push(text);
        }
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const tagName = node.tagName;

        for (let child of node.childNodes) {
          walk(child);
        }

        if (blockElements.includes(tagName) && parts.length > 0) {
          const last = parts[parts.length - 1];
          if (last && !last.endsWith('\n\n')) {
            if (last.endsWith('\n')) {
              parts.push('\n');
            } else {
              parts.push('\n\n');
            }
          }
        }
      }
    };

    walk(element);
    return parts.join('');
  },

  stripMarkdown(text) {
    return text
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1');
  },


  /**
   * Wrap a range of text in the DOM with a sentence span
   */
  wrapTextRange(container, startOffset, endOffset, sentenceId) {
    const walker = document.createTreeWalker(
      container,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: function(node) {
          let parent = node.parentElement;
          while (parent && parent !== container) {
            // Skip text nodes already inside a .sentence span
            if (parent.classList && parent.classList.contains('sentence')) {
              return NodeFilter.FILTER_REJECT;
            }
            parent = parent.parentElement;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    let currentOffset = 0;
    let currentNode = walker.nextNode();
    const nodesToWrap = [];

    while (currentNode) {
      const nodeLength = currentNode.textContent.length;
      const nodeStart = currentOffset;
      const nodeEnd = currentOffset + nodeLength;

      if (nodeEnd > startOffset && nodeStart < endOffset) {
        const wrapStart = Math.max(0, startOffset - nodeStart);
        const wrapEnd = Math.min(nodeLength, endOffset - nodeStart);

        nodesToWrap.push({
          node: currentNode,
          start: wrapStart,
          end: wrapEnd,
          sentenceId: sentenceId
        });
      }

      currentOffset = nodeEnd;
      if (currentOffset >= endOffset) break;

      currentNode = walker.nextNode();
    }

    // Reverse order so each wrap doesn't shift offsets the later wraps need.
    nodesToWrap.reverse().forEach(({ node, start, end, sentenceId }) => {
      const before = node.textContent.substring(0, start);
      const content = node.textContent.substring(start, end);
      const after = node.textContent.substring(end);

      const span = document.createElement('span');
      span.className = 'sentence';
      span.dataset.sentenceId = sentenceId;
      span.textContent = content;

      const parent = node.parentNode;
      if (before) parent.insertBefore(document.createTextNode(before), node);
      parent.insertBefore(span, node);
      if (after) parent.insertBefore(document.createTextNode(after), node);
      parent.removeChild(node);
    });
  },

  // Pages may split a sentence across fragments; events highlight all of them.
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
          // sentenceMap has the full text; the clicked span may only be a fragment.
          const fullText = this.sentenceMap[sentenceId] || span.textContent;
          window.WriteSysAnnotations.showAnnotationsForSentence(sentenceId, fullText);

          // Scroll to and pulse the first note (which owns the sentence's color).
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

  // Paged.js strips whitespace text nodes; re-insert single spaces between
  // adjacent sentence spans so the rendered text reads correctly.
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

  // Sidebar bars for sentences with multiple annotations; colors picked by rainbowSlice().
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

      // Delay so notes finish rendering before we scroll/flash.
      setTimeout(() => {
        this.scrollToAndHighlightAnnotation(annotationId);
      }, 300);
    }
  },

  scrollToAndHighlightAnnotation(annotationId) {
    console.log(`[scrollToAndHighlightAnnotation] Looking for annotation ${annotationId}`);

    const noteElement = document.querySelector(`.sticky-note[data-annotation-id="${annotationId}"]`);
    if (!noteElement) {
      console.warn(`Note element not found for annotation ${annotationId}`);
      const allNotes = document.querySelectorAll('.sticky-note');
      console.log(`Available notes (${allNotes.length}):`,
        Array.from(allNotes).map(n => n.dataset.annotationId));
      return;
    }

    console.log(`[scrollToAndHighlightAnnotation] Found note element, scrolling and highlighting`);

    noteElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    noteElement.classList.add('flash-highlight');

    setTimeout(() => {
      noteElement.classList.remove('flash-highlight');
    }, 600); // matches CSS animation duration
  },

  // Called after add/update/delete since those change the bar set.
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
