/**
 * Book-side Canonize (SCRATCHPAD_PLAN.md §7): a + rule between paragraphs
 * (and a "Fill" affordance on placeholders) that imports a scratchpad's
 * draft snippet as ONE suggested edit wrapped in
 * &anchor#slug{label} … &end#slug.
 *
 * Step 1 is the ordinary suggestion PUT (stale-migration guard included);
 * step 2 is POST /scratchpads/{id}/blocks/{bid}/canonize which stamps the
 * block's ref + snapshot. Import targets must be committed sentences with
 * no pending suggestion (decision 6/7).
 */
const WriteSysImportScratchpad = {
  csrf() { return sessionStorage.getItem('csrf_token') || ''; },

  // ---------------------------------------------------------- affordances

  // refresh (re)builds the hover affordances. Runs after pagination, same
  // hook family as the rainbow bars.
  refresh() {
    document.querySelectorAll('.import-zone, .ph-fill-btn').forEach(el => el.remove());
    const r = window.WriteSysRenderer;
    if (!r || !r.currentMigrationID) return;
    const sug = (window.WriteSysSuggestions && window.WriteSysSuggestions.bySentenceId) || {};

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
        if (sug[boundaryId] !== undefined) return; // pending suggestion → ineligible
        if (!r.sentenceMap[boundaryId]) return;    // not a committed sentence
        // The zone itself never intercepts pointer events (it overlays prose
        // when paragraphs have no gap) — only the small left-margin + tab is
        // clickable; hovering it reveals the insertion rule.
        const rect = p.getBoundingClientRect();
        const zone = document.createElement('div');
        zone.className = 'import-zone';
        zone.style.top = `${Math.max(0, rect.top - pageRect.top - 9)}px`;
        zone.innerHTML = '<button type="button" class="import-tab" title="Import from scratchpad (canonize)">+</button><span class="import-rule"></span>';
        zone.querySelector('.import-tab').addEventListener('click', (e) => {
          e.stopPropagation();
          this.openModal({ mode: 'append', sentenceId: boundaryId });
        });
        // The + is hidden by default and only shown when the mouse is near this
        // gap — i.e. hovering the paragraph just below it (or the one above).
        // We toggle .import-hot on the zone rather than making the zone itself
        // pointer-interactive, so prose is never blocked.
        const hot = () => zone.classList.add('import-hot');
        const cold = () => zone.classList.remove('import-hot');
        p.addEventListener('mouseenter', hot);
        p.addEventListener('mouseleave', cold);
        if (prev) { prev.addEventListener('mouseenter', hot); prev.addEventListener('mouseleave', cold); }
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
        btn.style.top = `${rect.top - pageRect.top + 2}px`;
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.openModal({ mode: 'replace', sentenceId, slug });
        });
        pageArea.appendChild(btn);
      });
    });
  },

  // --------------------------------------------------------------- modal

  async openModal(target) {
    this.closeModal();
    this.target = target;
    const overlay = document.createElement('div');
    overlay.id = 'import-modal-overlay';
    overlay.innerHTML = `
      <div id="import-modal" role="dialog" aria-label="Canonize from scratchpad">
        <h3>Canonize from scratchpad</h3>
        <p class="im-hint">${target.mode === 'replace'
          ? `Replaces placeholder <code>#${this.esc(target.slug)}</code> with a scratchpad block, wrapped in <code>&amp;anchor#${this.esc(target.slug)}</code> … <code>&amp;end#${this.esc(target.slug)}</code>, as one suggested edit.`
          : 'Inserts a scratchpad block after this paragraph, wrapped in <code>&amp;anchor#slug</code> … <code>&amp;end#slug</code>, as one suggested edit.'}</p>
        <label>Scratchpad
          <select id="im-pad"><option value="">Loading…</option></select>
        </label>
        <div id="im-blocks" class="im-blocks"><span class="im-muted">Pick a scratchpad to list its draft snippets.</span></div>
        <div class="im-row">
          <label>Slug <input id="im-slug" type="text" ${target.mode === 'replace' ? 'readonly' : ''}
            value="${target.mode === 'replace' ? this.esc(target.slug) : ''}" placeholder="a-z, 0-9, dashes"></label>
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
    document.getElementById('im-pad').addEventListener('change', (e) => this.loadBlocks(parseInt(e.target.value, 10)));

    try {
      const data = await fetchJSON('api/scratchpads', {}, false);
      const pads = data.scratchpads || [];
      const sel = document.getElementById('im-pad');
      sel.innerHTML = '<option value="">— choose —</option>' + pads.map(p =>
        `<option value="${p.scratchpad_id}">${this.esc(p.title)}</option>`).join('');
      if (pads.length === 0) this.showError('No scratchpads yet — create one from the home page.');
    } catch (e) {
      this.showError('Failed to list scratchpads: ' + e.message);
    }
  },

  closeModal() {
    const el = document.getElementById('import-modal-overlay');
    if (el) el.remove();
    this.selectedBlock = null;
  },

  showError(msg) {
    const el = document.getElementById('im-error');
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
  },

  async loadBlocks(scratchpadId) {
    this.selectedBlock = null;
    document.getElementById('im-go').disabled = true;
    const holder = document.getElementById('im-blocks');
    if (!scratchpadId) { holder.innerHTML = ''; return; }
    holder.innerHTML = '<span class="im-muted">Loading…</span>';
    try {
      const data = await fetchJSON(`api/scratchpads/${scratchpadId}`, {}, false);
      const drafts = [];
      const walk = (node) => {
        if (node && (node.type === 'snippet' || node.type === 'book_content') && node.attrs && !node.attrs.refSlug && (node.attrs.text || '').trim()) {
          drafts.push({ blockId: node.attrs.blockId, text: node.attrs.text });
        }
        (node && node.content || []).forEach(walk);
      };
      walk(data.scratchpad.doc);
      if (drafts.length === 0) {
        holder.innerHTML = '<span class="im-muted">No draft snippets (with text) in this scratchpad.</span>';
        return;
      }
      holder.innerHTML = drafts.map((d, i) => `
        <label class="im-block"><input type="radio" name="im-block" value="${i}">
          <span class="im-block-text">${this.esc(d.text.slice(0, 120))}${d.text.length > 120 ? '…' : ''}</span>
        </label>`).join('');
      holder.querySelectorAll('input[name="im-block"]').forEach(inp => {
        inp.addEventListener('change', () => {
          this.selectedBlock = { scratchpadId, ...drafts[parseInt(inp.value, 10)] };
          document.getElementById('im-go').disabled = false;
        });
      });
    } catch (e) {
      this.showError('Failed to load scratchpad: ' + e.message);
    }
  },

  async canonize() {
    const r = window.WriteSysRenderer;
    const cmdLib = window.WriteSysCommand;
    const block = this.selectedBlock;
    const target = this.target;
    if (!block || !target) return;
    const slug = document.getElementById('im-slug').value.trim();
    const label = document.getElementById('im-label').value.trim();

    if (!cmdLib.validSlug(slug)) {
      return this.showError('Slug must be lowercase letters, digits, and dashes.');
    }
    // Uniqueness against the whole effective manuscript — except the
    // placeholder's own slug when we're replacing that placeholder.
    const sug = (window.WriteSysSuggestions && window.WriteSysSuggestions.bySentenceId) || {};
    const canon = window.WriteSysCanonicalize ? window.WriteSysCanonicalize.canonicalize : null;
    const taken = window.WriteSysRegion.effectiveSlugs(r.currentSentences, sug, cmdLib, canon);
    if (taken.has(slug) && !(target.mode === 'replace' && slug === target.slug)) {
      return this.showError(`Slug #${slug} is already used in this manuscript.`);
    }

    const committed = r.sentenceMap[target.sentenceId] || '';
    const content = block.text.replace(/\s+$/, '');
    const anchorLine = `&anchor#${slug}{${label}}`;
    const endLine = `&end#${slug}`;
    let suggested;
    if (target.mode === 'replace') {
      // Replace the placeholder command, keep its structural marker.
      const marker = r.leadingMarker(committed);
      suggested = `${marker}${anchorLine}\n\n${content}\n\n${endLine}`;
    } else {
      suggested = `${committed}\n\n${anchorLine}\n\n${content}\n\n${endLine}`;
    }

    const go = document.getElementById('im-go');
    go.disabled = true;
    go.textContent = 'Canonizing…';
    try {
      // Step 1: the suggestion (existing endpoint: validation, CSRF, stale
      // guard). Step 2: stamp the block (ref + snapshot + index).
      const put = await fetch(`api/sentences/${encodeURIComponent(target.sentenceId)}/suggestion`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrf() },
        body: JSON.stringify({ text: suggested }),
      });
      if (put.status === 409) throw new Error('The manuscript changed under you — reload the page and retry.');
      if (!put.ok) throw new Error(`suggestion rejected (${put.status}): ${(await put.text()).slice(0, 200)}`);

      const can = await fetch(`api/scratchpads/${block.scratchpadId}/blocks/${encodeURIComponent(block.blockId)}/canonize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrf() },
        body: JSON.stringify({
          manuscript_id: r.manuscriptId,
          ref_slug: slug,
          label,
          migration_id: r.currentMigrationID,
        }),
      });
      if (!can.ok) {
        throw new Error(`Suggestion saved, but marking the scratchpad block failed (${(await can.text()).slice(0, 200)}). ` +
          'Delete the suggestion or retry canonize from a fresh modal.');
      }

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
