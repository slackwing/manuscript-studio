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

  // OWN fresh suggestions: sentence_id → text. The write-side view — modal
  // seeding, canonize/import composition, draft keys. Multi-user rendering
  // reads renderBySentenceId instead.
  bySentenceId: {},

  // v3 multi-user state (PERMISSIONS_PLAN §4).
  rows: [],               // every row the server let us see
  rowsBySentence: {},     // sid → fresh rows
  staleBySentence: {},    // sid → stale rows (dotted-underline affordance)
  renderBySentenceId: {}, // sid → TEXT of the winning suggestion (rendered diff)
  renderRowBySentence: {},// sid → the winning ROW (attribution, ✓/✗)
  viewer: '',
  canReview: false, // manage-suggestions (v3.1: covers OWN suggestions too)
  peopleRank: null,       // username → rank; null until People order loads

  async loadForMigration(migrationID) {
    if (!migrationID) return;
    try {
      const resp = await fetchJSON(`${this.apiBaseUrl}/migrations/${migrationID}/suggestions`, {}, true);
      this.rows = resp.suggestions || [];
      this.viewer = resp.viewer || (window.currentSession && window.currentSession.username) || '';
      this.canReview = !!resp.can_review;
      await this.ensurePeopleRank();
      this.rebuildMaps();
    } catch (err) {
      console.warn('suggestions endpoint failed (ignored):', err.message || err);
      this.rows = [];
      this.rebuildMaps();
    }
  // Counts on the chrome buttons derive from these rows — refresh them
    // whenever the rows change hands.
    if (window.WriteSysPush) window.WriteSysPush.refresh();
  },

  // People order → rank map (the display-priority tiebreak). Loaded once
  // per page; a saved drag order or role-seniority default, from the same
  // endpoint the People tab uses. Failure degrades to viewer-first.
  async ensurePeopleRank() {
    if (this.peopleRank) return;
    const r = window.WriteSysRenderer;
    if (!r || !r.manuscriptId) return;
    if (!this.rows.some(s => s.user_id !== this.viewer)) return; // own-only view — no order needed
    try {
      const data = await fetchJSON(`${this.apiBaseUrl}/manuscripts/${r.manuscriptId}/people`, {}, true);
      // v3.2: the viewer's saved order is a localStorage display preference
      // overlaid on the server's role-seniority default.
      let order = data.order || [];
      try {
        const saved = JSON.parse(localStorage.getItem(`ms-people-order-${r.manuscriptId}`) || 'null');
        if (saved && saved.length) {
          const valid = new Set(order);
          const merged = saved.filter(u => valid.has(u));
          order.forEach(u => { if (!merged.includes(u)) merged.push(u); });
          order = merged;
        }
      } catch (e) { /* corrupt saved order — default wins */ }
      const rank = {};
      order.forEach((u, i) => { rank[u] = i; });
      this.peopleRank = rank;
    } catch (e) {
      this.peopleRank = null;
    }
  },

  rebuildMaps() {
    // The history bars' EDIT lane reads renderBySentenceId — refresh them
    // once this rebuild (and the sentence re-render that follows) settles.
    // Post-pagination loadHistory remains the authoritative layout pass.
    if (window.WriteSysHistory) {
      clearTimeout(this._historyRefresh);
      this._historyRefresh = setTimeout(() => window.WriteSysHistory.render(), 50);
    }
    this.bySentenceId = {};
    this.rowsBySentence = {};
    this.staleBySentence = {};
    this.renderBySentenceId = {};
    this.renderRowBySentence = {};
    const rankOf = (u) => {
      if (this.peopleRank && u in this.peopleRank) return this.peopleRank[u];
      return u === this.viewer ? 0 : 1 << 20; // fallback: my own edits first
    };
    for (const s of this.rows) {
      if (s.stale) {
        (this.staleBySentence[s.sentence_id] = this.staleBySentence[s.sentence_id] || []).push(s);
        continue;
      }
      (this.rowsBySentence[s.sentence_id] = this.rowsBySentence[s.sentence_id] || []).push(s);
      if (s.user_id === this.viewer) this.bySentenceId[s.sentence_id] = s.text;
    }
    // Winner per sentence: an ACCEPTED suggestion always wins (accepting is
    // exclusive per sentence); otherwise the first non-rejected by People
    // rank. Rejected suggestions never render in the manuscript — they stay
    // reachable through the modal's left rail.
    Object.keys(this.rowsBySentence).forEach(sid => {
      const cands = this.rowsBySentence[sid]
        .filter(s => s.review_status !== 'rejected')
        .sort((a, b) => {
          const aa = a.review_status === 'accepted' ? 0 : 1;
          const ab = b.review_status === 'accepted' ? 0 : 1;
          if (aa !== ab) return aa - ab;
          return rankOf(a.user_id) - rankOf(b.user_id);
        });
      if (cands.length) {
        this.renderBySentenceId[sid] = cands[0].text;
        this.renderRowBySentence[sid] = cands[0];
      }
    });
  },

  // Sentences with any UNREVIEWED suggestion row (stale included) — those
  // sentences are still pending: they neither push nor count as reviewed.
  _pendingSentences() {
    const pending = new Set();
    this.rows.forEach(s => { if (!s.review_status) pending.add(s.sentence_id); });
    return pending;
  },

  // PUSHABLE accepted rows ('all' | 'own') — fresh, accepted, and on a
  // fully-reviewed sentence (SUGGESTION_REVIEW_RULES.md). The push
  // button's live count; mirrors the server's push gate exactly.
  acceptedCount(scope) {
    const pending = this._pendingSentences();
    return this.rows.filter(s => !s.stale && s.review_status === 'accepted'
      && !pending.has(s.sentence_id)
      && (scope !== 'own' || s.user_id === this.viewer)).length;
  },

  // reviewedSentences: {reviewed, total} over sentences carrying ANY
  // suggestion row — a sentence counts reviewed only when EVERY row on it
  // (stale included) has a verdict. The ✓✗ button's progress readout.
  reviewedSentences() {
    const all = new Set();
    this.rows.forEach(s => all.add(s.sentence_id));
    const pending = this._pendingSentences();
    return { reviewed: all.size - pending.size, total: all.size };
  },

  // suggestionTotal: ALL fresh (non-stale) suggestions in scope — the
  // denominator of the accept button's (accepted/total) readout.
  suggestionTotal(scope) {
    return this.rows.filter(s => !s.stale
      && (scope !== 'own' || s.user_id === this.viewer)).length;
  },

  ownPendingCount() {
    return this.rows.filter(s => !s.stale && s.user_id === this.viewer && !s.review_status).length;
  },

  // uncontestedPendingCount: unreviewed fresh suggestions that are the ONLY
  // live suggestion on their sentence — what a batch accept would take.
  // scope 'own' counts the viewer's; 'all' counts everyone's.
  uncontestedPendingCount(scope) {
    let n = 0;
    Object.values(this.rowsBySentence).forEach(rows => {
      const live = rows.filter(r => r.review_status !== 'rejected');
      if (live.length !== 1) return; // contested (or nothing live)
      const r = live[0];
      if (r.review_status) return;   // already accepted
      if (scope === 'own' && r.user_id !== this.viewer) return;
      n++;
    });
    return n;
  },

  // Dotted-underline pass for stale suggestions — runs with the other
  // post-pagination affordance passes.
  markStaleSentences() {
    document.querySelectorAll('.sentence.has-stale-sugg').forEach(el => el.classList.remove('has-stale-sugg'));
    Object.keys(this.staleBySentence).forEach(sid => {
      document.querySelectorAll(`.sentence[data-sentence-id="${CSS.escape(sid)}"]`)
        .forEach(el => el.classList.add('has-stale-sugg'));
    });
  },

  // suggestedOrder: sentence ids carrying ANY suggestion row (fresh OR
  // stale, verdicted or not), in book order — the ‹ i/n › nav space. This
  // is EXACTLY the set the ✓✗ counter counts (reviewedSentences), so the
  // readout and the tour always agree; rejected/stale edits don't render
  // in the manuscript, but the tour still stops there and the modal opens
  // on the edit in question.
  suggestedOrder(filter) {
    const R = window.WriteSysRenderer;
    if (!R || !R.currentSentences) return [];
    return R.currentSentences.map(s => s.id).filter(id => {
      const fresh = this.rowsBySentence[id] || [];
      const stale = this.staleBySentence[id] || [];
      if (!fresh.length && !stale.length) return false;
      // 'pending': only sentences still awaiting a verdict (stale rows
      // included — they demand review too; the counter's complement).
      if (filter === 'pending') {
        return fresh.some(r => !r.review_status) || stale.some(r => !r.review_status);
      }
      return true;
    });
  },

  // _navModal: flip to the previous/next suggested edit. The open modal
  // flushes via its Escape path (close() flushes; a failing save keeps it
  // open), then the neighbor opens.
  async _navModal(currentId, step) {
    const list = this.suggestedOrder();
    if (!list.length) return;
    let i = list.indexOf(currentId);
    if (i < 0) {
      // Current sentence has no suggestion — land on the nearest one in
      // the step direction by document position.
      const R = window.WriteSysRenderer;
      const order = R.currentSentences.map(s => s.id);
      const pos = order.indexOf(currentId);
      i = step > 0
        ? list.findIndex(id => order.indexOf(id) > pos)
        : (() => { let k = -1; list.forEach((id, j) => { if (order.indexOf(id) < pos) k = j; }); return k; })();
      if (i < 0) i = step > 0 ? 0 : list.length - 1; // nothing in that direction — wrap
      const target = list[i];
      if (!this._activeClose || await this._activeClose()) {
        if (window.WriteSysRenderer && window.WriteSysRenderer.scrollToSentence) {
          window.WriteSysRenderer.scrollToSentence(target);
        }
        this.openModal(target);
      }
      return;
    }
    const j = (i + step + list.length) % list.length; // the tour wraps
    const target = list[j];
    if (!this._activeClose || await this._activeClose()) {
      // The page follows the tour — the flipped-to edit scrolls into view
      // under the modal.
      if (window.WriteSysRenderer && window.WriteSysRenderer.scrollToSentence) {
        window.WriteSysRenderer.scrollToSentence(target);
      }
      this.openModal(target);
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

  openModal(sentenceId, opts) {
    if (document.getElementById('suggestion-modal')) return;
    opts = opts || {};
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
    // ---- The shared two-pane shell (pane-widget.js) --------------------
    // LEFT pane (always shows): your editable suggestion, or a read-only
    // view of another user's / a stale one — chosen on the left rail
    // (you at top: "0" until your text differs, then your letter).
    // RIGHT pane: committed history (0..3), open by default at 0; re-click
    // the selected version to collapse it. Accept ✓ / Reject ✗ are STATE
    // icon buttons on the left pane's action row, colored when active.
    const others = (this.rowsBySentence[sentenceId] || []).filter(r => r.user_id !== this.viewer);
    const stale = this.staleBySentence[sentenceId] || [];
    const mineRow = () => (this.rowsBySentence[sentenceId] || []).find(r => r.user_id === this.viewer);
    const ownLetter = (this.viewer[0] || '?').toUpperCase();
    let textarea = null; // assigned once the edit pane mounts below
    let leftCtl = null, rightCtl = null; // formatted↔mono controllers, mounted after the panes
    const ownChanged = () => !!textarea && textarea.value !== original;
    const GREEN = '#2e7d32';
    const RED = '#b03030';
    const reviewColor = (row) => row && row.review_status === 'accepted' ? GREEN
      : row && row.review_status === 'rejected' ? RED : null;

    const leftEntries = () => {
      const me = mineRow();
      const list = [{
        key: 'me', kind: 'me',
        label: ownChanged() || me ? ownLetter : '0',
        title: ownChanged() || me ? 'Your suggestion' : 'Committed text — type to suggest',
        color: reviewColor(me),
        // Your basis: the stored one, or — while typing something new —
        // the current text itself (you are writing against it right now).
        basis: me ? (me.base_text != null ? me.base_text : null) : original,
      }];
      others.forEach((r) => list.push({
        key: 'u:' + r.user_id, kind: 'other', row: r,
        label: (r.user_id[0] || '?').toUpperCase(),
        title: `${r.user_id}'s suggestion`,
        color: reviewColor(r),
        basis: r.base_text != null ? r.base_text : null,
      }));
      stale.forEach((r, i) => list.push({
        key: 'st:' + i, kind: 'stale', row: r,
        label: (r.user_id[0] || '?').toUpperCase(),
        title: `${r.user_id}'s STALE suggestion (from an earlier commit — review or reject)`,
        className: 'stale',
        color: reviewColor(r),
        basis: r.base_text != null ? r.base_text : null,
      }));
      return list;
    };
    let leftSel = 'me'; // tracked locally — the widget calls onSelect before `w` exists
    const leftEntry = () => leftEntries().find(e => e.key === leftSel) || leftEntries()[0];

    const ICON_CHECK = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M3 8.5l3.5 3.5L13 4.5"/></svg>';
    const ICON_X = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" d="M4 4l8 8M12 4l-8 8"/></svg>';
    const ICON_REVERT = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M3.2 6.2a5.2 5.2 0 1 1-.4 3.3"/><path fill="currentColor" d="M2.2 2.2v4.8h4.8z"/></svg>';
    const ICON_REDO = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M12.8 6.2a5.2 5.2 0 1 0 .4 3.3"/><path fill="currentColor" d="M13.8 2.2v4.8H9z"/></svg>';
    // Redo is deliberately SHORT-LIVED: it exists only between a revert and
    // the next keystroke (or a reopen) — an "in case" escape hatch, not a
    // history stack.
    let redoText = null;

    const review = async (entry, target) => {
      try {
        // Own suggestion may still be mid-autosave — flush so the row
        // exists server-side before reviewing it.
        if (entry.kind === 'me' && !(await saver.flush())) return;
        const row = entry.kind === 'me' ? mineRow() : entry.row;
        if (!row) return;
        const next = row.review_status === target ? null : target; // re-click clears
        const resp = await authenticatedFetch(
          `${this.apiBaseUrl}/sentences/${encodeURIComponent(sentenceId)}/suggestion/review`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: row.user_id, status: next }),
          });
        if (resp.status === 409) {
          alert('Another suggestion on this sentence is already accepted.');
          return;
        }
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        row.review_status = next;
        // Accepting FRESHENS a stale row (server does the same): it becomes
        // a live accepted edit of the sentence as it now reads — and its
        // badge basis rebases to the current text.
        if (next === 'accepted') {
          row.stale = false;
          row.base_text = original;
        }
        this.rebuildMaps();
        syncReviewShade();
        w.refresh();
        if (window.WriteSysPush) window.WriteSysPush.refresh();
        // A verdict ends the look-closer: back to the formatted view, focus
        // released — so ←/→ flips straight to the next suggested edit.
        if (textarea) textarea.blur();
        if (leftCtl) leftCtl.exitMono();
      } catch (e) {
        alert('Review failed: ' + (e.message || e));
      }
    };

    const leftActions = () => {
      const btns = [];
      const entry = leftEntry();
      if (this.canReview && entry) {
        const row = entry.kind === 'me' ? mineRow() : entry.row;
        if (row || (entry.kind === 'me' && ownChanged())) {
          const status = row ? row.review_status : null;
          btns.push(
            { icon: ICON_CHECK, title: 'Accept', className: 'sgm-accept', color: GREEN, tint: true,
              active: () => status === 'accepted', onClick: () => review(entry, 'accepted') },
            { icon: ICON_X, title: 'Reject', className: 'sgm-reject', color: RED, tint: true,
              active: () => status === 'rejected', onClick: () => review(entry, 'rejected') },
          );
        }
      }
      // Revert / redo: YOUR suggestion only (ownership, not review power).
      // Revert puts the committed text back; redo restores what revert
      // discarded — until you type or reopen, then it's gone.
      if (!entry || entry.kind === 'me') {
        if (ownChanged()) {
          btns.push({ icon: ICON_REVERT, className: 'sgm-revert', title: 'Revert — restore the committed text',
            color: '#2a6fb0', tint: true, onClick: () => applyRevert() });
        }
        if (redoText != null) {
          btns.push({ icon: ICON_REDO, className: 'sgm-redo', title: 'Redo the reverted edit',
            color: '#2a6fb0', tint: true,
            onClick: () => {
              textarea.value = redoText;
              redoText = null;
              pane.autoGrow();
              saver.poke();
              updateTitle();
              if (leftCtl) leftCtl.sync();
              w.refresh();
            } });
        }
      }
      return btns;
    };

    const histEntries = () => versions.map((v) => {
      // Only the CURRENT commit carries a content fingerprint — the shell's
      // NEW badge fires when the shown edit was written against DIFFERENT
      // text than this (a no-op migration keeps them equal: no badge).
      if (v.k === 0) return { key: 0, label: '0', title: 'Committed text (current) — click again to collapse', data: { ver: '0' },
        content: original };
      const prev = versions[v.k - 1].text;
      const plural = v.k > 1 ? 's' : '';
      const dis = v.text == null || v.text === prev;
      return {
        key: v.k, label: String(v.k), disabled: dis, data: { ver: String(v.k) },
        title: v.text == null ? `No record ${v.k} commits back`
          : dis ? `Unchanged ${v.k} commit${plural} ago` : `${v.k} commit${plural} ago`,
      };
    });

    const w = window.WriteSysPaneWidget.create({
      className: 'sgm-widget',
      newBadgeTitle: 'The committed text changed after this edit was written',
      headerHTML: '<span class="sn-status" title="Your edit auto-saves as you type. Closing flushes first — nothing is lost.">Suggest edit</span>',
      left: {
        rail: leftEntries,
        onSelect: (key) => { leftSel = key; showLeft(key); },
        actions: leftActions,
        title: () => {
          const entry = leftEntry();
          if (!entry || entry.kind === 'me') return 'suggested edit';
          return entry.kind === 'stale' ? `${entry.row.user_id} · stale` : entry.row.user_id;
        },
      },
      right: {
        rail: histEntries,
        onChange: (k) => showVersion(k),
        openByDefault: true,
        defaultKey: 0,
        title: (k) => k === 0 ? 'currently committed' : `${k} commit${k > 1 ? 's' : ''} ago`,
      },
      // ‹ i/n › across the manuscript's suggested edits, in book order.
      nav: {
        info: () => {
          const list = this.suggestedOrder();
          const i = list.indexOf(sentenceId);
          return { i: i >= 0 ? i + 1 : null, n: list.length };
        },
        prev: () => this._navModal(sentenceId, -1),
        next: () => this._navModal(sentenceId, +1),
      },
    });
    modal.appendChild(w.el);

    // Left pane content (caller-owned): note line + editor host; a
    // read-only view swaps in for other/stale entries.
    w.leftContent.innerHTML = `<div class="sgm-left"></div>`;
    const otherView = document.createElement('div');
    otherView.className = 'sgm-other-view';
    otherView.hidden = true;
    w.leftContent.querySelector('.sgm-left').appendChild(otherView);

    // Right pane content: the read-only text through the SHARED mono
    // editor so tabs/newlines wear the same →/↵ glyph overlay as the left
    // editor (edit-pane.js).
    const versionPane = window.WriteSysEditPane.createMonoEditor({
      value: '',
      overlayHTML: window.WriteSysEditPane.tabMarkupHTML,
    });
    versionPane.textarea.readOnly = true;
    versionPane.textarea.spellcheck = false;
    versionPane.textarea.classList.add('suggestion-modal-original', 'sgm-version-text');
    w.rightContent.appendChild(versionPane.wrap);

    // The left content area wears its review verdict as a pale wash.
    const syncReviewShade = () => {
      const host = w.leftContent.querySelector('.sgm-left');
      const entry = leftEntry();
      const row = (!entry || entry.kind === 'me') ? mineRow() : entry.row;
      host.classList.toggle('rv-accepted', !!row && row.review_status === 'accepted');
      host.classList.toggle('rv-rejected', !!row && row.review_status === 'rejected');
    };
    const showLeft = (key) => {
      const entry = leftEntries().find(e => e.key === key);
      if (entry && entry.kind !== 'me') {
        otherView.textContent = entry.row.text;
        otherView.classList.toggle('stale', entry.kind === 'stale');
      }
      // Editable (yours) reads white; read-only views keep the tan.
      const fmtEl = w.leftContent.querySelector('.sgm-fmt-left');
      if (fmtEl) fmtEl.classList.toggle('sgm-fmt-ro', !!entry && entry.kind !== 'me');
      // Entry switches land back in the formatted view.
      if (leftCtl) leftCtl.exitMono();
      syncReviewShade();
    };

    const showVersion = (k) => {
      if (k == null) return; // collapsed — the pane is hidden, nothing to render
      versionPane.textarea.value = versions[k].text || '';
      versionPane.autoGrow(); // re-mirrors the →/↵ overlay for the new value
      // Both formatted views track the shown version: the right pane paints
      // it, the left pane diffs against it.
      if (rightCtl) rightCtl.sync();
      if (leftCtl) leftCtl.sync();
    };
    showVersion(0);

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
        if (notesStack) {
          overlay.appendChild(notesStack);
          // scrollHeight is 0 on detached elements, so the build-time autosize
          // left long notes floored at min-height — re-run now that the stack
          // is in the DOM (same post-attach pass the desktop margin does).
          window.WriteSysNotes.refreshMobileNoteStack();
        }
      }
    } else {
      document.body.appendChild(modal);
    }

    // LEFT pane: the SHARED edit component (edit-pane.js) — the same
    // autosave-as-you-type, retry ladder, dirty tracking, tab overlay and
    // flush-or-refuse close that sketch widgets use.
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
        // Server collapses "text == original" into a delete; mirror locally
        // (rows too — an edit resets review/stale server-side, v3).
        this.rows = this.rows.filter(r => !(r.sentence_id === sentenceId && r.user_id === this.viewer));
        if (newText !== original) {
          this.rows.push({ sentence_id: sentenceId, user_id: this.viewer, text: newText,
            review_status: null, stale: false, updated_at: new Date().toISOString(),
            base_text: original });
        }
        this.rebuildMaps();
        syncReviewShade();
        w.refresh();
      },
      statusEl: w.saveEl,
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
    w.leftContent.querySelector('.sgm-left').insertBefore(pane.wrap, otherView);
    textarea = pane.textarea;

    // ---- Formatted ↔ mono (2026-08-23): the panes open FORMATTED, like
    // the sketch widget's preview — click drops into monospace (left
    // editable, right read-only-but-selectable), blur returns. The left
    // pane's formatted view is the red/green word diff against WHATEVER
    // version the right pane currently shows (pane-widget.formattedMono —
    // the diff source is the other pane's text).
    const leftFmt = document.createElement('div');
    leftFmt.className = 'sgm-fmt sgm-fmt-left';
    leftFmt.title = 'Click to edit';
    w.leftContent.querySelector('.sgm-left').appendChild(leftFmt);
    const rightFmt = document.createElement('div');
    rightFmt.className = 'sgm-fmt sgm-fmt-right';
    rightFmt.title = 'Click for the raw source';
    w.rightContent.appendChild(rightFmt);

    const rightTextNow = () => {
      const k = w.rightKey == null ? 0 : w.rightKey;
      return (versions[k] && versions[k].text) || '';
    };
    const dmpInst = (window.WriteSysRenderer && window.WriteSysRenderer._dmp)
      ? window.WriteSysRenderer._dmp() : null;
    // glyphizeWS paints the mono overlay's →/↵ markers over the raw
    // whitespace of an (already-escaped) HTML string — the formatted views
    // keep the suggested edit's structure visible, matching the mono form.
    const glyphizeWS = (html) => html
      .replace(/\t/g, '<span class="sd-tab"><span class="sd-g">→</span>\t</span>')
      .replace(/\n/g, '<span class="sd-nl"><span class="sd-g">↵</span></span>\n');
    const fmtRaw = (host, text) => {
      const html = glyphizeWS(escapeHTML(text));
      if (window.WriteSysScratchRender) window.WriteSysScratchRender.renderHTML(host, html);
      else host.textContent = text;
    };
    leftCtl = window.WriteSysPaneWidget.formattedMono({
      fmtEl: leftFmt,
      render: () => {
        const entry = leftEntry();
        const txt = (!entry || entry.kind === 'me') ? textarea.value : entry.row.text;
        const src = rightTextNow();
        if (txt === src) {
          fmtRaw(leftFmt, txt);
          return;
        }
        let html = renderDiffHTML(src, txt, dmpInst);
        if (window.WriteSysRenderer && window.WriteSysRenderer.renderInlineCommandsInHtml) {
          html = window.WriteSysRenderer.renderInlineCommandsInHtml(html);
        }
        // Same renderer as the plain view — one typography truth. (No
        // glyphize here: the diff pipeline renders structure via its own
        // ¶/§ markers — renderStructuralMarkers — the on-page diff idiom.)
        if (window.WriteSysScratchRender) window.WriteSysScratchRender.renderHTML(leftFmt, html);
        else leftFmt.innerHTML = html;
      },
      showMono: () => {
        const entry = leftEntry();
        const own = !entry || entry.kind === 'me';
        pane.wrap.hidden = !own;
        otherView.hidden = own;
        // Sizes measured while hidden are garbage — re-grow now visible.
        if (own) pane.autoGrow();
      },
      hideMono: () => { pane.wrap.hidden = true; otherView.hidden = true; },
      focusMono: () => {
        const entry = leftEntry();
        if (!entry || entry.kind === 'me') textarea.focus();
        else otherView.focus();
      },
    });
    rightCtl = window.WriteSysPaneWidget.formattedMono({
      fmtEl: rightFmt,
      render: () => fmtRaw(rightFmt, rightTextNow()),
      showMono: () => { versionPane.wrap.hidden = false; versionPane.autoGrow(); },
      hideMono: () => { versionPane.wrap.hidden = true; },
      focusMono: () => versionPane.textarea.focus(),
    });
    syncReviewShade();
    otherView.tabIndex = -1; // focusable, so blur can return it to formatted
    textarea.addEventListener('blur', () => leftCtl.exitMono());
    otherView.addEventListener('blur', () => leftCtl.exitMono());
    versionPane.textarea.addEventListener('blur', () => rightCtl.exitMono());

    // Title + revert-button presence + rail 0↔letter re-derive on input.
    const titleEl = modal.querySelector('.sn-status');
    const updateTitle = () => {
      titleEl.textContent = ownChanged() ? 'Suggested edit' : 'Suggest edit';
    };
    const applyRevert = () => {
      redoText = textarea.value !== original ? textarea.value : null;
      textarea.value = original;
      pane.autoGrow();
      saver.poke();
      updateTitle();
      // Reverting ends the look-closer too: formatted view, focus released,
      // ←/→ live for the tour (same as a verdict).
      textarea.blur();
      if (leftCtl) leftCtl.exitMono();
      w.refresh();
    };
    textarea.addEventListener('input', () => { redoText = null; updateTitle(); w.refresh(); });
    updateTitle();
    // When YOU have nothing here, open on the thing to look at: another
    // user's edit if one exists, else the stale one — opening on your empty
    // pane made underlined sentences read as phantoms ("underlined, but no
    // suggested edit anywhere I can see").
    if (!mineRow() && !ownChanged()) {
      if (others.length) w.selectLeft('u:' + others[0].user_id);
      else if (stale.length) w.selectLeft('st:0');
    }
    // Opened from a footnote body (renderer setupSentenceHover): land the
    // caret just inside the k-th "&footnote{" of the text being edited —
    // the note IS this sentence, so the modal is the sentence's, only the
    // caret knows which note was clicked (FOOTNOTES_PLAN.md §5).
    if (opts.caret && textarea) {
      const tok = opts.caret.token || '&footnote{';
      let at = -1;
      for (let k = 0, from = 0; k <= (opts.caret.ordinal || 0); k++) {
        at = textarea.value.indexOf(tok, from);
        if (at < 0) break;
        from = at + tok.length;
      }
      if (at >= 0) {
        const p = at + tok.length;
        setTimeout(() => {
          try {
            // Mono (raw text) mode is entered by clicking the formatted pane.
            if (leftFmt && !(leftCtl && leftCtl.isMono && leftCtl.isMono())) leftFmt.click();
            textarea.focus();
            textarea.setSelectionRange(p, p);
          } catch (e) { /* pane hidden (someone else's edit shown) — no caret */ }
        }, 0);
      }
    }
    w.refresh();

    // Closing ALWAYS flushes first; a failing save keeps the modal open with
    // the retry/stale status showing — an accidental overlay click or Escape
    // can no longer lose anything.
    const close = async () => {
      if (!(await saver.flush())) return false;
      this._activeClose = null;
      document.removeEventListener('keydown', onDocKey);
      saver.destroy();
      if (notesStack) {
        notesStack.remove();
        notesStack = null;
      }
      overlay.remove();
      modal.remove();
      const finalText = (this.bySentenceId[sentenceId] !== undefined)
        ? this.bySentenceId[sentenceId] : original;
      if (finalText === openCurrent) return true; // no net change → no re-render

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
      return true;
    };
    this._activeClose = close;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    // Escape closes from ANYWHERE while the modal is open — the formatted
    // default means focus often never enters the modal, so a modal-scoped
    // keydown would go deaf. Removed on close.
    const onDocKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      }
      // ←/→ flip through the suggested edits — only while NOT typing or
      // selecting in a pane (any focused field keeps its own arrows).
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const t = document.activeElement;
        const editing = t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable);
        if (!editing) {
          e.preventDefault();
          this._navModal(sentenceId, e.key === 'ArrowLeft' ? -1 : 1);
        }
      }
    };
    document.addEventListener('keydown', onDocKey);
    // Variation-editor keys: Tab inserts a literal \t (a "\n\t" paragraph break
    // is typeable); Shift-Tab still escapes the field.
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        pane.insertAtCaret('\t');
      }
    });

    // No autofocus: the pane opens FORMATTED (click to edit) — focusing the
    // hidden editor would fight that, and on phones it pops the keyboard.
    pane.autoGrow();
    if (restored) {
      modal.querySelector('.sn-save').textContent = 'restored unsaved draft';
      saver.poke();
    }
  },

  // Read-only viewer for a suggested-edit HISTORY event (the settings
  // page's audit table): the manuscript modal's shell (pane-widget), mono
  // editors (edit-pane) and word-diff pipeline (renderDiffHTML), fed from
  // the event's snapshots — no editing, autosave, review, or nav.
  openHistoryDialog(ev) {
    if (document.getElementById('suggestion-modal')) return;
    const overlay = document.createElement('div');
    overlay.id = 'suggestion-modal-overlay';
    const modal = document.createElement('div');
    modal.id = 'suggestion-modal';
    const color = ev.status === 'accepted' ? '#2e7d32'
      : ev.status === 'rejected' ? '#b03030' : '#c77d00'; // 'unaccepted' by a migration
    const committed = ev.committed_text || '';
    const suggested = ev.suggested_text || '';
    let leftCtl = null, rightCtl = null;

    const w = window.WriteSysPaneWidget.create({
      className: 'sgm-widget',
      headerHTML: '<span class="sn-status">Suggested edit</span>',
      left: {
        rail: () => [{ key: 'sug', label: (ev.owner_id[0] || '?').toUpperCase(),
          title: `${ev.owner_id}'s suggestion`, color }],
        title: () => `${ev.owner_id} · ${ev.status} by ${ev.reviewer_id}`,
      },
      right: {
        rail: () => [{ key: 0, label: '0', title: 'Committed text at review time — click again to collapse' }],
        onChange: () => { if (leftCtl) leftCtl.sync(); if (rightCtl) rightCtl.sync(); },
        openByDefault: true,
        defaultKey: 0,
        title: () => 'committed at review time',
      },
    });
    modal.appendChild(w.el);

    w.leftContent.innerHTML = '<div class="sgm-left"></div>';
    const leftHost = w.leftContent.querySelector('.sgm-left');
    if (ev.status === 'accepted' || ev.status === 'rejected') {
      leftHost.classList.add(ev.status === 'accepted' ? 'rv-accepted' : 'rv-rejected');
    }

    const mkMono = (value) => {
      const p = window.WriteSysEditPane.createMonoEditor({
        value, overlayHTML: window.WriteSysEditPane.tabMarkupHTML });
      p.textarea.readOnly = true;
      p.textarea.spellcheck = false;
      return p;
    };
    const leftPane = mkMono(suggested);
    leftPane.textarea.classList.add('suggestion-modal-textarea');
    leftHost.appendChild(leftPane.wrap);
    const rightPane = mkMono(committed);
    rightPane.textarea.classList.add('suggestion-modal-original', 'sgm-version-text');
    w.rightContent.appendChild(rightPane.wrap);

    const leftFmt = document.createElement('div');
    leftFmt.className = 'sgm-fmt sgm-fmt-left sgm-fmt-ro';
    leftFmt.title = 'Click for the raw source';
    leftHost.appendChild(leftFmt);
    const rightFmt = document.createElement('div');
    rightFmt.className = 'sgm-fmt sgm-fmt-right';
    rightFmt.title = 'Click for the raw source';
    w.rightContent.appendChild(rightFmt);

    const dmp = (typeof diff_match_patch !== 'undefined') ? new diff_match_patch() : null;
    const paint = (host, html) => {
      if (window.WriteSysScratchRender) window.WriteSysScratchRender.renderHTML(host, html);
      else host.innerHTML = html;
    };
    leftCtl = window.WriteSysPaneWidget.formattedMono({
      fmtEl: leftFmt,
      render: () => paint(leftFmt, suggested === committed
        ? escapeHTML(suggested)
        : renderDiffHTML(committed, suggested, dmp)),
      showMono: () => { leftPane.wrap.hidden = false; leftPane.autoGrow(); },
      hideMono: () => { leftPane.wrap.hidden = true; },
      focusMono: () => leftPane.textarea.focus(),
    });
    rightCtl = window.WriteSysPaneWidget.formattedMono({
      fmtEl: rightFmt,
      render: () => paint(rightFmt, escapeHTML(committed)),
      showMono: () => { rightPane.wrap.hidden = false; rightPane.autoGrow(); },
      hideMono: () => { rightPane.wrap.hidden = true; },
      focusMono: () => rightPane.textarea.focus(),
    });
    leftPane.textarea.addEventListener('blur', () => leftCtl.exitMono());
    rightPane.textarea.addEventListener('blur', () => rightCtl.exitMono());

    document.body.appendChild(overlay);
    document.body.appendChild(modal);
    const close = () => {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      modal.remove();
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    w.refresh();
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
// ---- Footnotes in diffs (FOOTNOTES_PLAN.md §6) ----------------------------
// Each &footnote{…} on either side is lifted out into a private-use
// placeholder char (its own diff token — see the tokeniser) so the prose
// diff treats the note as one unit; the notes are then diffed SEPARATELY,
// index-paired in order, and put back as .fn-body spans (Paged floats them
// into the footnote area; the renderer stamps the host sentence id): an
// unchanged note plain, a changed one with its own green/red words inside,
// a note only on the new side green, only on the old side red-struck
// (fn-removed).
const FN_PLACEHOLDER = '\uE000';
function liftFootnotes(text) {
  const lib = window.WriteSysCommand;
  const notes = [];
  const s = String(text == null ? '' : text);
  if (!lib || s.indexOf('&footnote') < 0) return { text: s, notes };
  const chars = Array.from(s);
  let out = '';
  let i = 0;
  while (i < chars.length) {
    if (chars[i] === '&') {
      const cmd = lib.parse(chars.slice(i).join(''));
      if (cmd && cmd.kind === 'footnote') {
        notes.push((cmd.args || []).join(''));
        out += FN_PLACEHOLDER;
        i += Array.from(cmd.raw).length;
        continue;
      }
    }
    out += chars[i];
    i++;
  }
  return { text: out, notes };
}
function renderDiffHTML(oldText, newText, dmp) {
  const o = liftFootnotes(oldText);
  const n = liftFootnotes(newText);
  const html = renderDiffHTMLCore(o.text, n.text, dmp);
  if (!o.notes.length && !n.notes.length) return html;
  const emph = (t) => (window.WriteSysRenderer && window.WriteSysRenderer.emphasize)
    ? window.WriteSysRenderer.emphasize(escapeHTML(t)) : escapeHTML(t);
  const removed = (t) => `<span class="fn-body fn-removed"><del>${emph(t == null ? '' : t)}</del></span>`;
  const added = (t) => `<span class="fn-body"><strong>${emph(t == null ? '' : t)}</strong></span>`;
  let oi = 0;
  let ni = 0;
  let inDel = false;
  let inIns = false;
  let out = '';
  let pos = 0;
  const re = /<\/?del>|<\/?strong>|\uE000/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    out += html.slice(pos, m.index);
    pos = m.index + m[0].length;
    const t = m[0];
    if (t === '<del>') { inDel = true; out += t; continue; }
    if (t === '</del>') { inDel = false; out += t; continue; }
    if (t === '<strong>') { inIns = true; out += t; continue; }
    if (t === '</strong>') { inIns = false; out += t; continue; }
    if (inDel) { out += removed(o.notes[oi++]); continue; }
    if (inIns) { out += added(n.notes[ni++]); continue; }
    const old = o.notes[oi++];
    const nw = n.notes[ni++];
    if (nw == null) out += removed(old);
    else if (old == null) out += added(nw);
    else if (old === nw) out += `<span class="fn-body">${emph(nw)}</span>`;
    else out += `<span class="fn-body">${renderDiffHTMLCore(old, nw, dmp)}</span>`;
  }
  out += html.slice(pos);
  return out;
}

function renderDiffHTMLCore(oldText, newText, dmp) {
  if (!dmp) return `<strong>${formatFallbackHTML(newText)}</strong>`;

  // ---- &fix{…} CONTENT-level diffing (a deliberately weird feature) ----
  // Wrapping prose in &fix must NOT read as "old words struck red, same
  // words repeated purple." The rule (owner-specified, 2026-09-07):
  //   * The diff runs on WRAPPER-STRIPPED text — &fix{X} diffs as X — so
  //     the word diff compares content against content.
  //   * Unchanged words inside a fix region render BOLD PURPLE (the fix
  //     look). Added words stay GREEN, removed words stay RED-STRUCK —
  //     diff coloring overrides the purple. No word changes → all purple.
  //   * The WRAPPER's own add/remove is a diamond: PURPLE ◆ where a fix
  //     was added, RED ◆ where one was removed — and after a removal the
  //     surviving words default to normal black (no purple).
  // Mechanics: strip &fix wrappers from both sides, remembering each
  // region's [start,end) in the STRIPPED text. Diff the stripped texts.
  // During assembly, track the old-side and new-side character positions;
  // EQUAL chunks covered by a new-side region emit inside .cmd-fix.
  // Wrapper delta is INDEX-paired (region i ↔ region i): extra new
  // regions are "added" (purple ◆ at their start), extra old regions are
  // "removed" (red ◆). Equal counts = persistent wrappers, no diamonds —
  // a simultaneous remove-one-add-another reads as persistent; accepted.
  // The wholesale-rewrite path below diffs/renders the stripped text too,
  // so a full rewrite shows plain green/red without fix styling; also
  // accepted — everything there is new anyway.
  const stripFix = (text) => {
    const chars = Array.from(String(text));
    const regions = [];
    let out = '';
    let i = 0;
    const lib = window.WriteSysCommand;
    while (i < chars.length) {
      if (chars[i] === '&' && lib) {
        const cmd = lib.parse(chars.slice(i).join(''));
        if (cmd && cmd.kind === 'fix') {
          const content = (cmd.args || []).join('');
          regions.push({ start: out.length, end: out.length + content.length });
          out += content;
          i += Array.from(cmd.raw).length;
          continue;
        }
      }
      out += chars[i];
      i++;
    }
    return { text: out, regions };
  };
  const oldF = stripFix(oldText);
  const newF = stripFix(newText);
  const fixAdded = newF.regions.slice(oldF.regions.length);
  const fixRemoved = oldF.regions.slice(newF.regions.length);
  oldText = oldF.text;
  newText = newF.text;

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

  // WHOLESALE REWRITE: when little text survives (EQ share under 40%),
  // the interleaved word diff reads as noise — a rewritten block (e.g. a
  // placed sketch region) renders as ONE solid strike + ONE solid green
  // block instead, so "replaced entirely" looks replaced entirely.
  // BUT only when a substantial share of the OLD text was actually
  // deleted: a pure extension (splitting one sentence into two, appending
  // a clause) keeps the old text intact — striking it and repeating it in
  // green would misread as a rewrite when only the addition is new.
  const eqChars = segs.reduce((n, sg) => n + (sg[0] === 0 ? sg[1].length : 0), 0);
  const delChars = segs.reduce((n, sg) => n + (sg[0] === -1 ? sg[1].length : 0), 0);
  const maxLen = Math.max(oldText.length, newText.length);
  if (maxLen > 60 && eqChars / maxLen < 0.4
      && oldText.length > 0 && delChars / oldText.length > 0.4) {
    return renderStructuralMarkers(pairItalicsAcrossInserts(
      (oldText ? `<del>${escapeHTML(oldText)}</del>` : '')
      + (newText ? `<strong>${escapeHTML(newText)}</strong>` : '')));
  }

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
  // Side-position tracking for the &fix machinery: EQUAL advances both
  // sides, a del/ins cluster advances old/new by its del/ins lengths.
  // (The whitespace-coalescing pass above DUPLICATES an absorbed EQ run
  // into both the del and the ins — which is exactly what keeps both
  // counters honest.) Diamonds flush at part boundaries once the side
  // position passes a region start — ±a cluster of precision, plenty.
  let oldPos = 0;
  let newPos = 0;
  const FIX_DIAMOND = (cls) => `<span class="cmd-diamond ${cls}" title="fix">`
    + '<svg width="9" height="13" viewBox="0 0 9 13" aria-hidden="true">'
    + '<path fill="currentColor" d="M4.5 0 9 6.5 4.5 13 0 6.5z"/></svg></span>';
  const emittedD = new Set();
  // Cluster-boundary fallback for diamonds whose region start never lands
  // inside an EQUAL segment (e.g. the wrapped content was itself all-new).
  const flushDiamonds = () => {
    for (const r of fixAdded) {
      if (!emittedD.has(r) && r.start <= newPos) { parts.push(FIX_DIAMOND('cmd-diamond-fixadd')); emittedD.add(r); }
    }
    for (const r of fixRemoved) {
      if (!emittedD.has(r) && r.start <= oldPos) { parts.push(FIX_DIAMOND('cmd-diamond-fixrem')); emittedD.add(r); }
    }
  };
  // EQUAL text carries BOTH sides' positions, so it's where diamonds land
  // exactly and where purple applies: chunks covered by a new-side region
  // emit inside .cmd-fix; add/remove diamonds weave in at their precise
  // region-start offsets (new-side for adds, old-side for removes).
  const emitEqual = (text) => {
    const nb = newPos;
    const ob = oldPos;
    const L = text.length;
    const marks = [];
    for (const r of fixAdded) {
      if (!emittedD.has(r) && r.start >= nb && r.start <= nb + L) {
        marks.push([r.start - nb, FIX_DIAMOND('cmd-diamond-fixadd')]);
        emittedD.add(r);
      }
    }
    for (const r of fixRemoved) {
      if (!emittedD.has(r) && r.start >= ob && r.start <= ob + L) {
        marks.push([r.start - ob, FIX_DIAMOND('cmd-diamond-fixrem')]);
        emittedD.add(r);
      }
    }
    marks.sort((x, y) => x[0] - y[0]);
    let out = '';
    let p = 0;
    const upTo = (q) => {
      while (p < q) {
        let coverEnd = null;
        for (const r of newF.regions) {
          const s = r.start - nb;
          const e = r.end - nb;
          if (p >= s && p < e) { coverEnd = Math.min(e, q); break; }
        }
        if (coverEnd !== null) {
          out += `<span class="cmd-fix">${escapeHTML(text.slice(p, coverEnd))}</span>`;
          p = coverEnd;
          continue;
        }
        let next = q;
        for (const r of newF.regions) {
          const s = r.start - nb;
          if (s > p && s < next) next = s;
        }
        out += escapeHTML(text.slice(p, next));
        p = next;
      }
    };
    for (const m of marks) { upTo(Math.max(0, Math.min(m[0], L))); out += m[1]; }
    upTo(L);
    return out;
  };
  let i = 0;
  while (i < segs.length) {
    if (segs[i][0] === 0) {
      flushDiamonds();
      parts.push(emitEqual(segs[i][1]));
      oldPos += segs[i][1].length;
      newPos += segs[i][1].length;
      i++;
      continue;
    }
    let dels = '', inses = '';
    while (i < segs.length && segs[i][0] !== 0) {
      if (segs[i][0] === -1) dels += segs[i][1];
      else if (segs[i][0] === 1) inses += segs[i][1];
      i++;
    }
    flushDiamonds();
    oldPos += dels.length;
    newPos += inses.length;
    // A change that is ONLY emphasis markers (e.g. a moved `*`) reads as
    // noise at full weight — tag it so CSS can render it subdued.
    const mdOnly = (t) => /^[\s*_]+$/.test(t) && /[*_]/.test(t);
    // REFINEMENT: when a cluster's del and ins differ ONLY by emphasis
    // markers ("was*—the" → "was—the"), the words themselves didn't change —
    // don't strike them. Char-diff the cluster so the words emit as plain
    // text and only the markers carry (subdued) del/ins styling.
    if (dels && inses && dels !== inses
        && dels.replace(/[*_]/g, '') === inses.replace(/[*_]/g, '')) {
      const sub = dmp.diff_main(dels, inses);
      let ok = true, out = '';
      for (let k = 0; k < sub.length; k++) {
        const op = sub[k][0], t = sub[k][1];
        if (op === 0) out += escapeHTML(t);
        else if (!/^[\s*_]+$/.test(t)) { ok = false; break; }
        else out += op === -1
          ? `<del class="md-marker">${escapeHTML(t)}</del>`
          : `<strong class="md-marker">${escapeHTML(t)}</strong>`;
      }
      if (ok) { parts.push(out); continue; }
    }
    if (dels) parts.push(`<del${mdOnly(dels) ? ' class="md-marker"' : ''}>${escapeHTML(dels)}</del>`);
    if (inses) parts.push(`<strong${mdOnly(inses) ? ' class="md-marker"' : ''}>${escapeHTML(inses)}</strong>`);
  }
  newPos = Infinity;
  oldPos = Infinity;
  flushDiamonds(); // trailing regions (a fix at the very end of the text)
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
      const isSection = html[i + 1] === '\n';
      const glyph = isSection ? SECTION_GLYPH : PARAGRAPH_GLYPH;
      const isEq = !inDel && !inStrong;
      if (leading && isEq) {
        // Pre-existing marker at sentence start — drop entirely.
      } else if (leading || inDel) {
        out += `<span class="suggested-marker">${glyph}</span>`;
      } else {
        // Only a ¶ (\n\t) indents — a section's first paragraph starts
        // flush BUT with the section's blank-line gap (double spacing),
        // matching the book's own convention.
        const tail = isSection ? '<br>' : '<span class="suggested-pindent">\u00a0\u00a0\u00a0\u00a0</span>';
        out += `<span class="suggested-marker">${glyph}</span><br>${tail}`;
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
  // Each records whether it sits inside a <strong> (an INSERTED marker) and
  // WHICH <strong> (seg): a pair living in the SAME insert means the whole
  // *word* is new prose — the green italics alone carry the change, so the
  // syntax chars hide, same as committed rendering. Markers in DIFFERENT
  // inserts wrap pre-existing text — the italicization itself IS the edit
  // (non-italic → italic), so those stay VISIBLE green. Pre-existing (EQ)
  // markers swap into pure <em> as always.
  const stars = [];
  const scores = []; // underscore positions — pair only with underscores
  let inDel = false;
  let inStrong = false;
  let inTag = false;
  let seg = 0; // <strong> counter — same seg = same inserted run
  for (let i = 0; i < html.length; i++) {
    const c = html[i];
    if (c === '<') {
      inTag = true;
      // Detect <del ...> open and </del> close.
      if (html.startsWith('<del', i)) inDel = true;
      else if (html.startsWith('</del>', i)) inDel = false;
      else if (html.startsWith('<strong', i)) { inStrong = true; seg++; }
      else if (html.startsWith('</strong>', i)) inStrong = false;
      continue;
    }
    if (inTag) {
      if (c === '>') inTag = false;
      continue;
    }
    if (c === '*' && !inDel) stars.push({ i, ins: inStrong, seg: inStrong ? seg : 0 });
    if (c === '_' && !inDel) {
      // Underscore emphasis is never intraword: require a non-word char (or
      // edge/tag boundary) on at least the OUTER side of the would-be pair.
      const prev = html[i - 1], next = html[i + 1];
      const w = (ch) => ch !== undefined && /\w/.test(ch) && ch !== '_';
      if (!(w(prev) && w(next))) scores.push({ i, ins: inStrong, seg: inStrong ? seg : 0 });
    }
  }
  // Pair greedily: 0+1, 2+3, etc. Replace from the right so earlier
  // indices stay valid.
  const pairs = [];
  for (let i = 0; i + 1 < stars.length; i += 2) {
    pairs.push([stars[i], stars[i + 1]]);
  }
  for (let i = 0; i + 1 < scores.length; i += 2) {
    pairs.push([scores[i], scores[i + 1]]);
  }
  // Crossing/nested star-vs-underscore pairs would corrupt the index math
  // of the right-to-left replacement below — keep only non-overlapping
  // pairs, earliest-start wins.
  pairs.sort((a, b) => a[0].i - b[0].i);
  let lastEnd = -1;
  for (let i = 0; i < pairs.length; i++) {
    if (pairs[i][0].i <= lastEnd) { pairs.splice(i, 1); i--; continue; }
    lastEnd = pairs[i][1].i;
  }
  for (let p = pairs.length - 1; p >= 0; p--) {
    const [a, b] = pairs[p];
    // A pair inside the SAME <strong>: the whole *word* is inserted prose —
    // hide the syntax, the green italics say it all. A marker inserted
    // AROUND existing text (pair straddles inserts): KEEP the character so
    // the italicization change shows green. Pre-existing marker: swap it
    // for the tag.
    const wholeInsert = a.ins && b.ins && a.seg === b.seg;
    const closeRep = (b.ins && !wholeInsert) ? '</em>' + html[b.i] : '</em>';
    const openRep = (a.ins && !wholeInsert) ? html[a.i] + '<em>' : '<em>';
    html = html.slice(0, a.i) + openRep + html.slice(a.i + 1, b.i) + closeRep + html.slice(b.i + 1);
  }
  // A pairing that consumed a marker living alone inside an md-marker
  // wrapper leaves the wrapper holding only the inserted <em>/</em> tag —
  // hoist the tag out and drop the husk.
  html = html.replace(/<(del|strong) class="md-marker">\s*(<\/?em>)\s*<\/\1>/g, '$2');
  html = html.replace(/<(del|strong) class="md-marker">\s*<\/\1>/g, '');
  return html;
}

// Used only by the no-d-m-p fallback path of renderDiffHTML. NOT the same
// as renderer.js applyInlineFormatting — that one also renders inline
// &-commands; this is a bare escape + *italics* pass, so it keeps a
// distinct name. The main diff path escapes per-segment and then runs
// pairItalicsAcrossInserts on the joined HTML to handle cross-insert
// italic pairs.
function formatFallbackHTML(text) {
  return escapeHTML(text)
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/(^|[^\w])_([^_]+)_(?=[^\w]|$)/g, '$1<em>$2</em>');
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
      // A whole &-COMMAND is ONE atomic token: word-splitting a multi-word
      // command (&fix{like an echo…} wrapped around existing prose) used to
      // straddle it across diff segments, so no later pass could recognize
      // it — the literal leaked into the rendered diff.
      // A lifted footnote (renderDiffHTML: U+E000) is ALWAYS its own token,
      // so removing a note never drags its host word into the diff.
      const re = /\s+|\uE000|[^\s\uE000]+/g;
      const cmdLib = window.WriteSysCommand;
      let m;
      while ((m = re.exec(text)) !== null) {
        let token = m[0];
        if (cmdLib && token[0] === '&') {
          const cmd = cmdLib.parse(text.slice(m.index));
          if (cmd && cmd.raw.length > token.length) {
            token = cmd.raw;
            re.lastIndex = m.index + token.length;
          }
        }
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
