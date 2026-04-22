/**
 * Sentence-history left-margin bars.
 *
 * Three lanes parallel to the text. Lane 1 = closest to text = newest comparison
 * (current vs. 1-ago); lane 3 = oldest (2-ago vs. 3-ago).
 *
 * Color encodes alphanumeric char-count delta vs. older:
 *   newly inserted or ≥25% more → green; ≥25% fewer → red; otherwise yellow;
 *   identical text → no bar in that lane.
 *
 * Hover any bar to open a popup of all versions, oldest-on-top.
 */

const WriteSysHistory = {
  apiBaseUrl: 'api',

  bySentenceId: {},

  LANE_COUNT: 3,
  LANE_WIDTH_EM: 0.5,
  LANE_GAP_EM: 0.05,
  // Pre-flattened "color × opacity" RGB so adjacent same-lane bars don't
  // produce darker stripes where they overlap via alpha compositing.
  // Tier 0 = lane 1 (newest), tier 2 = lane 3 (oldest).
  COLORS: {
    green: ['#5CB85C', '#AEDCAE', '#DEEFDE'],
    blue:  ['#5BC0DE', '#AEE0EF', '#DEEFF6'],
    red:   ['#D9534F', '#ECA9A7', '#F7DDDC'],
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

  // Returns 'green' | 'blue' | 'red' | null (no bar). older may be null for inserts.
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
    return 'blue';
  },

  // Returns up to LANE_COUNT lane colors (or nulls) for a sentence.
  lanesFor(sentenceId) {
    const entry = this.bySentenceId[sentenceId];
    if (!entry) return [null, null, null];
    const history = entry.history || [];
    // texts[N] = N commits ago (texts[0] = current, fetched from the DOM
    // since the response only carries the prior versions).
    const texts = [null, null, null, null];
    const sentEl = document.querySelector(`.sentence[data-sentence-id="${sentenceId}"]`);
    if (sentEl) {
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
      this.diffColor(texts[0], texts[1]),
      this.diffColor(texts[1], texts[2]),
      this.diffColor(texts[2], texts[3]),
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

        // sentenceRect.height is the text-run box, not the full line slot;
        // pad by half the line-leading so adjacent bars tile without gaps.
        const lineHeight = parseFloat(getComputedStyle(sentence).lineHeight) || sentenceRect.height;
        const fontHeight = parseFloat(getComputedStyle(sentence).fontSize) || sentenceRect.height;
        const padPerSide = Math.max(0, (lineHeight - fontHeight) / 2);

        const top = Math.round(sentenceRect.top - pageRect.top - padPerSide);
        const height = Math.round(sentenceRect.height + padPerSide * 2);

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

        // idx 0 → rightmost lane (closest to text); idx 2 → leftmost.
        lanes.forEach((color, idx) => {
          if (!color) return;
          const lane = document.createElement('div');
          lane.className = 'history-bar';
          lane.style.position = 'absolute';
          lane.style.top = '0';
          lane.style.height = '100%';
          lane.style.width = `${this.LANE_WIDTH_EM}em`;
          const offsetEm = idx * (this.LANE_WIDTH_EM + this.LANE_GAP_EM);
          lane.style.right = `${offsetEm}em`;
          lane.style.backgroundColor = this.COLORS[color][idx];
          lane.style.pointerEvents = 'auto';
          lane.style.cursor = 'help';
          lane.dataset.lane = String(idx + 1);
          container.appendChild(lane);
        });

        container.addEventListener('mouseenter', () => this.showPopup(container, sentenceId));
        container.addEventListener('mouseleave', () => this.hidePopup());

        pageArea.appendChild(container);
      });
    });
  },

  showPopup(container, sentenceId) {
    this.hidePopup();
    const entry = this.bySentenceId[sentenceId];
    const lanes = this.lanesFor(sentenceId);
    if (lanes.every(c => !c)) return;

    const currentText = (window.WriteSysRenderer && window.WriteSysRenderer.sentenceMap)
      ? window.WriteSysRenderer.sentenceMap[sentenceId] || ''
      : '';

    const popup = document.createElement('div');
    popup.className = 'history-popup';
    popup.id = 'history-popup';

    // Walk oldest → newest, padding missing slots with "(empty)" so the user
    // can see when the sentence first appeared.
    const byCommitsAgo = new Map();
    if (entry && entry.history) {
      entry.history.forEach(v => byCommitsAgo.set(v.commits_ago, v.text));
    }
    for (let n = this.LANE_COUNT; n >= 1; n--) {
      const text = byCommitsAgo.get(n);
      const row = document.createElement('div');
      row.className = 'history-popup-row';
      const label = document.createElement('span');
      label.className = 'history-popup-label';
      label.textContent = `${n} ago`;
      const textSpan = document.createElement('span');
      textSpan.className = 'history-popup-text';
      const tm = window.WriteSysTextMarkers;
      if (text === undefined) {
        textSpan.textContent = '(empty)';
        textSpan.classList.add('history-popup-empty');
      } else if (text === currentText) {
        // Collapse identical-to-current to "(same)" so the user doesn't
        // have to compare two identical paragraphs to spot what changed.
        textSpan.textContent = '(same)';
        textSpan.classList.add('history-popup-empty');
      } else {
        textSpan.textContent = tm ? tm.toGlyphs(text) : text;
      }
      row.appendChild(label);
      row.appendChild(textSpan);
      popup.appendChild(row);
    }
    if (currentText) {
      const row = document.createElement('div');
      row.className = 'history-popup-row history-popup-current';
      const label = document.createElement('span');
      label.className = 'history-popup-label';
      label.textContent = 'now';
      const text = document.createElement('span');
      text.className = 'history-popup-text';
      const tm = window.WriteSysTextMarkers;
      text.textContent = tm ? tm.toGlyphs(currentText) : currentText;
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
