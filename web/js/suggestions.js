/**
 * Suggested-edits feature.
 *
 * Suggestions are keyed by original sentence_id so they never drift even if
 * an edit adds or removes sentence boundaries. Rendering is the FRAGMENT
 * MODEL (SUGGESTION_RENDER_PLAN.md): renderer.js renderSentencesToHTML
 * builds each sentence from its EFFECTIVE text (the suggestion if one
 * exists, else committed), segmented into command/prose fragments; a
 * lone-prose edit is word-diffed against the committed prose via
 * renderDiffHTML (defined in this file, called from the renderer). The diff
 * runs on RAW straight-quote text; smartquotes runs on the assembled HTML
 * afterwards (AGENTS.md N9 — don't reorder).
 *
 * Loaded in parallel with the manuscript; endpoint failure is non-fatal.
 */

// Desktop↔mobile breakpoint — must match book.css:3056
// `@media (max-width: 1239px)`. DERIVED, not arbitrary (AGENTS.md N13):
// 2×(band 300 + gap 32) + page 576 = 1240 is the narrowest viewport where
// the page and both gutter bands fit side by side.
const SUGGESTIONS_MOBILE_MEDIA = '(max-width: 1239px)';

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

  // putSuggestion PUTs a sentence's suggestion text — the ONE write path,
  // shared by the modal autosaver and range-delete.js. Throws an Error with
  // .status on a non-OK response (409 = stale migration). Callers own any
  // local bySentenceId mirroring and/or refetching.
  async putSuggestion(sentenceId, text) {
    const resp = await authenticatedFetch(
      `${this.apiBaseUrl}/sentences/${encodeURIComponent(sentenceId)}/suggestion`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
    if (!resp.ok) {
      const err = new Error('HTTP ' + resp.status);
      err.status = resp.status;
      throw err;
    }
  },

  openModal(sentenceId) {
    if (document.getElementById('suggestion-modal')) return;
    const original = (window.WriteSysRenderer && window.WriteSysRenderer.sentenceMap)
      ? window.WriteSysRenderer.sentenceMap[sentenceId] || ''
      : '';
    const openCurrent = (this.bySentenceId[sentenceId] !== undefined)
      ? this.bySentenceId[sentenceId]
      : original;

    // RIGHT-pane versions: 0 = committed (this migration); k = the text k
    // commits back, straight from the history-bars data already loaded for the
    // left margin (previous_sentence_id chains, 3 back). A version whose text
    // matches the one after it is greyed out — nothing changed there.
    const histEntry = (window.WriteSysHistory && window.WriteSysHistory.bySentenceId)
      ? window.WriteSysHistory.bySentenceId[sentenceId] : null;
    const hist = (histEntry && histEntry.history) || [];
    const versions = [{ k: 0, text: original }];
    for (let k = 1; k <= 3; k++) {
      const h = hist[k - 1];
      versions.push({ k, text: h ? h.text : null });
    }

    const overlay = document.createElement('div');
    overlay.id = 'suggestion-modal-overlay';
    const modal = document.createElement('div');
    modal.id = 'suggestion-modal';
    const railBtns = versions.map((v) => {
      if (v.k === 0) {
        return '<button type="button" class="sn-rail-btn sn-rail-peer" data-ver="0" title="Committed text (current)">0</button>';
      }
      const prev = versions[v.k - 1].text;
      const plural = v.k > 1 ? 's' : '';
      const dis = v.text == null || v.text === prev;
      const title = v.text == null ? `No record ${v.k} commits back`
        : dis ? `Unchanged ${v.k} commit${plural} ago`
        : `${v.k} commit${plural} ago`;
      return `<button type="button" class="sn-rail-btn sn-rail-peer" data-ver="${v.k}" title="${title}"${dis ? ' disabled' : ''}>${v.k}</button>`;
    }).join('');
    // EXACTLY the snippet widget's chrome (scratchpad.css): sn-cols → sn-main
    // (sn-header + sn-body with the split) + sn-rail down the right edge, the
    // * button in the corner where a widget shows its variation letter. The edit
    // pane IS the variation editor — raw .manuscript text, real newlines, Tab
    // inserts a literal \t (rendered as → by the shared overlay). No glyphs,
    // no break buttons.
    modal.innerHTML = `
      <div class="sn-cols">
        <div class="sn-main">
          <div class="sn-header">
            <span class="sn-status" title="Your edit auto-saves as you type. Closing flushes first — nothing is lost.">Suggest edit</span><span class="sn-save"></span>
          </div>
          <div class="sn-body">
            <div class="sn-split">
              <div class="sn-split-left">
                <div class="sn-note"><strong>*</strong> suggested edit</div>
                <div class="sgm-left"></div>
              </div>
              <div class="sn-split-right">
                <div class="sn-note sgm-version-label"></div>
                <textarea class="suggestion-modal-original sgm-version-text" readonly spellcheck="false"></textarea>
              </div>
            </div>
          </div>
        </div>
        <div class="sn-rail">
          <button type="button" class="sn-rail-btn sn-rail-self" title="Your edit — auto-saved as you type.">*</button>
          ${railBtns}
        </div>
      </div>`;
    document.body.appendChild(overlay);

    // MOBILE: the note margin is hidden, so the sentence's notes stack BELOW
    // the modal — and everything lives INSIDE the overlay as normal flowing
    // content (the overlay becomes a scrollable column, see the book.css
    // mobile block). No fixed-position math: real phones bring pinch zoom,
    // keyboards, and collapsing URL bars that make measured coordinates lie.
    // Desktop keeps the classic fixed-centered modal (modal stays a sibling).
    const mobile = window.matchMedia(SUGGESTIONS_MOBILE_MEDIA).matches;
    let notesStack = null;
    if (mobile) {
      overlay.appendChild(modal);
      if (window.WriteSysNotes && window.WriteSysNotes.buildMobileNoteStack) {
        notesStack = window.WriteSysNotes.buildMobileNoteStack(sentenceId, original);
        if (notesStack) overlay.appendChild(notesStack);
      }
    } else {
      document.body.appendChild(modal);
    }

    // Version selector → right pane (read-only, same monospace metrics as the
    // edit pane so the two align char-for-char).
    const originalArea = modal.querySelector('.suggestion-modal-original');
    const verLabel = modal.querySelector('.sgm-version-label');
    const showVersion = (k) => {
      originalArea.value = versions[k].text || '';
      verLabel.innerHTML = k === 0
        ? '<strong>0</strong> committed (current)'
        : `<strong>${k}</strong> ${k} commit${k > 1 ? 's' : ''} ago`;
      modal.querySelectorAll('.sn-rail [data-ver]').forEach((b) =>
        b.classList.toggle('active', parseInt(b.dataset.ver, 10) === k));
    };
    modal.querySelectorAll('.sn-rail [data-ver]').forEach((b) => {
      b.addEventListener('click', () => {
        if (!b.disabled) showVersion(parseInt(b.dataset.ver, 10));
      });
    });

    // LEFT pane: the SHARED edit component (edit-pane.js) — the same
    // autosave-as-you-type, retry ladder, dirty tracking, tab overlay and
    // flush-or-refuse close that snippet widgets use.
    let staleAlerted = false;
    // Draft safety net: restore a fresh unsaved draft (failed saves / crash).
    const draftKey = `ms-draft-suggest-${sentenceId}`;
    const draft = window.WriteSysEditPane.readDraft(draftKey);
    const restored = !!(draft && draft.t !== openCurrent);
    const pane = window.WriteSysEditPane.createMonoEditor({
      value: restored ? draft.t : openCurrent,
      overlayHTML: window.WriteSysEditPane.tabMarkupHTML,
      onInput: () => saver.poke(),
    });
    pane.textarea.classList.add('suggestion-modal-textarea');
    const saver = window.WriteSysEditPane.createAutosaver({
      initialValue: openCurrent, // server truth — a restored draft counts as dirty
      draftKey,
      getValue: () => pane.textarea.value,
      save: async (newText) => {
        await this.putSuggestion(sentenceId, newText);
        // Server collapses "text == original" into a delete; mirror locally.
        if (newText === original) delete this.bySentenceId[sentenceId];
        else this.bySentenceId[sentenceId] = newText;
      },
      statusEl: modal.querySelector('.sn-save'),
      onFatal: (e) => {
        if (e.status !== 409) return null;
        // 409 = stale migration (see the stale banner / poll in renderer.js):
        // reloading is the only way forward, but the user must get a chance to
        // copy their text out first.
        if (!staleAlerted) {
          staleAlerted = true;
          alert('The manuscript was updated underneath this edit. Copy your text somewhere safe, then reload the page.');
        }
        return 'manuscript updated — copy your text, then reload';
      },
    });
    modal.querySelector('.sgm-left').appendChild(pane.wrap);
    const textarea = pane.textarea;
    showVersion(0);

    // Closing ALWAYS flushes first; a failing save keeps the modal open with
    // the retry/stale status showing — an accidental overlay click or Escape
    // can no longer lose anything.
    const close = async () => {
      if (!(await saver.flush())) return;
      saver.destroy();
      if (notesStack) {
        notesStack.remove();
        notesStack = null;
      }
      overlay.remove();
      modal.remove();
      const finalText = (this.bySentenceId[sentenceId] !== undefined)
        ? this.bySentenceId[sentenceId] : original;
      if (finalText === openCurrent) return; // no net change → no re-render

      // Stamp the URL so a manual hard-reload comes back to this sentence
      // instead of the top of the manuscript. replaceState — don't pollute
      // back/forward history.
      const url = new URL(window.location.href);
      url.searchParams.set('scroll_to', sentenceId);
      window.history.replaceState(null, '', url.toString());

      // Optimistic: patch the sentence inside the CURRENT pages so the edit
      // is visible the instant the modal closes; the full re-paginate below
      // (seconds on a long manuscript) then swaps in the authoritative
      // layout. Selection is applied here for the interim too — the full
      // render re-applies it on the fresh spans.
      if (window.WriteSysRenderer && window.WriteSysRenderer.patchSentenceInPlace) {
        if (window.WriteSysRenderer.patchSentenceInPlace(sentenceId)) {
          document.querySelectorAll(`.sentence[data-sentence-id="${CSS.escape(sentenceId)}"]`)
            .forEach((el) => el.classList.add('selected'));
        }
      }

      if (window.WriteSysRenderer && window.WriteSysRenderer.renderManuscript) {
        await window.WriteSysRenderer.renderManuscript({
          anchorSentenceId: sentenceId,
          selectSentenceId: sentenceId,
        });
      }
      if (window.WriteSysPush) {
        window.WriteSysPush.refresh();
      }
    };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    modal.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    });
    // Variation-editor keys: Tab inserts a literal \t (a "\n\t" paragraph break
    // is typeable); Shift-Tab still escapes the field.
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        pane.insertAtCaret('\t');
      }
    });

    // Autofocus only on desktop: on a phone, focusing pops the keyboard and
    // the browser PANS to the caret — shoving the modal's title bar off-screen
    // and burying the note stack. Mobile users tap the pane when they want to
    // type; until then the modal (and the notes below it) stay fully visible.
    if (!window.matchMedia(SUGGESTIONS_MOBILE_MEDIA).matches) {
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    }
    pane.autoGrow();
    if (restored) {
      modal.querySelector('.sn-save').textContent = 'restored unsaved draft';
      saver.poke();
    }
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
  if (!dmp) return `<strong>${formatFallbackHTML(newText)}</strong>`;
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
  // Only coalesce a whitespace EQ that sits BETWEEN two change clusters.
  // Both immediate neighbors must be non-EQ (a del or ins). A leading or
  // trailing whitespace EQ would otherwise get absorbed into the
  // adjacent change and render as a phantom marker — e.g. a preserved
  // \n\n at sentence start being pulled into the next INS and rendered
  // as a fake section-break preview.
  function isInterChange(idx) {
    const prev = idx > 0 && segs[idx - 1][0] !== 0;
    const next = idx + 1 < segs.length && segs[idx + 1][0] !== 0;
    return prev && next;
  }
  for (let i = 0; i < segs.length; i++) {
    if (segs[i][0] === 0 && isWS(segs[i][1]) && isInterChange(i)) {
      const ws = segs[i][1];
      segs.splice(i, 1);
      // Append to last del-block before, prepend to first ins-block after.
      // Fall back to creating a new segment if the corresponding side is
      // missing (shouldn't happen given isInterChange, but safe).
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
  //     they added/removed it) but no <br>+indent — the renderer's
  //     paragraph grouping already previews the suggested structure
  //     (renderSentencesToHTML follows the suggestion's leading marker),
  //     so an added break gets a real <p> and a removed one merges the
  //     sentence into the previous <p>, with the struck-through glyph
  //     (via parent <del>) marking the join.
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
      // §/¶ come from text-markers.js (script-global constants; it loads
      // first) — the single home of the marker-glyph vocabulary.
      const glyph = (html[i + 1] === '\n') ? SECTION_GLYPH : PARAGRAPH_GLYPH;
      const isEq = !inDel && !inStrong;
      if (leading && isEq) {
        // Pre-existing marker at sentence start — drop entirely.
      } else if (leading || inDel) {
        out += `<span class="suggested-marker">${glyph}</span>`;
      } else {
        out += `<span class="suggested-marker">${glyph}</span><br><span class="suggested-pindent">\u00a0\u00a0\u00a0\u00a0</span>`;
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

// Used only by the no-d-m-p fallback path of renderDiffHTML. NOT the same
// as renderer.js applyInlineFormatting — that one also renders inline
// &-commands; this is a bare escape + *italics* pass, so it keeps a
// distinct name. The main diff path escapes per-segment and then runs
// pairItalicsAcrossInserts on the joined HTML to handle cross-insert
// italic pairs.
function formatFallbackHTML(text) {
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

// escapeHTML comes from text-markers.js (shared definition; loads first).

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
