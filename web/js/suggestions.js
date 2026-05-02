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

      // Use sentenceMap (storage form, leading \n\t / \n\n included) rather
      // than span.textContent (which has those stripped). This way a sentence
      // that was already a new paragraph diffs cleanly against a suggestion
      // that preserves that leading marker — the marker shows up as EQ
      // instead of an INS that would render a duplicate paragraph break in
      // the preview.
      const map = (window.WriteSysRenderer && window.WriteSysRenderer.sentenceMap) || {};
      const original = (map[id] !== undefined) ? map[id] : span.textContent;
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

    // Live conversion: a real newline pressed in the textarea is the
    // user's natural way of expressing a paragraph break. Map \n\n → §
    // (section) and remaining \n → ¶ (paragraph) on every input. Done
    // here rather than only on save so the user sees the glyphs the
    // moment they hit Enter, matching what the diff in the page shows.
    if (tm) {
      textarea.addEventListener('input', () => {
        const before = textarea.value;
        // Skip if no newlines — saves the round-trip on most keystrokes.
        if (!/\n/.test(before)) return;
        const caret = textarea.selectionStart;
        // Count newline characters before the caret so we can adjust.
        const newlinesBefore = (before.slice(0, caret).match(/\n/g) || []).length;
        const after = before.replace(/\n\n/g, tm.SECTION_GLYPH).replace(/\n/g, tm.PARAGRAPH_GLYPH);
        if (after === before) return;
        textarea.value = after;
        // Each \n collapses to a 1-char glyph, so subtract the count
        // of newlines that were strictly before the caret.
        const newCaret = caret - newlinesBefore;
        textarea.setSelectionRange(newCaret, newCaret);
      });
    }

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
//   * Asterisks → <em>. Done in a post-pass (pairItalicsAcrossInserts)
//     because the diff often splits an italic pair across two inserts
//     ("*A ... away*" becomes <strong>...*A</strong> ... <strong>away*</strong>)
//     and per-segment substitution can't see the matching `*`.
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
  // original interleaving. Italics are NOT substituted here — see the
  // pairItalicsAcrossInserts pass below for why.
  const parts = [];
  let i = 0;
  while (i < segs.length) {
    if (segs[i][0] === 0) {
      parts.push(escapeHTML(segs[i][1]));
      i++;
      continue;
    }
    let dels = '', inses = '';
    while (i < segs.length && segs[i][0] !== 0) {
      if (segs[i][0] === -1) dels += segs[i][1];
      else if (segs[i][0] === 1) inses += segs[i][1];
      i++;
    }
    if (dels) parts.push(`<del>${escapeHTML(dels)}</del>`);
    if (inses) parts.push(`<strong>${escapeHTML(inses)}</strong>`);
  }
  return renderStructuralMarkers(pairItalicsAcrossInserts(parts.join('')));
}

// Replace storage-form structural markers with visible inline HTML.
//   \n\n  → "§" + line break + indent (section break)
//   \n\t  → "¶" + line break + indent (paragraph break)
// The break is purely visual — the surrounding .sentence span still owns
// the click handler / data-sentence-id. Inside a <del> we render a
// struck-through marker only (no actual <br>), so removed paragraph
// breaks read naturally instead of pulling text down to a new line.
//
// Indent matches p.indented (text-indent: 2em) so the preview reads like
// a real paragraph break would after commit + resegmentation.
function renderStructuralMarkers(html) {
  // Walk the string tracking which diff context we're inside (<del>,
  // <strong>, or neither = EQ) and whether we've emitted any visible
  // content yet. Three rules:
  //   * Leading EQ marker: emit nothing. The marker was already there
  //     pre-edit; the surrounding <p> shows it; a glyph would just be
  //     noise the user didn't add or change.
  //   * Leading INS or DEL marker: emit the glyph (so the user sees
  //     they added/removed it) but no <br>+indent (the <p> handles the
  //     visual break). DEL gets the strikethrough via parent <del>.
  //   * Mid-content marker: full preview — glyph + <br> + 2em indent —
  //     except inside <del> where we skip the break (it's being removed).
  let out = '';
  let inDel = false;
  let inStrong = false;
  let inTag = false;
  let leading = true;
  for (let i = 0; i < html.length; i++) {
    const c = html[i];
    if (c === '<') {
      inTag = true;
      if (html.startsWith('<del', i)) inDel = true;
      else if (html.startsWith('</del>', i)) inDel = false;
      else if (html.startsWith('<strong', i)) inStrong = true;
      else if (html.startsWith('</strong>', i)) inStrong = false;
      out += c;
      continue;
    }
    if (inTag) {
      out += c;
      if (c === '>') inTag = false;
      continue;
    }
    if (c === '\n' && (html[i + 1] === '\n' || html[i + 1] === '\t')) {
      const glyph = (html[i + 1] === '\n') ? '§' : '¶';
      const isEq = !inDel && !inStrong;
      if (leading && isEq) {
        // Pre-existing marker at sentence start — drop entirely.
      } else if (leading || inDel) {
        out += `<span class="suggested-marker">${glyph}</span>`;
      } else {
        out += `<span class="suggested-marker">${glyph}</span><br><span class="suggested-pindent"></span>`;
      }
      i++;
      continue;
    }
    if (!/\s/.test(c)) leading = false;
    out += c;
  }
  return out;
}

// Replace *x* with <em>x</em> across the assembled diff HTML. The naïve
// per-segment substitution misses the common case where the user wraps
// existing text in asterisks: the diff splits the open and close `*`
// into separate <strong> inserts with unchanged text between, e.g.
//   <strong>fixtures. *A</strong> tesselated ... <strong>away*.</strong>
// Pair these by scanning the full HTML, tracking whether we're inside
// a <del> (whose asterisks are "deleted markdown" and must not pair
// with surviving ones), and inserting <em> tags around the matched
// content. The resulting <em> may straddle a <strong> boundary —
// browsers handle <em>foo<strong>bar</strong>baz</em> fine in inline
// flow, and the visual result is the intended italics.
function pairItalicsAcrossInserts(html) {
  // Find positions of `*` outside <del>...</del> and outside any tag.
  const stars = [];
  let inDel = false;
  let inTag = false;
  for (let i = 0; i < html.length; i++) {
    const c = html[i];
    if (c === '<') {
      inTag = true;
      // Detect <del ...> open and </del> close.
      if (html.startsWith('<del', i)) inDel = true;
      else if (html.startsWith('</del>', i)) inDel = false;
      continue;
    }
    if (inTag) {
      if (c === '>') inTag = false;
      continue;
    }
    if (c === '*' && !inDel) stars.push(i);
  }
  // Pair greedily: 0+1, 2+3, etc. Replace from the right so earlier
  // indices stay valid.
  const pairs = [];
  for (let i = 0; i + 1 < stars.length; i += 2) {
    pairs.push([stars[i], stars[i + 1]]);
  }
  for (let p = pairs.length - 1; p >= 0; p--) {
    const [a, b] = pairs[p];
    html = html.slice(0, a) + '<em>' + html.slice(a + 1, b) + '</em>' + html.slice(b + 1);
  }
  return html;
}

// Used only by the no-d-m-p fallback path. The main path escapes
// per-segment and then runs pairItalicsAcrossInserts on the joined HTML
// to handle cross-insert italic pairs.
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
