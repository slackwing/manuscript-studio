/**
 * Suggested-edits feature.
 *
 * Keyed by original sentence_id so it never drifts even if a suggestion adds
 * or removes sentence boundaries. The word-level diff (via diff-match-patch)
 * is rendered inline into the existing .sentence span by applyToSpans(),
 * called from renderManuscript() AFTER wrapSentences() and BEFORE smartquotes
 * so the diff compares straight quotes against straight quotes.
 *
 * Loaded in parallel with the manuscript; endpoint failure is non-fatal.
 */

const WriteSysSuggestions = {
  apiBaseUrl: 'api',

  // sentence_id → suggestion text.
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

  // For each .sentence with a suggestion, replace innerHTML with word-level
  // diff. Idempotent — spans are recreated on every re-render.
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
      <textarea class="suggestion-modal-textarea" rows="6" spellcheck="false"></textarea>
      <div class="suggestion-modal-actions">
        <button type="button" class="suggestion-modal-cancel">Cancel</button>
        <button type="button" class="suggestion-modal-save">Save</button>
      </div>
    `;

    document.body.appendChild(overlay);
    document.body.appendChild(modal);

    // Show glyphs in the textarea so the user sees and edits paragraph
    // markers visually instead of literal whitespace.
    const tm = window.WriteSysTextMarkers;
    const textarea = modal.querySelector('.suggestion-modal-textarea');
    textarea.value = tm ? tm.toGlyphs(current) : current;
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);

    const close = () => {
      overlay.remove();
      modal.remove();
    };

    const save = async () => {
      // Convert UI form (glyphs OR escape literals OR raw chars) → storage form.
      const newText = tm ? tm.fromGlyphs(textarea.value) : textarea.value;
      close();
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

      // Stamp the URL so a manual reload (or post-push refresh) returns to
      // this sentence instead of the top of the manuscript. Use replaceState
      // so we don't pollute back/forward history.
      const url = new URL(window.location.href);
      url.searchParams.set('scroll_to', sentenceId);
      window.history.replaceState(null, '', url.toString());

      if (window.WriteSysRenderer && window.WriteSysRenderer.renderManuscript) {
        await window.WriteSysRenderer.renderManuscript();
      }
      if (window.WriteSysPush) {
        window.WriteSysPush.refresh();
      }
      // Re-pagination by Paged.js dumps the viewport at the top; scroll back
      // to the just-edited sentence so the diff is visible.
      scrollToSentence(sentenceId);
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
// Falls back to a single <strong> wrap when diff-match-patch isn't loaded.
function renderDiffHTML(oldText, newText, dmp) {
  if (!dmp) return `<strong>${escapeHTML(newText)}</strong>`;
  // Standard d-m-p trick: map each whitespace-token to a unique char, diff
  // at the char level, then map back. cleanupSemantic readability pass.
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
  // d-m-p Diff objects are array-like but not real Arrays; destructuring throws.
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

// Word-level tokeniser shim: d-m-p ships diff_linesToChars_ for line diffs;
// adapt to whitespace-delimited "words" so prose reads naturally
// ("the cat" → "the big cat" diffs as inserting "big ").
(function patchDMP() {
  if (typeof diff_match_patch === 'undefined') return;
  diff_match_patch.prototype.diff_linesToWords_ = function(text1, text2) {
    const lineArray = [];
    const lineHash = {};
    lineArray[0] = '';
    function munge(text) {
      let chars = '';
      let lineArrayLength = lineArray.length;
      // Tokenize ws-runs AND non-ws-runs so missing/extra spaces show up too.
      const re = /\s+|\S+/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const token = m[0];
        if (lineHash.hasOwnProperty(token)) {
          chars += String.fromCharCode(lineHash[token]);
        } else {
          // 65535 = one UTF-16 code unit max; punt to char diff if exceeded.
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

// Scroll the .sentence with a given data-sentence-id into view. Sentences
// can be split across pages by Paged.js (multiple span fragments share the
// same id) — picking the first fragment is fine since they're laid out in
// document order. Defers a tick to let any pending Paged.js layout settle.
function scrollToSentence(sentenceId) {
  if (!sentenceId) return;
  // rAF + small delay: Paged.js renders asynchronously; without this the
  // span exists but its layout coords are still 0,0 right after re-render.
  requestAnimationFrame(() => setTimeout(() => {
    const el = document.querySelector(`.sentence[data-sentence-id="${CSS.escape(sentenceId)}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, 50));
}

// On a fresh page load, restore scroll position from ?scroll_to=. The
// renderer fires renderManuscript() during init; we need to wait until
// .sentence elements exist before trying to scroll. Poll briefly because
// Paged.js doesn't expose a "render done" event we can hook.
function restoreScrollFromURL() {
  const target = new URLSearchParams(window.location.search).get('scroll_to');
  if (!target) return;
  const escaped = CSS.escape(target);
  const start = Date.now();
  const tick = () => {
    const el = document.querySelector(`.sentence[data-sentence-id="${escaped}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'auto', block: 'center' });
      return;
    }
    if (Date.now() - start < 10000) setTimeout(tick, 100);
  };
  tick();
}

document.addEventListener('DOMContentLoaded', restoreScrollFromURL);

window.WriteSysSuggestions = WriteSysSuggestions;
