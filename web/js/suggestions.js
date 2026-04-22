/**
 * Suggested-edits feature.
 *
 * One in-memory map keyed by the original (unchanged) sentence_id so the
 * sentence_id never drifts even when a suggestion adds/removes sentence
 * boundaries. The diff vs. original is rendered inline (word-level via
 * diff-match-patch) into the existing <span class="sentence"> by
 * applyToSpans(), called from renderManuscript() AFTER wrapSentences() and
 * BEFORE smartquotes — so the diff compares straight quotes against straight
 * quotes (a curly-vs-straight apostrophe would otherwise show as a diff).
 *
 * Persisted via /api/sentences/{id}/suggestion. Loaded in parallel with the
 * manuscript by loadForMigration() — endpoint failure is non-fatal (the page
 * renders without diff markup until next reload).
 */

const WriteSysSuggestions = {
  apiBaseUrl: 'api',

  // sentence_id → suggestion text. Authoritative for the current render.
  bySentenceId: {},

  async loadForMigration(migrationID) {
    if (!migrationID) return;
    try {
      const resp = await fetchJSON(`${this.apiBaseUrl}/migrations/${migrationID}/suggestions`, {}, true);
      this.bySentenceId = {};
      (resp.suggestions || []).forEach(s => {
        this.bySentenceId[s.sentence_id] = s.text;
      });
    } catch (err) {
      console.warn('suggestions endpoint failed (ignored):', err.message || err);
      this.bySentenceId = {};
    }
  },

  // Walk every .sentence span in `container` and, for any whose id has a
  // suggestion, replace its inner HTML with a word-level diff. Idempotent:
  // safe to call after re-render since spans are recreated each time.
  applyToSpans(container) {
    const root = container || document;
    const spans = root.querySelectorAll('.sentence[data-sentence-id]');
    const dmp = (typeof diff_match_patch !== 'undefined') ? new diff_match_patch() : null;

    spans.forEach(span => {
      const id = span.dataset.sentenceId;
      const suggestion = this.bySentenceId[id];
      if (suggestion === undefined) return;

      const original = span.textContent;
      span.classList.add('has-suggestion');
      span.innerHTML = renderDiffHTML(original, suggestion, dmp);
    });
  },

  openModal(sentenceId) {
    if (document.getElementById('suggestion-modal')) return;
    const original = (window.WriteSysRenderer && window.WriteSysRenderer.sentenceMap)
      ? window.WriteSysRenderer.sentenceMap[sentenceId] || ''
      : '';
    const current = (this.bySentenceId[sentenceId] !== undefined)
      ? this.bySentenceId[sentenceId]
      : original;

    const overlay = document.createElement('div');
    overlay.id = 'suggestion-modal-overlay';

    const modal = document.createElement('div');
    modal.id = 'suggestion-modal';
    modal.innerHTML = `
      <div class="suggestion-modal-title">Suggest edit</div>
      <div class="suggestion-modal-hint">Edit the sentence source. Enter saves; Esc cancels.</div>
      <textarea class="suggestion-modal-textarea" rows="6" spellcheck="false"></textarea>
      <div class="suggestion-modal-actions">
        <button type="button" class="suggestion-modal-cancel">Cancel</button>
        <button type="button" class="suggestion-modal-save">Save</button>
      </div>
    `;

    document.body.appendChild(overlay);
    document.body.appendChild(modal);

    const textarea = modal.querySelector('.suggestion-modal-textarea');
    textarea.value = current;
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);

    const close = () => {
      overlay.remove();
      modal.remove();
    };

    const save = async () => {
      const newText = textarea.value;
      close();
      // No change vs. what was already present → nothing to do.
      if (newText === current) return;

      try {
        const resp = await authenticatedFetch(`${this.apiBaseUrl}/sentences/${sentenceId}/suggestion`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: newText }),
        });
        if (!resp.ok && resp.status !== 204) {
          throw new Error(`HTTP ${resp.status}`);
        }
      } catch (err) {
        console.error('save suggestion failed:', err);
        alert('Failed to save suggestion');
        return;
      }

      // Server collapses "text == original" into a delete; reflect locally.
      if (newText === original) {
        delete this.bySentenceId[sentenceId];
      } else {
        this.bySentenceId[sentenceId] = newText;
      }

      if (window.WriteSysRenderer && window.WriteSysRenderer.renderManuscript) {
        await window.WriteSysRenderer.renderManuscript();
      }
    };

    overlay.addEventListener('click', close);
    modal.querySelector('.suggestion-modal-cancel').addEventListener('click', close);
    modal.querySelector('.suggestion-modal-save').addEventListener('click', save);

    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        save();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    });
  },
};

// Render a word-level diff as <del>removed</del><strong>added</strong>.
// Falls back to a single <strong> wrap of the new text when diff-match-patch
// isn't loaded — still visible as a suggestion, just without per-word marks.
function renderDiffHTML(oldText, newText, dmp) {
  if (!dmp) return `<strong>${escapeHTML(newText)}</strong>`;
  // Word-level diff: tokenise on whitespace boundaries by mapping tokens to
  // unique chars (the standard diff-match-patch trick), diff at the char
  // level, then map back. cleanupSemantic produces human-readable spans.
  const a = dmp.diff_linesToWords_ ? dmp.diff_linesToWords_(oldText, newText) : null;
  let diffs;
  if (a) {
    diffs = dmp.diff_main(a.chars1, a.chars2, false);
    dmp.diff_charsToLines_(diffs, a.lineArray);
  } else {
    diffs = dmp.diff_main(oldText, newText);
  }
  dmp.diff_cleanupSemantic(diffs);

  const parts = [];
  // diff-match-patch's Diff objects are array-like (.length === 2, [0]=op,
  // [1]=text) but not real Arrays — destructuring throws "not iterable".
  for (let i = 0; i < diffs.length; i++) {
    const op = diffs[i][0];
    const data = diffs[i][1];
    const html = escapeHTML(data);
    if (op === 0) parts.push(html);
    else if (op === -1) parts.push(`<del>${html}</del>`);
    else if (op === 1) parts.push(`<strong>${html}</strong>`);
  }
  return parts.join('');
}

// Word-level tokeniser shim: diff-match-patch ships diff_linesToChars_ for
// line-level diffs. We adapt it to whitespace-delimited "words" so prose
// reads naturally: "the cat" → "the big cat" diffs as inserting "big ".
(function patchDMP() {
  if (typeof diff_match_patch === 'undefined') return;
  diff_match_patch.prototype.diff_linesToWords_ = function(text1, text2) {
    const lineArray = [];
    const lineHash = {};
    lineArray[0] = '';
    function munge(text) {
      let chars = '';
      let lineArrayLength = lineArray.length;
      // Whitespace runs and non-whitespace runs are both tokens — that way a
      // missing or extra space shows up in the diff, not just changed words.
      const re = /\s+|\S+/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const token = m[0];
        if (lineHash.hasOwnProperty(token)) {
          chars += String.fromCharCode(lineHash[token]);
        } else {
          // 65535 unique tokens fits in one UTF-16 code unit; punt to char
          // diff for inputs that exceed it.
          if (lineArrayLength === 65535) return null;
          chars += String.fromCharCode(lineArrayLength);
          lineHash[token] = lineArrayLength;
          lineArray[lineArrayLength++] = token;
        }
      }
      return chars;
    }
    const chars1 = munge(text1);
    const chars2 = munge(text2);
    if (chars1 === null || chars2 === null) return null;
    return { chars1, chars2, lineArray };
  };
})();

function escapeHTML(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

window.WriteSysSuggestions = WriteSysSuggestions;
