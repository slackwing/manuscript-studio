// WriteSys Renderer
// Simplified version using JS segmenter for accurate sentence boundaries

const WriteSysRenderer = {
  apiBaseUrl: 'http://localhost:5003/api',
  currentManuscript: null,
  currentSentences: [],
  currentAnnotations: [],
  currentMigrationID: null, // Current migration ID
  currentCommitHash: null, // Current commit hash (for display)
  currentSegmenter: null, // Current segmenter version
  sentenceMap: {}, // Maps sentence ID -> full sentence text (for split sentences)
  currentSelectedSentenceId: null, // Currently selected sentence ID

  /**
   * Initialize the renderer
   */
  async init() {
    console.log('WriteSys Renderer initialized');

    // Get manuscript_id from URL parameter, default to 1
    const urlParams = new URLSearchParams(window.location.search);
    this.manuscriptId = parseInt(urlParams.get('manuscript_id') || '1', 10);
    console.log(`Using manuscript_id: ${this.manuscriptId}`);

    // Auto-load latest migration on startup
    await this.loadLatestMigration();
  },

  /**
   * Load latest migration from API and display manuscript
   */
  async loadLatestMigration() {
    try {
      const repoPath = document.getElementById('repo-path').value.trim();
      const filePath = document.getElementById('file-path').value.trim();

      if (!repoPath || !filePath) {
        this.showStatus('Error: Missing repo or file path', 'error');
        return;
      }

      this.showStatus('Loading latest migration...');

      // Fetch latest migration info
      const response = await fetch(`${this.apiBaseUrl}/migrations/latest?manuscript_id=${this.manuscriptId}`);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      }

      const migration = await response.json();
      this.currentMigrationID = migration.migration_id;
      this.currentCommitHash = migration.commit_hash;
      this.currentSegmenter = migration.segmenter;

      // Update info bar
      const shortHash = migration.commit_hash.substring(0, 7);
      const date = new Date(migration.processed_at).toLocaleDateString();
      document.getElementById('migration-info').textContent =
        `${shortHash} (${migration.segmenter}, ${date}, ${migration.sentence_count} sentences)`;

      console.log(`Loading migration ${migration.migration_id}: ${shortHash} with segmenter ${migration.segmenter}`);

      // Load manuscript for this migration
      await this.loadManuscriptByMigration(migration.migration_id, repoPath, filePath);

    } catch (error) {
      console.error('Failed to load latest migration:', error);
      this.showStatus(`Error: ${error.message}`, 'error');
      document.getElementById('migration-info').textContent = 'Error loading migration';
    }
  },

  /**
   * Load manuscript from API by migration_id
   */
  async loadManuscriptByMigration(migrationID, repoPath, filePath) {
    try {
      this.showStatus('Loading manuscript...');

      // Store repo and file paths for refreshRainbowBars()
      this.currentRepoPath = repoPath;
      this.currentFilePath = filePath;

      // Fetch manuscript data from API
      const url = `${this.apiBaseUrl}/migrations/${migrationID}/manuscript?repo=${encodeURIComponent(repoPath)}&file=${encodeURIComponent(filePath)}`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      }

      const data = await response.json();
      this.currentManuscript = data.markdown;
      this.currentSentences = data.sentences;
      this.currentAnnotations = data.annotations;

      // Build sentence map (ID -> full text) for annotation sidebar
      this.sentenceMap = {};
      this.currentSentences.forEach(s => {
        this.sentenceMap[s.id] = s.text;
      });

      console.log(`Loaded ${this.currentSentences.length} sentences from migration ${migrationID}`);

      // Render the manuscript
      await this.renderManuscript();

      this.showStatus(`Loaded ${this.currentSentences.length} sentences`);
      document.getElementById('sentence-count').textContent = `${this.currentSentences.length} sentences`;

    } catch (error) {
      console.error('Failed to load manuscript:', error);
      this.showStatus(`Error: ${error.message}`, 'error');
    }
  },

  /**
   * Render manuscript and wrap sentences
   */
  async renderManuscript() {
    const container = document.getElementById('manuscript-content');

    // Parse .manuscript format to HTML
    const html = this.parseManuscript(this.currentManuscript);

    // Create a temporary container to wrap sentences BEFORE pagination
    const tempContainer = document.createElement('div');
    tempContainer.innerHTML = html;

    // Apply smartquotes to convert straight quotes to curly
    if (typeof smartquotes !== 'undefined') {
      smartquotes.element(tempContainer);
    }

    // Wrap sentences in the unpaginated HTML
    // Paged.js will duplicate these spans across page breaks automatically
    await this.wrapSentences(tempContainer);

    // Apply annotations (highlights) to sentences before pagination
    this.applyAnnotations(tempContainer);

    // Get the wrapped HTML
    const wrappedHtml = tempContainer.innerHTML;

    // If Paged.js is available, use it for pagination
    if (typeof Paged !== 'undefined') {

      const paged = new Paged.Previewer();
      const appContainer = document.getElementById('app-container');

      // Pass wrapped HTML to Paged.js - it will handle splitting/duplicating sentence spans
      await paged.preview(wrappedHtml, ['/css/book.css'], appContainer);

      // Hide the original manuscript-content div (Paged.js created its own)
      const originalContent = document.getElementById('manuscript-content');
      if (originalContent) {
        originalContent.style.display = 'none';
      }

      // Note: setupSentenceHover() is called in pagedjs-config.js afterRendered handler
      // after Paged.js has finished creating the DOM

      // Apply responsive scaling (will be called again in afterRendered)
      this.applyResponsiveScaling();

      // Listen for window resize
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
      // Reset to desktop view
      pagesContainer.style.transform = "";
      pagesContainer.style.transformOrigin = "";
      pagesContainer.style.padding = "2em";
      pagesContainer.style.background = "#f5f5f5";
      document.body.style.background = "";
    }
  },

  /**
   * Parse .manuscript format to HTML
   * Format rules:
   * - Lines starting with # are headings
   * - Lines starting with \t are NEW indented paragraphs (each line is its own paragraph)
   * - Lines without \t after headings are regular paragraphs (multiple lines can be joined)
   * - Blank lines separate paragraphs
   * - *text* becomes <em>
   */
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

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Blank line - flush paragraph
      if (line.trim() === '') {
        flushParagraph();
        continue;
      }

      // Heading
      if (line.startsWith('#')) {
        flushParagraph();
        const level = line.match(/^#+/)[0].length;
        const text = line.replace(/^#+\s*/, '');
        html.push(`<h${level}>${this.applyInlineFormatting(text)}</h${level}>`);
        continue;
      }

      // Line starting with tab - each is its own indented paragraph
      if (line.startsWith('\t')) {
        flushParagraph(); // Flush any accumulated non-indented paragraph
        const cleaned = line.substring(1); // Remove the tab
        const withFormatting = this.applyInlineFormatting(cleaned);
        html.push(`<p class="indented">${withFormatting}</p>`);
        continue;
      }

      // Regular paragraph content (accumulate until blank line or special line)
      paragraphLines.push(line);
    }

    // Flush any remaining paragraph
    flushParagraph();

    return html.join('\n');
  },

  /**
   * Apply inline formatting (*italic*)
   */
  applyInlineFormatting(text) {
    // Replace *text* with <em>text</em>
    return text.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  },

  /**
   * Get unwrapped text from container
   * (skips already-wrapped .sentence spans to avoid double-wrapping)
   */
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

  /**
   * Wrap sentences - segment the MARKDOWN using JS segmenter
   * Then "zipper" match with server sentences using first 3 words
   */
  async wrapSentences(container) {
    console.log(`Server provided ${this.currentSentences.length} sentences`);

    // Segment the ORIGINAL MARKDOWN using the JS segmenter
    // This ensures we match the server's segmentation
    const rawSegments = segment(this.currentManuscript);

    // Apply the same cleaning that the Go server does (cleanSentenceBoundaries)
    // This removes leading punctuation and filters out empty sentences
    const segments = rawSegments.map(s => this.cleanSentenceBoundaries(s)).filter(s => s !== '');
    console.log(`JS segmenter found ${segments.length} segments in markdown (after cleaning)`);

    // Create a map of server sentence IDs for quick lookup
    const serverSentenceMap = new Map();
    this.currentSentences.forEach(s => {
      serverSentenceMap.set(s.id, s);
    });

    let wrapped = 0;
    let disparities = [];
    const wrapQueue = []; // Collect all wraps before executing

    // PHASE 1: Calculate all wrap positions (before any wrapping changes the DOM)
    const initialFullText = this.getUnwrappedText(container);
    let searchOffset = 0; // Track position in text to handle duplicates

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const segmentClean = this.stripMarkdown(segment);

      // Calculate expected ID for this segment (ordinal = i, 0-indexed)
      const expectedId = await this.generateSentenceID(segmentClean, i, this.currentCommitHash);

      // Look for a server sentence with this exact ID
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

      // Find this segment in the DOM (starting from searchOffset to handle duplicates)
      let segmentTextToWrap = segmentClean;
      let segmentIndex = initialFullText.indexOf(segmentClean, searchOffset);

      // If not found with straight quotes, try with smart quotes
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

      // Queue this wrap for later execution
      wrapQueue.push({
        startOffset: segmentIndex,
        endOffset: segmentIndex + segmentTextToWrap.length,
        sentenceId: expectedId
      });

      // Update search offset to after this sentence
      searchOffset = segmentIndex + segmentTextToWrap.length;
    }

    // PHASE 2: Execute wraps using CURRENT unwrapped text position
    // Instead of adjusting offsets, we search for each sentence in the current unwrapped text
    console.log(`Executing ${wrapQueue.length} wraps...`);
    for (let i = 0; i < wrapQueue.length; i++) {
      const wrap = wrapQueue[i];

      // Get current unwrapped text (excludes already-wrapped sentences)
      const currentUnwrapped = this.getUnwrappedText(container);

      // Calculate sentence text from original offsets
      const sentenceLength = wrap.endOffset - wrap.startOffset;
      const sentenceText = initialFullText.substring(wrap.startOffset, wrap.endOffset);

      // Find this sentence in CURRENT unwrapped text
      // It should be at the very beginning (or near it) since we're wrapping in order
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

  /**
   * Apply annotations (highlights) to wrapped sentences
   */
  applyAnnotations(container) {
    if (!this.currentAnnotations || this.currentAnnotations.length === 0) {
      console.log('No annotations to apply');
      return;
    }

    console.log(`Applying ${this.currentAnnotations.length} annotations...`);

    // Group annotations by sentence_id to find the first annotation per sentence
    const annotationsBySentence = {};
    this.currentAnnotations.forEach(annotation => {
      if (!annotation.color) return;
      const sentenceId = annotation.sentence_id;
      if (!annotationsBySentence[sentenceId]) {
        annotationsBySentence[sentenceId] = [];
      }
      annotationsBySentence[sentenceId].push(annotation);
    });

    // Apply only the FIRST annotation's color to each sentence
    Object.keys(annotationsBySentence).forEach(sentenceId => {
      const annotations = annotationsBySentence[sentenceId];
      if (annotations.length === 0) return;

      // Get the first annotation's color (they're already sorted by position from API)
      const firstAnnotation = annotations[0];
      const color = firstAnnotation.color;

      // Find all sentence elements with this ID (including fragments)
      const sentenceElements = container.querySelectorAll(`.sentence[data-sentence-id="${sentenceId}"]`);

      if (sentenceElements.length === 0) {
        console.warn(`No sentence found with ID: ${sentenceId}`);
        return;
      }

      // Apply highlight class to all fragments
      sentenceElements.forEach(el => {
        el.classList.add(`highlight-${color}`);
      });

      console.log(`Applied ${color} highlight to sentence ${sentenceId} (${sentenceElements.length} fragment(s), ${annotations.length} total annotations)`);
    });
  },

  /**
   * Normalize text for ID generation (same as Go normalizeText)
   * - Lowercase
   * - Keep only letters, digits, and spaces
   * - Normalize whitespace
   */
  normalizeText(text) {
    // Convert to lowercase
    text = text.toLowerCase();

    // Remove all non-alphanumeric characters except spaces
    text = text.replace(/[^a-z0-9\s]/g, '');

    // Normalize whitespace (collapse multiple spaces to one)
    text = text.replace(/\s+/g, ' ').trim();

    return text;
  },

  /**
   * Extract words for ID generation (same as Go ExtractWords)
   * Normalizes text and splits on whitespace
   */
  extractWordsForId(text) {
    const normalized = this.normalizeText(text);
    return normalized.split(/\s+/).filter(w => w.length > 0);
  },

  /**
   * Generate deterministic sentence ID (same as Go GenerateSentenceID)
   * Format: {first-three-words}-{8-hex-chars}
   * The 8 hex chars are SHA-256 hash of: normalizedText + ordinal + commitHash
   */
  async generateSentenceID(text, ordinal, commitHash) {
    // Extract first three alphanumeric words
    const words = this.extractWordsForId(text);

    // Build prefix from first 1-3 words
    let prefix;
    const numWords = Math.min(3, words.length);
    if (numWords === 0) {
      // No words (e.g., scene break markers like "***")
      prefix = 'heading';
    } else {
      prefix = words.slice(0, numWords).join('-');
    }

    // Generate deterministic 8-character hex suffix
    const normalizedText = this.normalizeText(text);
    const data = `${normalizedText}-${ordinal}-${commitHash}`;

    // SHA-256 hash using Web Crypto API
    const encoder = new TextEncoder();
    const dataBuffer = encoder.encode(data);
    const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
    const hashArray = new Uint8Array(hashBuffer);

    // Take first 4 bytes and convert to hex (8 chars)
    const suffix = Array.from(hashArray.slice(0, 4))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    return `${prefix}-${suffix}`;
  },

  /**
   * Clean sentence boundaries - same as Go code cleanSentenceBoundaries()
   * Removes leading punctuation but keeps trailing punctuation
   */
  cleanSentenceBoundaries(text) {
    let trimmed = text.trim();

    // Remove leading punctuation (except quotes)
    while (trimmed.length > 0) {
      const firstChar = trimmed[0];

      // Keep quotes at start
      if (firstChar === '"' || firstChar === "'" ||
          firstChar === '\u201c' || firstChar === '\u201d' ||
          firstChar === '\u2018' || firstChar === '\u2019' ||
          firstChar === '\u201e') {
        break;
      }

      // Remove sentence-joining punctuation
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

  /**
   * Get text content with proper spacing between block elements
   * This ensures headings, paragraphs, etc. don't concatenate
   * Uses double newlines for segmenter compatibility
   */
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

        // Walk children
        for (let child of node.childNodes) {
          walk(child);
        }

        // Add double newline after block elements (required by segmenter)
        if (blockElements.includes(tagName) && parts.length > 0) {
          const last = parts[parts.length - 1];
          if (last && !last.endsWith('\n\n')) {
            // Ensure we have exactly two newlines
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

  /**
   * Strip markdown syntax from text
   */
  stripMarkdown(text) {
    return text
      .replace(/^#{1,6}\s+/gm, '')  // Remove heading markers
      .replace(/\*\*([^*]+)\*\*/g, '$1')  // Remove bold markers
      .replace(/\*([^*]+)\*/g, '$1');  // Remove italic markers
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

      // Check if this text node intersects with our target range
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

    // Perform the wrapping (reverse order to avoid offset issues)
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

  /**
   * Set up hover effects for sentences
   * When hovering over a sentence, highlight ALL fragments (including on other pages)
   */
  setupSentenceHover() {
    document.querySelectorAll('.sentence').forEach(span => {
      span.addEventListener('mouseenter', () => {
        const sentenceId = span.dataset.sentenceId;
        // Highlight all fragments with this sentence ID
        document.querySelectorAll(`.sentence[data-sentence-id="${sentenceId}"]`).forEach(fragment => {
          fragment.classList.add('hover');
        });
      });

      span.addEventListener('mouseleave', () => {
        const sentenceId = span.dataset.sentenceId;
        // Remove highlight from all fragments with this sentence ID
        document.querySelectorAll(`.sentence[data-sentence-id="${sentenceId}"]`).forEach(fragment => {
          fragment.classList.remove('hover');
        });
      });

      span.addEventListener('click', () => {
        const sentenceId = span.dataset.sentenceId;

        // Clear previous selection
        if (this.currentSelectedSentenceId) {
          document.querySelectorAll(`.sentence[data-sentence-id="${this.currentSelectedSentenceId}"]`).forEach(fragment => {
            fragment.classList.remove('selected');
          });
        }

        // Highlight all fragments of the clicked sentence
        document.querySelectorAll(`.sentence[data-sentence-id="${sentenceId}"]`).forEach(fragment => {
          fragment.classList.add('selected');
        });

        // Update current selection
        this.currentSelectedSentenceId = sentenceId;

        if (window.WriteSysAnnotations) {
          // Use full sentence text from map (not the clicked fragment)
          const fullText = this.sentenceMap[sentenceId] || span.textContent;
          window.WriteSysAnnotations.showAnnotationsForSentence(sentenceId, fullText);

          // Scroll to and pulse the first note (which colors the sentence)
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

  /**
   * Insert spaces between consecutive sentence spans
   * Called after Paged.js renders (which strips whitespace text nodes)
   */
  insertSpacesBetweenSentences(container) {
    // Find all paragraphs
    const paragraphs = container.querySelectorAll('p');

    paragraphs.forEach(p => {
      const children = Array.from(p.childNodes);

      // Walk backwards to avoid offset issues when inserting
      for (let i = children.length - 1; i > 0; i--) {
        const current = children[i];
        const prev = children[i - 1];

        // If both are sentence spans, insert a space between them
        if (current.nodeType === 1 && current.classList?.contains('sentence') &&
            prev.nodeType === 1 && prev.classList?.contains('sentence')) {
          p.insertBefore(document.createTextNode(' '), current);
        }
      }
    });
  },

  /**
   * Show status message
   */
  showStatus(message, type = 'info') {
    const statusEl = document.getElementById('status');
    statusEl.textContent = message;
    statusEl.className = type;
  },

  /**
   * Get color value from CSS variable
   */
  getColorValue(colorName) {
    return getComputedStyle(document.documentElement)
      .getPropertyValue(`--highlight-${colorName}`).trim();
  },

  /**
   * Get rainbow bar colors for a sentence with multiple annotations
   * @param {Array} annotations - Array of annotations for the sentence
   * @returns {Array} Array of {annotation, color} objects to display as bars
   */
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

  /**
   * Calculate position of rainbow bar relative to page content area
   * @param {DOMRect} sentenceRect - Bounding rect of sentence element
   * @param {DOMRect} pageRect - Bounding rect of page content area
   * @returns {Object} Object with {top, height} in pixels
   */
  calculateRainbowBarPosition(sentenceRect, pageRect) {
    return {
      top: Math.round(sentenceRect.top - pageRect.top),
      height: Math.round(sentenceRect.height)
    };
  },

  /**
   * Create a single rainbow bar element
   * @param {Object} annotation - The annotation object
   * @param {number} index - The bar index (0-based)
   * @param {string} sentenceId - The sentence ID
   * @returns {HTMLElement} The bar element
   */
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

  /**
   * Add rainbow sidebar bars for sentences with multiple annotations
   * Uses rainbowSlice() to determine which colors to show
   */
  addRainbowBars() {
    // Remove any existing rainbow bar containers
    document.querySelectorAll('.rainbow-bar-container').forEach(el => el.remove());

    if (!this.currentAnnotations || this.currentAnnotations.length === 0) {
      return;
    }

    // Group annotations by sentence_id
    const annotationsBySentence = {};
    this.currentAnnotations.forEach(annotation => {
      if (!annotation.color) return;
      const sentenceId = annotation.sentence_id;
      if (!annotationsBySentence[sentenceId]) {
        annotationsBySentence[sentenceId] = [];
      }
      annotationsBySentence[sentenceId].push(annotation);
    });

    // For each sentence with multiple annotations, add rainbow bars
    Object.keys(annotationsBySentence).forEach(sentenceId => {
      const annotations = annotationsBySentence[sentenceId];
      const barAnnotations = this.getRainbowBarAnnotations(annotations);

      if (barAnnotations.length === 0) return;

      // Find all sentence fragments with this ID
      const sentenceFragments = document.querySelectorAll(`.sentence[data-sentence-id="${sentenceId}"]`);

      sentenceFragments.forEach(sentence => {
        const page = sentence.closest('.pagedjs_page');
        if (!page) return;

        const pageArea = page.querySelector('.pagedjs_page_content');
        if (!pageArea) return;

        const sentenceRect = sentence.getBoundingClientRect();
        const pageRect = pageArea.getBoundingClientRect();
        const position = this.calculateRainbowBarPosition(sentenceRect, pageRect);

        // Create container for bars
        const container = document.createElement('div');
        container.className = 'rainbow-bar-container';
        container.style.position = 'absolute';
        container.style.top = `${position.top}px`;
        container.style.left = 'calc(100% + 5px)';
        container.style.width = `${barAnnotations.length * 0.5}em`;
        container.style.height = `${position.height}px`;
        container.style.pointerEvents = 'none';
        container.style.zIndex = '10';

        // Create bars inside container
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

  /**
   * Handle click on a rainbow bar
   * Shows annotations for the sentence and scrolls to the specific note
   */
  handleRainbowBarClick(sentenceId, annotationId, color) {
    console.log(`Rainbow bar clicked: sentence=${sentenceId}, annotation=${annotationId}, color=${color}`);

    // Highlight sentence (like clicking it)
    if (this.currentSelectedSentenceId) {
      document.querySelectorAll(`.sentence[data-sentence-id="${this.currentSelectedSentenceId}"]`).forEach(fragment => {
        fragment.classList.remove('selected');
      });
    }

    document.querySelectorAll(`.sentence[data-sentence-id="${sentenceId}"]`).forEach(fragment => {
      fragment.classList.add('selected');
    });

    this.currentSelectedSentenceId = sentenceId;

    // Show annotations for this sentence
    if (window.WriteSysAnnotations) {
      const fullText = this.sentenceMap[sentenceId] || '';
      window.WriteSysAnnotations.showAnnotationsForSentence(sentenceId, fullText);

      // Scroll to and highlight the specific annotation
      setTimeout(() => {
        this.scrollToAndHighlightAnnotation(annotationId);
      }, 300); // Delay to let notes render
    }
  },

  /**
   * Scroll to a specific annotation and add a flash animation
   */
  scrollToAndHighlightAnnotation(annotationId) {
    console.log(`[scrollToAndHighlightAnnotation] Looking for annotation ${annotationId}`);

    const noteElement = document.querySelector(`.sticky-note[data-annotation-id="${annotationId}"]`);
    if (!noteElement) {
      console.warn(`Note element not found for annotation ${annotationId}`);
      // Debug: log all available notes
      const allNotes = document.querySelectorAll('.sticky-note');
      console.log(`Available notes (${allNotes.length}):`,
        Array.from(allNotes).map(n => n.dataset.annotationId));
      return;
    }

    console.log(`[scrollToAndHighlightAnnotation] Found note element, scrolling and highlighting`);

    // Scroll the note into view
    noteElement.scrollIntoView({ behavior: 'smooth', block: 'center' });

    // Add flash animation
    noteElement.classList.add('flash-highlight');

    // Remove animation class after it completes
    setTimeout(() => {
      noteElement.classList.remove('flash-highlight');
    }, 600); // Match CSS animation duration
  },

  /**
   * Refresh rainbow bars by reloading all annotations from the API
   * This is needed when annotations are added/updated/deleted
   */
  async refreshRainbowBars() {
    if (!this.currentMigrationID || !this.currentRepoPath || !this.currentFilePath) {
      return;
    }

    try {
      const url = `${this.apiBaseUrl}/migrations/${this.currentMigrationID}/manuscript?repo=${encodeURIComponent(this.currentRepoPath)}&file=${encodeURIComponent(this.currentFilePath)}`;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      this.currentAnnotations = data.annotations || [];

      // Re-render rainbow bars with updated annotations
      this.addRainbowBars();
    } catch (error) {
      console.error('Failed to refresh rainbow bars:', error);
    }
  }
};

// Export to window for access by other modules
window.WriteSysRenderer = WriteSysRenderer;

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => WriteSysRenderer.init());
} else {
  WriteSysRenderer.init();
}
