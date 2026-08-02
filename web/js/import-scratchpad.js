/**
 * Book-side Canonize (VARIATIONS_PLAN.md): a + rule between paragraphs
 * (and a "Fill" affordance on placeholders) that dubs a snippet VARIATION
 * canon — ONE suggested edit wrapping its text in
 * &snippet#<snippet-id>{label} … &end#<snippet-id>.
 *
 * Step 1 is the ordinary suggestion PUT (stale-migration guard included);
 * step 2 is POST /api/sketches/{id}/canonize which creates the hidden
 * canon sketch (immutable snapshot) and pins the group's link. Import
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

    // The page may be transform-scaled on mobile. getBoundingClientRect() is
    // SCREEN px, but these affordances are appended INTO pageArea and positioned
    // in its own (unscaled) coord space — so convert screen deltas by ÷scale, or
    // they land at the wrong height / on the wrong page. 1 on desktop.
    const scale = (window.WriteSysPlaceholder && window.WriteSysPlaceholder.pageScale)
      ? window.WriteSysPlaceholder.pageScale() : 1;

    document.querySelectorAll('.pagedjs_page').forEach(page => {
      const pageArea = page.querySelector('.pagedjs_page_content');
      if (!pageArea) return;
      const pageRect = pageArea.getBoundingClientRect();

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
        const rect = p.getBoundingClientRect();
        const zone = document.createElement('div');
        zone.className = 'import-zone';
        zone.dataset.sentenceId = boundaryId;
        zone.style.top = `${Math.max(0, (rect.top - pageRect.top) / scale - 9)}px`;
        zone.innerHTML = '<button type="button" class="import-tab" title="Import from scratchpad (canonize)">+</button><span class="import-rule"></span>';
        zone.querySelector('.import-tab').addEventListener('click', (e) => {
          e.stopPropagation();
          this.openModal({ mode: 'append', sentenceId: boundaryId });
        });
        pageArea.appendChild(zone);
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
        const rect = holder.getBoundingClientRect();
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ph-fill-btn';
        btn.textContent = '⧉';
        btn.title = `Fill placeholder #${slug} from scratchpad (canonize)`;
        btn.style.top = `${(rect.top - pageRect.top) / scale + 2}px`;
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.openModal({ mode: 'replace', sentenceId, slug });
        });
        pageArea.appendChild(btn);
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
      <div id="import-modal" role="dialog" aria-label="canonize a snippet sketch">
        <h3>canonize a snippet sketch</h3>
        <p class="im-hint">${target.mode === 'replace'
          ? `Replaces placeholder <code>#${this.esc(target.slug)}</code> with the sketch's text, wrapped in <code>&amp;snippet#id{label}</code> … <code>&amp;end#id</code>, as one suggested edit. (The placeholder's own slug retires.)`
          : 'Inserts the sketch\'s text after this paragraph, wrapped in <code>&amp;snippet#id{label}</code> … <code>&amp;end#id</code>, as one suggested edit.'}</p>
        <input type="text" id="im-q" placeholder="Search sketches…" autocomplete="off">
        <div id="im-blocks" class="im-blocks"><span class="im-muted">Loading sketches…</span></div>
        <div class="im-row">
          <label>Label (outline) <input id="im-label" type="text" placeholder="optional"></label>
        </div>
        <div class="im-error" id="im-error" hidden></div>
        <div class="im-actions">
          <button type="button" id="im-cancel">Never mind</button>
          <button type="button" id="im-go" disabled>Canonize</button>
        </div>
      </div>`;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) this.closeModal(); });
    document.body.appendChild(overlay);
    document.getElementById('im-cancel').addEventListener('click', () => this.closeModal());
    document.getElementById('im-go').addEventListener('click', () => this.canonize());
    let t = null;
    document.getElementById('im-q').addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => this.loadSketches(), 250);
    });
    await this.loadSketches();
  },

  closeModal() {
    const el = document.getElementById('import-modal-overlay');
    if (el) el.remove();
    this.selectedSketch = null;
  },

  showError(msg) {
    const el = document.getElementById('im-error');
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
  },

  async loadSketches() {
    this.selectedSketch = null;
    const goBtn = document.getElementById('im-go');
    if (goBtn) goBtn.disabled = true;
    const holder = document.getElementById('im-blocks');
    if (!holder) return;
    const q = (document.getElementById('im-q') || { value: '' }).value.trim();
    try {
      const data = await fetchJSON(`api/sketches?q=${encodeURIComponent(q)}`, {}, false);
      const rows = (data.sketches || []).filter(v => (v.preview || '').trim());
      if (rows.length === 0) {
        holder.innerHTML = '<span class="im-muted">No sketches with text yet — write in a snippet widget first.</span>';
        return;
      }
      // Ineligible: already-canonized groups, and groups linked elsewhere.
      const curManuscript = (window.WriteSysRenderer && window.WriteSysRenderer.manuscriptId) || 0;
      const letter = (n) => String.fromCharCode(64 + n);
      holder.innerHTML = rows.map((v, i) => {
        const blockedWhy = v.canonized ? 'already canonized'
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
          this.selectedSketch = rows[parseInt(inp.value, 10)];
          document.getElementById('im-go').disabled = false;
        });
      });
    } catch (e) {
      this.showError('Failed to list sketches: ' + e.message);
    }
  },

  async canonize() {
    const r = window.WriteSysRenderer;
    const cmdLib = window.WriteSysCommand;
    const sel = this.selectedSketch;
    const target = this.target;
    if (!sel || !target) return;
    const label = document.getElementById('im-label').value.trim();
    const slug = sel.snippet_id; // the region slug IS the global snippet ID

    // Fresh full text + eligibility straight from the source of truth.
    let ctx;
    try {
      ctx = await fetchJSON(`api/sketches/${sel.sketch_id}`, {}, false);
    } catch (e) {
      return this.showError('Could not load the sketch: ' + e.message);
    }
    if (ctx.snippet.canon_sketch_id) {
      return this.showError('This snippet already has a canon sketch.');
    }
    if (ctx.snippet.linked_manuscript_id && ctx.snippet.linked_manuscript_id !== r.manuscriptId) {
      return this.showError(`This snippet is linked to ${ctx.snippet.linked_manuscript_name || 'another manuscript'}.`);
    }
    // Paranoia: the globally-unique ID should never collide with anything
    // already in the effective manuscript.
    const sug = (window.WriteSysSuggestions && window.WriteSysSuggestions.bySentenceId) || {};
    const canon = window.WriteSysCanonicalize ? window.WriteSysCanonicalize.canonicalize : null;
    const taken = window.WriteSysRegion.effectiveSlugs(r.currentSentences, sug, cmdLib, canon);
    if (taken.has(slug)) {
      return this.showError(`Snippet #${slug} already appears in this manuscript.`);
    }

    const committed = r.sentenceMap[target.sentenceId] || '';
    // Compose onto a pending suggestion when one exists — the user's prose
    // edit and the canon region ride ONE suggestion (pushed/reverted
    // together). No ambiguity: the region always goes AFTER the boundary
    // sentence's current (effective) text.
    const pending = (window.WriteSysSuggestions && window.WriteSysSuggestions.bySentenceId) || {};
    const base = pending[target.sentenceId] !== undefined ? pending[target.sentenceId] : committed;
    const content = ctx.sketch.text.replace(/\s+$/, '');
    const openLine = `&snippet#${slug}{${label}}`;
    const endLine = `&end#${slug}`;
    let suggested;
    if (target.mode === 'replace') {
      // Replace the placeholder command, keep its structural marker.
      const marker = r.leadingMarker(committed);
      suggested = `${marker}${openLine}\n\n${content}\n\n${endLine}`;
    } else {
      suggested = `${base.replace(/\s+$/, '')}\n\n${openLine}\n\n${content}\n\n${endLine}`;
    }

    const go = document.getElementById('im-go');
    go.disabled = true;
    go.textContent = 'Canonizing…';
    try {
      // Step 1: the suggestion (existing endpoint: validation, CSRF, stale
      // guard). Step 2: dub the sketch canon (snapshot + group pointer).
      const put = await fetch(`api/sentences/${encodeURIComponent(target.sentenceId)}/suggestion`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrf() },
        body: JSON.stringify({ text: suggested }),
      });
      if (put.status === 409) throw new Error('The manuscript changed under you — reload the page and retry.');
      if (!put.ok) throw new Error(`suggestion rejected (${put.status}): ${(await put.text()).slice(0, 200)}`);

      const can = await fetch(`api/sketches/${sel.sketch_id}/canonize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrf() },
        body: JSON.stringify({ manuscript_id: r.manuscriptId }),
      });
      if (!can.ok) {
        throw new Error(`Suggestion saved, but dubbing the sketch canon failed (${(await can.text()).slice(0, 200)}). ` +
          'Delete the suggestion or retry canonize from a fresh modal.');
      }

      // Now that this snippet is canonized, offer to freeze all its sketches
      // (they're no longer a work-in-progress). Individual ones can be
      // unfrozen later. Best-effort — a failure here doesn't undo the canonize.
      if (window.confirm('Freeze all sketches? (You can unfreeze select ones individually.)')) {
        try {
          await fetch(`api/snippets/${encodeURIComponent(slug)}/freeze-all`, {
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
