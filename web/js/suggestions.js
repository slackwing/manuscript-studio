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

      // Stamp the URL so a manual hard-reload comes back to this sentence
      // instead of the top of the manuscript. replaceState — don't pollute
      // back/forward history.
      const url = new URL(window.location.href);
      url.searchParams.set('scroll_to', sentenceId);
      window.history.replaceState(null, '', url.toString());

      if (window.WriteSysRenderer && window.WriteSysRenderer.renderManuscript) {
        // Pass the sentence id as both anchor (preserves viewport position
        // across re-pagination) and selection target (highlights it after
        // re-render so the user sees what changed).
        await window.WriteSysRenderer.renderManuscript({
          anchorSentenceId: sentenceId,
          selectSentenceId: sentenceId,
        });
      }
      if (window.WriteSysPush) {
        window.WriteSysPush.refresh();
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
// Falls back to a single <strong> wrap when diff-match-patch isn't loaded.
//
// Two non-obvious decisions:
//   * No diff_cleanupSemantic. It runs *after* diff_charsToLines_ has
//     expanded each token-char back to its full token text, and at that
//     point it operates char-by-char and will happily split tokens
//     ("wildfires" → "wild" + "fires") to find smaller common substrings.
//     The token-level diff already produces whole-word changes, so we skip
//     the readability pass to preserve token boundaries.
//   * Asterisks → <em>. Matches renderer.applyInlineFormatting so a
//     suggestion like "*alone*" renders italicized in the diff view
//     instead of showing literal green asterisks.
function renderDiffHTML(oldText, newText, dmp) {
  if (!dmp) return `<strong>${applyInlineFormatting(newText)}</strong>`;
  const a = dmp.diff_linesToWords_ ? dmp.diff_linesToWords_(oldText, newText) : null;
  let diffs;
  if (a) {
    diffs = dmp.diff_main(a.chars1, a.chars2, false);
    dmp.diff_charsToLines_(diffs, a.lineArray);
  } else {
    diffs = dmp.diff_main(oldText, newText);
  }

  // d-m-p Diff objects are array-like but not real Arrays; copy into a
  // plain [op, data] array so we can splice/merge freely.
  const segs = [];
  for (let i = 0; i < diffs.length; i++) segs.push([diffs[i][0], diffs[i][1]]);

  // Coalesce alternating del/ins runs into contiguous blocks. The token
  // diff produces e.g. DEL "big" EQ " " DEL "red" because spaces between
  // changed words match — visually that's an unreadable barber-pole. Pull
  // pure-whitespace EQ runs INTO the surrounding del+ins so each change
  // becomes one red-strike block followed by one green-bold block.
  //
  // Rule: an EQ run consisting only of whitespace, with a del or ins on
  // both sides (in either order), is absorbed into both. Stops at any
  // non-whitespace EQ — those are real preserved content and must stay
  // visible.
  const isWS = s => /^\s+$/.test(s);
  function neighborsHaveChange(idx) {
    let hasDel = false, hasIns = false;
    for (let j = idx - 1; j >= 0 && segs[j][0] !== 0; j--) {
      if (segs[j][0] === -1) hasDel = true;
      if (segs[j][0] === 1) hasIns = true;
    }
    for (let j = idx + 1; j < segs.length && segs[j][0] !== 0; j++) {
      if (segs[j][0] === -1) hasDel = true;
      if (segs[j][0] === 1) hasIns = true;
    }
    return hasDel && hasIns;
  }
  for (let i = 0; i < segs.length; i++) {
    if (segs[i][0] === 0 && isWS(segs[i][1]) && neighborsHaveChange(i)) {
      const ws = segs[i][1];
      segs.splice(i, 1);
      // Append to last del-block before, prepend to first ins-block after.
      // Fall back to creating a new segment if the corresponding side is
      // missing (shouldn't happen given neighborsHaveChange, but safe).
      let delIdx = -1;
      for (let j = i - 1; j >= 0 && segs[j][0] !== 0; j--) {
        if (segs[j][0] === -1) { delIdx = j; break; }
      }
      if (delIdx >= 0) segs[delIdx][1] += ws;
      let insIdx = -1;
      for (let j = i; j < segs.length && segs[j][0] !== 0; j++) {
        if (segs[j][0] === 1) { insIdx = j; break; }
      }
      if (insIdx >= 0) segs[insIdx][1] = ws + segs[insIdx][1];
      i--; // re-check the now-collapsed neighborhood
    }
  }

  // Group adjacent dels and inses so they emit as single tags. Order
  // within a change cluster: dels first, then inses, regardless of
  // original interleaving.
  const parts = [];
  let i = 0;
  while (i < segs.length) {
    if (segs[i][0] === 0) {
      parts.push(applyInlineFormatting(segs[i][1]));
      i++;
      continue;
    }
    let dels = '', inses = '';
    while (i < segs.length && segs[i][0] !== 0) {
      if (segs[i][0] === -1) dels += segs[i][1];
      else if (segs[i][0] === 1) inses += segs[i][1];
      i++;
    }
    if (dels) parts.push(`<del>${applyInlineFormatting(dels)}</del>`);
    if (inses) parts.push(`<strong>${applyInlineFormatting(inses)}</strong>`);
  }
  return parts.join('');
}

// Escape HTML, then turn *x* into <em>x</em>. Mirrors the inline formatting
// applied to non-suggestion sentences in renderer.applyInlineFormatting so
// italics survive the diff overlay. Per-segment: a *...* pair split across
// an insert/delete boundary won't italicize — accepted as rare.
function applyInlineFormatting(text) {
  return escapeHTML(text).replace(/\*([^*]+)\*/g, '<em>$1</em>');
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
      // Also mark it selected so the user instantly sees what changed.
      document.querySelectorAll(`.sentence[data-sentence-id="${escaped}"]`).forEach(s => s.classList.add('selected'));
      if (window.WriteSysRenderer) window.WriteSysRenderer.currentSelectedSentenceId = target;
      return;
    }
    if (Date.now() - start < 10000) setTimeout(tick, 100);
  };
  tick();
}

document.addEventListener('DOMContentLoaded', restoreScrollFromURL);

window.WriteSysSuggestions = WriteSysSuggestions;
