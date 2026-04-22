/**
 * Sentence-history left-margin bars.
 *
 * Three lanes parallel to the manuscript text on the LEFT margin. Each lane
 * encodes "what changed across one specific commit boundary":
 *   - lane 1 (closest to text, opacity 1.0): current vs. 1 commit ago
 *   - lane 2 (opacity 0.5):                  1 commit ago vs. 2 commits ago
 *   - lane 3 (farthest, opacity 0.2):        2 commits ago vs. 3 commits ago
 *
 * Bar color reflects alphanumeric character delta vs. the older version:
 *   - newly inserted (no prior version):  green
 *   - ≥25% more chars: green
 *   - ≥25% fewer chars: red
 *   - in between: yellow
 *   - identical text: no bar in that lane
 *
 * Hover any bar on a sentence → popup left of the bars showing all available
 * versions stacked oldest-on-top, plain text.
 */

const WriteSysHistory = {
  // Relative URL so the page's <base href> resolves it correctly when the app
  // is mounted under a prefix (e.g. /manuscripts on a shared subdomain).
  apiBaseUrl: 'api',

  // Filled by loadHistory() — sentence_id → { history: [{text, commits_ago}, ...] }
  bySentenceId: {},

  LANE_COUNT: 3,
  LANE_WIDTH_EM: 0.5,
  LANE_GAP_EM: 0.05,
  LANE_OPACITIES: [1.0, 0.5, 0.2],
  COLORS: {
    green: '#5CB85C',
    yellow: '#F0AD4E',
    red: '#D9534F',
  },

  async loadHistory(migrationID) {
    if (!migrationID) return;
    try {
      const response = await fetchJSON(`${this.apiBaseUrl}/migrations/${migrationID}/history`, {}, true);
      this.bySentenceId = {};
      (response.sentences || []).forEach(s => {
        this.bySentenceId[s.sentence_id] = s;
      });
      this.render();
    } catch (err) {
      console.warn('history endpoint failed (ignored):', err.message || err);
    }
  },

  // Count alphanumeric characters (matches feature spec).
  alnumCount(text) {
    if (!text) return 0;
    let count = 0;
    for (const ch of text) {
      if ((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')) {
        count++;
      }
    }
    return count;
  },

  // Returns one of 'green' | 'yellow' | 'red' | null. null = no change → no bar.
  // newer/older are sentence text strings; older may be null (newly inserted).
  diffColor(newer, older) {
    const newC = this.alnumCount(newer);
    if (older === null || older === undefined) {
      return newC > 0 ? 'green' : null;
    }
    if (newer === older) return null;
    const oldC = this.alnumCount(older);
    if (oldC === 0) return newC > 0 ? 'green' : null;
    const ratio = (newC - oldC) / oldC;
    if (ratio >= 0.25) return 'green';
    if (ratio <= -0.25) return 'red';
    return 'yellow';
  },

  // For a given sentence, returns up to LANE_COUNT lane colors (or nulls).
  lanesFor(sentenceId) {
    const entry = this.bySentenceId[sentenceId];
    if (!entry) return [null, null, null];
    const history = entry.history || [];
    // Need text per "commits_ago"; build {0: currentText, 1: ..., 2: ..., 3: ...}.
    // Current text isn't in the response — we look it up from the DOM.
    // Lane N compares versions N-1 vs N (where N=0 is current).
    const texts = [null, null, null, null];
    const sentEl = document.querySelector(`.sentence[data-sentence-id="${sentenceId}"]`);
    if (sentEl) {
      // The renderer holds the canonical text in WriteSysRenderer.sentenceMap.
      // Fall back to the visible text if needed.
      texts[0] = (window.WriteSysRenderer && window.WriteSysRenderer.sentenceMap)
        ? window.WriteSysRenderer.sentenceMap[sentenceId] || sentEl.textContent
        : sentEl.textContent;
    }
    history.forEach(h => {
      if (h.commits_ago >= 1 && h.commits_ago <= 3) {
        texts[h.commits_ago] = h.text;
      }
    });
    return [
      this.diffColor(texts[0], texts[1]), // lane 1
      this.diffColor(texts[1], texts[2]), // lane 2
      this.diffColor(texts[2], texts[3]), // lane 3
    ];
  },

  render() {
    document.querySelectorAll('.history-bar-container').forEach(el => el.remove());

    Object.keys(this.bySentenceId).forEach(sentenceId => {
      const lanes = this.lanesFor(sentenceId);
      if (lanes.every(c => !c)) return;

      const fragments = document.querySelectorAll(`.sentence[data-sentence-id="${sentenceId}"]`);
      fragments.forEach(sentence => {
        const page = sentence.closest('.pagedjs_page');
        if (!page) return;
        const pageArea = page.querySelector('.pagedjs_page_content');
        if (!pageArea) return;

        const sentenceRect = sentence.getBoundingClientRect();
        const pageRect = pageArea.getBoundingClientRect();
        const top = Math.round(sentenceRect.top - pageRect.top);
        const height = Math.round(sentenceRect.height);

        const totalWidthEm = this.LANE_COUNT * this.LANE_WIDTH_EM + (this.LANE_COUNT - 1) * this.LANE_GAP_EM;
        const container = document.createElement('div');
        container.className = 'history-bar-container';
        container.dataset.sentenceId = sentenceId;
        container.style.position = 'absolute';
        container.style.top = `${top}px`;
        container.style.right = 'calc(100% + 5px)';
        container.style.width = `${totalWidthEm}em`;
        container.style.height = `${height}px`;
        container.style.zIndex = '10';

        // Lane 1 = innermost (right edge, closest to text). Lane 3 = leftmost.
        lanes.forEach((color, idx) => {
          if (!color) return;
          const lane = document.createElement('div');
          lane.className = 'history-bar';
          lane.style.position = 'absolute';
          lane.style.top = '0';
          lane.style.height = '100%';
          lane.style.width = `${this.LANE_WIDTH_EM}em`;
          // idx 0 → rightmost (innermost), idx 2 → leftmost.
          const offsetEm = idx * (this.LANE_WIDTH_EM + this.LANE_GAP_EM);
          lane.style.right = `${offsetEm}em`;
          lane.style.backgroundColor = this.COLORS[color];
          lane.style.opacity = String(this.LANE_OPACITIES[idx]);
          lane.style.pointerEvents = 'auto';
          lane.style.cursor = 'help';
          lane.dataset.lane = String(idx + 1);
          container.appendChild(lane);
        });

        // Hover anywhere in container shows the popup.
        container.addEventListener('mouseenter', () => this.showPopup(container, sentenceId));
        container.addEventListener('mouseleave', () => this.hidePopup());

        pageArea.appendChild(container);
      });
    });
  },

  showPopup(container, sentenceId) {
    this.hidePopup();
    const entry = this.bySentenceId[sentenceId];
    if (!entry || !entry.history || entry.history.length === 0) return;

    const currentText = (window.WriteSysRenderer && window.WriteSysRenderer.sentenceMap)
      ? window.WriteSysRenderer.sentenceMap[sentenceId] || ''
      : '';

    const popup = document.createElement('div');
    popup.className = 'history-popup';
    popup.id = 'history-popup';

    // Stack oldest → newest, with current on the bottom.
    const versions = [...entry.history].sort((a, b) => b.commits_ago - a.commits_ago);
    versions.forEach(v => {
      const row = document.createElement('div');
      row.className = 'history-popup-row';
      const label = document.createElement('span');
      label.className = 'history-popup-label';
      label.textContent = `${v.commits_ago} ago`;
      const text = document.createElement('span');
      text.className = 'history-popup-text';
      text.textContent = v.text;
      row.appendChild(label);
      row.appendChild(text);
      popup.appendChild(row);
    });
    if (currentText) {
      const row = document.createElement('div');
      row.className = 'history-popup-row history-popup-current';
      const label = document.createElement('span');
      label.className = 'history-popup-label';
      label.textContent = 'now';
      const text = document.createElement('span');
      text.className = 'history-popup-text';
      text.textContent = currentText;
      row.appendChild(label);
      row.appendChild(text);
      popup.appendChild(row);
    }

    document.body.appendChild(popup);
    const containerRect = container.getBoundingClientRect();
    const popupRect = popup.getBoundingClientRect();
    let top = containerRect.top + window.scrollY;
    let left = containerRect.left + window.scrollX - popupRect.width - 8;
    if (left < 8) left = containerRect.right + window.scrollX + 8;
    popup.style.top = `${top}px`;
    popup.style.left = `${left}px`;
  },

  hidePopup() {
    const existing = document.getElementById('history-popup');
    if (existing) existing.remove();
  },
};

window.WriteSysHistory = WriteSysHistory;
