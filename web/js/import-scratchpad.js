/**
 * Book-side Canonize (VARIATIONS_PLAN.md): a + rule between paragraphs
 * (and a "Fill" affordance on placeholders) that dubs a snippet VARIATION
 * canon — ONE suggested edit wrapping its text in
 * &sketch#<sketch-id>{label} … &end#<sketch-id> (formerly &snippet# — the
 * legacy spelling parses forever; new placements write &sketch#).
 *
 * Step 1 is the ordinary suggestion PUT (stale-migration guard included);
 * step 2 is POST /api/variations/{id}/canonize which creates the hidden
 * canon variation (immutable snapshot) and pins the group's link. Import
 * targets must be committed sentences with no pending suggestion.
 */
const WriteSysImportScratchpad = {
  csrf() { return (localStorage.getItem('csrf_token') || sessionStorage.getItem('csrf_token')) || ''; },

  // ---------------------------------------------------------- affordances

  // refresh (re)builds the hover affordances. Runs after pagination, same
  // hook family as the rainbow bars.
  refresh() {
    this.bindProximity();
    document.querySelectorAll('.import-zone, .ph-fill-btn').forEach(el => el.remove());
    const r = window.WriteSysRenderer;
    if (!r || !r.currentMigrationID) return;
    const sug = (window.WriteSysSuggestions && window.WriteSysSuggestions.bySentenceId) || {};

    // Affordances are anchored INSIDE their own paragraph (position:relative
    // host), so they ride reflows and transforms with no coordinate math.
    document.querySelectorAll('.pagedjs_page').forEach(page => {
      const pageArea = page.querySelector('.pagedjs_page_content');
      if (!pageArea) return;

      // + rule between paragraphs: a gap ABOVE each paragraph whose previous
      // sibling ends in a committed, suggestion-free sentence.
      pageArea.querySelectorAll('p').forEach(p => {
        const prev = p.previousElementSibling;
        if (!prev) return;
        const prevSpans = prev.querySelectorAll('.sentence[data-sentence-id]');
        if (prevSpans.length === 0) return;
        const boundaryId = prevSpans[prevSpans.length - 1].dataset.sentenceId;
        // A pending suggestion on the boundary is fine: canonize COMPOSES the
        // region onto it (one suggestion carries both; they push together).
        if (!r.sentenceMap[boundaryId]) return;    // not a committed sentence
        // The zone itself never intercepts pointer events (it overlays prose
        // when paragraphs have no gap) — only the small left-margin + tab is
        // clickable; hovering it reveals the insertion rule.
        // ANCHORED INSIDE THE PARAGRAPH (position:relative host): late
        // reflows — webfont swaps, image loads — used to leave absolutely
        // positioned zones stranded half a page above their gaps.
        const zone = document.createElement('div');
        zone.className = 'import-zone';
        zone.dataset.sentenceId = boundaryId;
        // -5px: vertically centred in the GAP — -9 hugged the descenders
        // (g/y) of the line above and floated far from the next line's caps.
        zone.style.top = '-5px';
        zone.innerHTML = '<button type="button" class="import-tab" title="Place a sketch here (from a scratchpad)">+</button><span class="import-rule"></span>';
        zone.querySelector('.import-tab').addEventListener('click', (e) => {
          e.stopPropagation();
          this.openModal({ mode: 'append', sentenceId: boundaryId });
        });
        if (getComputedStyle(p).position === 'static') p.style.position = 'relative';
        p.appendChild(zone);
      });

      // Placeholder fill: replace a committed &placeholder (block or own-line
      // sentences form) with the region, inheriting its slug.
      pageArea.querySelectorAll('.cmd-placeholder[data-slug], p.ph-line .ph[data-slug]').forEach(el => {
        const holder = el.classList.contains('ph') ? el.closest('p') : el;
        const span = holder.querySelector('.sentence[data-sentence-id]');
        if (!span) return;
        const sentenceId = span.dataset.sentenceId;
        if (sug[sentenceId] !== undefined) return;
        if (!r.sentenceMap[sentenceId]) return;
        const slug = el.dataset.slug;
        if (!slug) return;
        // Left-margin button too — never over the prose.
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ph-fill-btn';
        btn.textContent = '⧉';
        btn.title = `Fill placeholder #${slug} by placing a sketch`;
        btn.style.top = '2px';
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.openModal({ mode: 'replace', sentenceId, slug });
        });
        if (getComputedStyle(holder).position === 'static') holder.style.position = 'relative';
        holder.appendChild(btn);
      });
    });
  },

  // PROXIMITY reveal: exactly ONE + at a time — the gap whose vertical
  // position is nearest the pointer, and only within a tight band. (The old
  // per-paragraph hover lit BOTH gaps around the hovered paragraph.)
  HOT_BAND_PX: 26,
  bindProximity() {
    if (this._proximityBound) return;
    this._proximityBound = true;
    // SYNCHRONOUS on purpose: an earlier version deferred through
    // requestAnimationFrame with a skip-while-pending latch — when rAF stalls
    // (Firefox/Wayland does this on real windows while headless sails), the
    // latch never clears and every move is skipped. A timestamp throttle
    // cannot wedge. Capture phase so vendor stopPropagation can't starve it.
    let lastRun = 0;
    document.addEventListener('mousemove', (e) => {
      const now = performance.now();
      if (now - lastRun < 33) return;
      lastRun = now;
      const x = e.clientX, y = e.clientY;
      let best = null, bestD = Infinity;
      document.querySelectorAll('.import-zone').forEach((z) => {
        const r = z.getBoundingClientRect();
        if (!r.width && !r.height) return;                 // detached remnant
        if (x < r.left - 80 || x > r.right + 80) return;   // way off the column
        const d = Math.abs(y - (r.top + r.height / 2));
        if (d < bestD) { bestD = d; best = z; }
      });
      document.querySelectorAll('.import-zone.import-hot').forEach((z) => {
        if (z !== best || bestD > this.HOT_BAND_PX) z.classList.remove('import-hot');
      });
      if (best && bestD <= this.HOT_BAND_PX) best.classList.add('import-hot');
    }, true);
  },

  // --------------------------------------------------------------- modal

  async openModal(target) {
    this.closeModal();
    this.target = target;
    const overlay = document.createElement('div');
    overlay.id = 'import-modal-overlay';
    overlay.innerHTML = `
      <div id="import-modal" role="dialog" aria-label="place a sketch variation">
        <h3>place a sketch variation</h3>
        <p class="im-hint">${target.mode === 'replace'
          ? `Replaces placeholder <code>#${this.esc(target.slug)}</code> with the variation's text, wrapped in <code>&amp;sketch#id{label}</code> … <code>&amp;end#id</code>, as one suggested edit. (The placeholder's own slug retires.)`
          : 'Inserts the variation\'s text after this paragraph, wrapped in <code>&amp;sketch#id{label}</code> … <code>&amp;end#id</code>, as one suggested edit.'}</p>
        <input type="text" id="im-q" placeholder="Search variations…" autocomplete="off">
        <div id="im-blocks" class="im-blocks"><span class="im-muted">Loading variations…</span></div>
        <div class="im-row">
          <label>Label (outline) <input id="im-label" type="text" placeholder="optional"></label>
        </div>
        <div class="im-error" id="im-error" hidden></div>
        <div class="im-actions">
          <button type="button" id="im-cancel">Never mind</button>
          <button type="button" id="im-go" disabled>Place</button>
        </div>
      </div>`;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) this.closeModal(); });
    document.body.appendChild(overlay);
    document.getElementById('im-cancel').addEventListener('click', () => this.closeModal());
    document.getElementById('im-go').addEventListener('click', () => this.canonize());
    let t = null;
    document.getElementById('im-q').addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => this.loadVariations(), 250);
    });
    await this.loadVariations();
  },

  closeModal() {
    const el = document.getElementById('import-modal-overlay');
    if (el) el.remove();
    this.selectedVariation = null;
  },

  showError(msg) {
    const el = document.getElementById('im-error');
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
  },

  async loadVariations() {
    this.selectedVariation = null;
    const goBtn = document.getElementById('im-go');
    if (goBtn) goBtn.disabled = true;
    const holder = document.getElementById('im-blocks');
    if (!holder) return;
    const q = (document.getElementById('im-q') || { value: '' }).value.trim();
    try {
      const data = await fetchJSON(`api/variations?q=${encodeURIComponent(q)}`, {}, false);
      const rows = (data.variations || []).filter(v => (v.preview || '').trim());
      if (rows.length === 0) {
        holder.innerHTML = '<span class="im-muted">No variations with text yet — write in a sketch widget first.</span>';
        return;
      }
      // Ineligible: already-canonized groups, and groups linked elsewhere.
      const curManuscript = (window.WriteSysRenderer && window.WriteSysRenderer.manuscriptId) || 0;
      const letter = (n) => String.fromCharCode(64 + n);
      holder.innerHTML = rows.map((v, i) => {
        const blockedWhy = v.canonized ? 'already placed (re-place from its widget)'
          : (v.linked_manuscript_id && v.linked_manuscript_id !== curManuscript
            ? `linked to ${this.esc(v.linked_manuscript_name || 'another manuscript')}` : '');
        return `
        <label class="im-block"${blockedWhy ? ' style="opacity:.55"' : ''}><input type="radio" name="im-block" value="${i}"${blockedWhy ? ' disabled' : ''}>
          <span class="im-block-letter">${letter(v.ordinal)}</span>
          <span class="im-block-text">${this.esc((v.preview || '').slice(0, 120))}${(v.preview || '').length > 120 ? '…' : ''}${blockedWhy ? ` <span class="im-muted">(${blockedWhy})</span>` : ''}</span>
        </label>`;
      }).join('');
      holder.querySelectorAll('input[name="im-block"]').forEach(inp => {
        inp.addEventListener('change', () => {
          this.selectedVariation = rows[parseInt(inp.value, 10)];
          document.getElementById('im-go').disabled = false;
        });
      });
    } catch (e) {
      this.showError('Failed to list variations: ' + e.message);
    }
  },

  async canonize() {
    const r = window.WriteSysRenderer;
    const cmdLib = window.WriteSysCommand;
    const sel = this.selectedVariation;
    const target = this.target;
    if (!sel || !target) return;
    const label = document.getElementById('im-label').value.trim();
    const slug = sel.sketch_id; // the region slug IS the global sketch ID

    // Fresh full text + eligibility straight from the source of truth.
    let ctx;
    try {
      ctx = await fetchJSON(`api/variations/${sel.variation_id}`, {}, false);
    } catch (e) {
      return this.showError('Could not load the variation: ' + e.message);
    }
    if (ctx.sketch.canon_variation_id) {
      return this.showError('This sketch already has a canon variation.');
    }
    if (ctx.sketch.linked_manuscript_id && ctx.sketch.linked_manuscript_id !== r.manuscriptId) {
      return this.showError(`This sketch is linked to ${ctx.sketch.linked_manuscript_name || 'another manuscript'}.`);
    }
    // Paranoia: the globally-unique ID should never collide with anything
    // already in the effective manuscript.
    const sug = (window.WriteSysSuggestions && window.WriteSysSuggestions.bySentenceId) || {};
    const canon = window.WriteSysCanonicalize ? window.WriteSysCanonicalize.canonicalize : null;
    const taken = window.WriteSysRegion.effectiveSlugs(r.currentSentences, sug, cmdLib, canon);
    if (taken.has(slug)) {
      return this.showError(`Sketch #${slug} already appears in this manuscript.`);
    }

    const committed = r.sentenceMap[target.sentenceId] || '';
    // Compose onto a pending suggestion when one exists — the user's prose
    // edit and the canon region ride ONE suggestion (pushed/reverted
    // together). No ambiguity: the region always goes AFTER the boundary
    // sentence's current (effective) text.
    const pending = (window.WriteSysSuggestions && window.WriteSysSuggestions.bySentenceId) || {};
    const base = pending[target.sentenceId] !== undefined ? pending[target.sentenceId] : committed;
    const content = ctx.variation.text.replace(/\s+$/, '');
    const openLine = `&sketch#${slug}{${label}}`;
    const endLine = `&end#${slug}`;
    // Tight structure: single \n around the region markers so the canonized
    // text reads as a REGULAR paragraph continuing the flow — the \t makes it
    // an indented paragraph (upgrade to \n\n by hand for a section break).
    // Anchors render in the left margin, &end renders not at all, so none of
    // this interrupts the prose.
    let suggested;
    if (target.mode === 'replace') {
      // Replace the placeholder command, keep its structural marker.
      const marker = r.leadingMarker(committed);
      suggested = `${marker}${openLine}\n\t${content}\n${endLine}`;
    } else {
      suggested = `${base.replace(/\s+$/, '')}\n${openLine}\n\t${content}\n${endLine}`;
    }

    const go = document.getElementById('im-go');
    go.disabled = true;
    go.textContent = 'Canonizing…';
    try {
      // Step 1: the suggestion (existing endpoint: validation, CSRF, stale
      // guard). Step 2: dub the variation canon (snapshot + group pointer).
      const put = await fetch(`api/sentences/${encodeURIComponent(target.sentenceId)}/suggestion`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrf() },
        body: JSON.stringify({ text: suggested }),
      });
      if (put.status === 409) throw new Error('The manuscript changed under you — reload the page and retry.');
      if (!put.ok) throw new Error(`suggestion rejected (${put.status}): ${(await put.text()).slice(0, 200)}`);

      const can = await fetch(`api/variations/${sel.variation_id}/canonize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrf() },
        body: JSON.stringify({ manuscript_id: r.manuscriptId }),
      });
      if (!can.ok) {
        throw new Error(`Suggestion saved, but dubbing the variation canon failed (${(await can.text()).slice(0, 200)}). ` +
          'Delete the suggestion or retry canonize from a fresh modal.');
      }

      // Now that this snippet is canonized, offer to freeze all its variations
      // (they're no longer a work-in-progress). Individual ones can be
      // unfrozen later. Best-effort — a failure here doesn't undo the canonize.
      if (window.confirm('Freeze all variations? (You can unfreeze select ones individually.)')) {
        try {
          await fetch(`api/sketches/${encodeURIComponent(slug)}/freeze-all`, {
            method: 'POST', headers: { 'X-CSRF-Token': this.csrf() },
          });
        } catch (e) { /* non-fatal */ }
      }

      // The canonize suggestion is now the truth for this sentence — a stale
      // suggest-edit draft (crash leftover) must not auto-restore over it.
      try { localStorage.removeItem(`ms-draft-suggest-${target.sentenceId}`); } catch (e) { /* non-fatal */ }

      if (window.WriteSysSuggestions) await window.WriteSysSuggestions.loadForMigration(r.currentMigrationID);
      this.closeModal();
      await r.renderManuscript({ anchorSentenceId: target.sentenceId, selectSentenceId: target.sentenceId });
    } catch (e) {
      this.showError(e.message);
      go.disabled = false;
      go.textContent = 'Canonize';
    }
  },

  // --------------------------------------------------------- deep linking

  // index.html?manuscript_id=N#slug scrolls to the slug's sentence once the
  // outline has resolved it (used by the widget's "Open in book").
  initHashScroll() {
    const slug = decodeURIComponent((window.location.hash || '').slice(1));
    if (!slug) return;
    let tries = 0;
    const tick = () => {
      const map = (window.WriteSysOutline && window.WriteSysOutline.slugMap) || {};
      if (map[slug] && document.querySelector(`.sentence[data-sentence-id="${CSS.escape(map[slug])}"]`)) {
        window.WriteSysRenderer.scrollToSentence(map[slug]);
        return;
      }
      if (++tries < 40) setTimeout(tick, 500);
    };
    setTimeout(tick, 800);
  },

  esc(t) {
    return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },
};

if (typeof window !== 'undefined') {
  window.WriteSysImportScratchpad = WriteSysImportScratchpad;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => WriteSysImportScratchpad.initHashScroll());
  } else {
    WriteSysImportScratchpad.initHashScroll();
  }
}
