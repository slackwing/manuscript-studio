/**
 * Sentence-history left-margin bars.
 *
 * FIVE bars parallel to the text. Rightmost (closest to text) = EDIT — the
 * render-winner suggested edit vs. the current text; then lane 1 (current
 * vs. 1-ago) out to lane 4 (3-ago vs. 4-ago), oldest leftmost — so a
 * hover reads left-to-right as 4 ago … 1 ago, now, edit.
 *
 * Color is a WORD-diff ratio (same rule for history and edit): green =
 * added words, red = removed words, g = green/(green+red):
 *   g ≥ 0.80 → green; g ≤ 0.20 → red; otherwise blue.
 *   Newly inserted → green; identical text / no words changed → no bar.
 *
 * Overlap rule is deliberately dumb: every bar covers ALL the lines of its
 * sentence, drawn in iteration order — a later sentence's bars paint over
 * an earlier one's where lines are shared. Simple beats clever here.
 *
 * Hover any bar to open a popup of all versions, oldest-on-top.
 */

const WriteSysHistory = {
  apiBaseUrl: 'api',

  bySentenceId: {},

  LANE_COUNT: 4,
  LANE_WIDTH_EM: 0.5,
  LANE_GAP_EM: 0.05,
  // Pre-flattened "color × opacity" RGB so adjacent same-lane bars don't
  // produce darker stripes where they overlap via alpha compositing.
  // Tier 0 = lane 1 (newest), tier 3 = lane 4 (oldest).
  COLORS: {
    green: ['#5CB85C', '#94D094', '#C4E5C4', '#E5F3E5'],
    blue:  ['#5BC0DE', '#95D6EA', '#C5E9F3', '#E7F5FA'],
    red:   ['#D9534F', '#E68986', '#F0BCBA', '#F8E1E0'],
  },
  // The EDIT bar is a live proposal, not history — one saturated step up.
  EDIT_COLORS: { green: '#449D44', blue: '#31B0D5', red: '#C9302C' },

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

  // Word-diff counts between two texts: green = words added in newer,
  // red = words removed. Uses d-m-p's word mode (the same
  // diff_linesToWords_ the suggestion diff renders with — it's a prototype
  // extension from suggestions.js, probed lazily so load order is moot).
  wordDelta(older, newer) {
    const D = window.diff_match_patch;
    if (!D || !D.prototype.diff_linesToWords_) return null;
    if (!this._dmp) this._dmp = new D();
    const a = this._dmp.diff_linesToWords_(older || '', newer || '');
    const diffs = this._dmp.diff_main(a.chars1, a.chars2, false);
    this._dmp.diff_charsToLines_(diffs, a.lineArray);
    let green = 0;
    let red = 0;
    for (let i = 0; i < diffs.length; i++) {
      const words = (diffs[i][1].match(/\S+/g) || []).length;
      if (diffs[i][0] === 1) green += words;
      else if (diffs[i][0] === -1) red += words;
    }
    return { green, red };
  },

  // Returns 'green' | 'blue' | 'red' | null (no bar). older may be null for
  // inserts. ONE rule for history lanes and the EDIT bar: by word count of
  // the colored diff, g = green/(green+red) — g ≥ .80 green, g ≤ .20 red,
  // else blue (enough of both). No changed words → no bar.
  diffColor(newer, older) {
    if (older === null || older === undefined) {
      return this.alnumCount(newer) > 0 ? 'green' : null;
    }
    if (newer === older) return null;
    // Whitespace shuffles aren't word changes: normalize before diffing so
    // 'a  b' vs 'a b' is "no changed words → no bar", not a phantom blue.
    const norm = (t) => String(t).replace(/\s+/g, ' ').trim();
    const nNew = norm(newer);
    const nOld = norm(older);
    if (nNew === nOld) return null;
    const d = this.wordDelta(nOld, nNew);
    if (!d) {
      // d-m-p missing (never on the book page; belt-and-braces): fall back
      // to the old alnum-count delta rule.
      const newC = this.alnumCount(newer);
      const oldC = this.alnumCount(older);
      if (oldC === 0) return newC > 0 ? 'green' : null;
      const ratio = (newC - oldC) / oldC;
      if (ratio >= 0.25) return 'green';
      if (ratio <= -0.25) return 'red';
      return 'blue';
    }
    const total = d.green + d.red;
    if (total === 0) return null; // whitespace/punctuation-only shuffle
    const g = d.green / total;
    if (g >= 0.8) return 'green';
    if (g <= 0.2) return 'red';
    return 'blue';
  },

  // The EDIT bar: the render-winner suggestion vs. the current text — the
  // suggestion counts as ONE sentence however many sentences it splits
  // into (it lives under one sentence id). No suggestion → no bar.
  editColor(sentenceId, currentText) {
    const sugMap = window.WriteSysSuggestions && window.WriteSysSuggestions.renderBySentenceId;
    if (!sugMap || !(sentenceId in sugMap)) return null;
    const suggested = sugMap[sentenceId];
    if (suggested === currentText) return null;
    if (!this.alnumCount(suggested)) return 'red'; // deletion proposal
    return this.diffColor(suggested, currentText || '');
  },

  currentTextOf(sentenceId) {
    const sentEl = document.querySelector(`.sentence[data-sentence-id="${sentenceId}"]`);
    if (!sentEl) return null;
    return (window.WriteSysRenderer && window.WriteSysRenderer.sentenceMap)
      ? window.WriteSysRenderer.sentenceMap[sentenceId] || sentEl.textContent
      : sentEl.textContent;
  },

  // Returns up to LANE_COUNT lane colors (or nulls) for a sentence.
  // lanes[k] = the (k)-ago → (k+1)-ago boundary (lanes[0] = current vs 1-ago).
  lanesFor(sentenceId) {
    const entry = this.bySentenceId[sentenceId];
    if (!entry) return new Array(this.LANE_COUNT).fill(null);
    const history = entry.history || [];
    // texts[N] = N commits ago (texts[0] = current, fetched from the DOM
    // since the response only carries the prior versions).
    const texts = new Array(this.LANE_COUNT + 1).fill(null);
    texts[0] = this.currentTextOf(sentenceId);
    history.forEach(h => {
      if (h.commits_ago >= 1 && h.commits_ago <= this.LANE_COUNT) {
        texts[h.commits_ago] = h.text;
      }
    });
    const lanes = [];
    for (let k = 0; k < this.LANE_COUNT; k++) {
      lanes.push(this.diffColor(texts[k], texts[k + 1]));
    }
    return lanes;
  },

  render() {
    document.querySelectorAll('.history-bar-container').forEach(el => el.remove());

    Object.keys(this.bySentenceId).forEach(sentenceId => {
      const lanes = this.lanesFor(sentenceId);
      const edit = this.editColor(sentenceId, this.currentTextOf(sentenceId));
      if (!edit && lanes.every(c => !c)) return;

      const fragments = document.querySelectorAll(`.sentence[data-sentence-id="${sentenceId}"]`);
      fragments.forEach(sentence => {
        const page = sentence.closest('.pagedjs_page');
        if (!page) return;
        const pageArea = page.querySelector('.pagedjs_page_content');
        if (!pageArea) return;

        const sentenceRect = sentence.getBoundingClientRect();
        const pageRect = pageArea.getBoundingClientRect();
        // Rect deltas are SCREEN px but this container lives inside the
        // (mobile-)scaled page subtree — convert to layout px or the offset
        // scales twice and the bars drift off their sentences (see
        // renderer.pageScale). Computed line/font sizes are already layout px.
        const s = (window.WriteSysRenderer && window.WriteSysRenderer.pageScale)
          ? window.WriteSysRenderer.pageScale() : 1;

        // sentenceRect.height is the text-run box, not the full line slot;
        // pad by half the line-leading so adjacent bars tile without gaps.
        const lineHeight = parseFloat(getComputedStyle(sentence).lineHeight) || sentenceRect.height / s;
        const fontHeight = parseFloat(getComputedStyle(sentence).fontSize) || sentenceRect.height / s;
        const padPerSide = Math.max(0, (lineHeight - fontHeight) / 2);

        const top = Math.round((sentenceRect.top - pageRect.top) / s - padPerSide);
        const height = Math.round(sentenceRect.height / s + padPerSide * 2);

        const slotCount = this.LANE_COUNT + 1; // + the EDIT bar
        const totalWidthEm = slotCount * this.LANE_WIDTH_EM + (slotCount - 1) * this.LANE_GAP_EM;
        const container = document.createElement('div');
        container.className = 'history-bar-container';
        container.dataset.sentenceId = sentenceId;
        container.style.position = 'absolute';
        container.style.top = `${top}px`;
        container.style.right = 'calc(100% + 5px)';
        container.style.width = `${totalWidthEm}em`;
        container.style.height = `${height}px`;
        container.style.zIndex = '10';

        // Slot 0 → rightmost (closest to text) = EDIT; slots 1..LANE_COUNT
        // = lane 1 (newest) out to lane 4 (oldest, leftmost) — a hover
        // reads left-to-right as 4 ago … 1 ago, edit.
        const slots = [
          { key: 'edit', color: edit, fill: edit && this.EDIT_COLORS[edit] },
        ].concat(lanes.map((color, k) => ({
          key: String(k + 1), color, fill: color && this.COLORS[color][k],
        })));
        slots.forEach((slot, idx) => {
          if (!slot.color) return;
          const lane = document.createElement('div');
          lane.className = 'history-bar';
          lane.style.position = 'absolute';
          lane.style.top = '0';
          lane.style.height = '100%';
          lane.style.width = `${this.LANE_WIDTH_EM}em`;
          const offsetEm = idx * (this.LANE_WIDTH_EM + this.LANE_GAP_EM);
          lane.style.right = `${offsetEm}em`;
          lane.style.backgroundColor = slot.fill;
          lane.style.pointerEvents = 'auto';
          lane.style.cursor = 'help';
          lane.dataset.lane = slot.key;
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
    const currentText = (window.WriteSysRenderer && window.WriteSysRenderer.sentenceMap)
      ? window.WriteSysRenderer.sentenceMap[sentenceId] || ''
      : '';
    const editLane = this.editColor(sentenceId, currentText || this.currentTextOf(sentenceId));
    if (!editLane && lanes.every(c => !c)) return;

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
    {
      // The EDIT row: the pending render-winner suggestion, "(none)" when
      // there isn't one — the timeline always ends … now, edit.
      const sugMap = window.WriteSysSuggestions && window.WriteSysSuggestions.renderBySentenceId;
      const suggested = sugMap && sentenceId in sugMap ? sugMap[sentenceId] : undefined;
      const row = document.createElement('div');
      row.className = 'history-popup-row history-popup-edit';
      const label = document.createElement('span');
      label.className = 'history-popup-label';
      label.textContent = 'edit';
      const text = document.createElement('span');
      text.className = 'history-popup-text';
      const tm = window.WriteSysTextMarkers;
      if (suggested === undefined) {
        text.textContent = '(none)';
        text.classList.add('history-popup-empty');
      } else if (suggested === '') {
        text.textContent = '(delete)';
        text.classList.add('history-popup-empty');
      } else {
        text.textContent = tm ? tm.toGlyphs(suggested) : suggested;
      }
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
