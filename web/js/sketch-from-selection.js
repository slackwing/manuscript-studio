/**
 * Sketch from selection (the placement rethink, phase 3): shift-select a
 * sentence range in the book, click the SKETCH icon in the gutter → rework
 * that passage through sketches:
 *   - variation A = the selected text, FROZEN (the as-placed baseline);
 *   - variation B = an editable copy;
 *   - the group is linked and PLACED from birth (snapshot = A), so the
 *     wordcount counts it via the manuscript only (never double);
 *   - the selection is wrapped in &sketch#id{label} … &end#id as ordinary
 *     suggested edits (a placement AROUND existing text — no text change);
 *   - the A/B widgets land in a scratchpad of your choosing (new, or
 *     appended to an existing one).
 * The margin glyph of a placed region is the sketch icon; clicking it
 * navigates to the group's home widget.
 */
const WriteSysSketchFromSelection = {
  csrf() { return (localStorage.getItem('csrf_token') || sessionStorage.getItem('csrf_token')) || ''; },

  init() {
    if (!document.getElementById('manuscript-content')) return; // book page only
    // Margin sketch glyph → the group's home widget (modal deep-link).
    document.addEventListener('click', async (e) => {
      const glyph = e.target.closest && e.target.closest('.cmd-sketch-glyph');
      if (!glyph || !glyph.dataset.slug) return;
      e.preventDefault();
      e.stopPropagation();
      try {
        const r = await fetch(`api/sketches/${encodeURIComponent(glyph.dataset.slug)}/home`, { credentials: 'same-origin' });
        const home = await r.json();
        if (home.scratchpad_id > 0) {
          window.location.hash = `#scratchpad=${home.scratchpad_id}&sketch=${encodeURIComponent(glyph.dataset.slug)}&variation=${home.ordinal}`;
        } else {
          alert('This sketch has no home scratchpad on record.');
        }
      } catch (err) { alert('Could not locate the sketch: ' + err.message); }
    }, true);
  },

  // Called by range-delete when the gutter buttons render. Sparkles — the
  // same "new variation from this" mark the widget toolbars use.
  buttonHTML() {
    return window.WriteSysIcons && window.WriteSysIcons.sparkles ? window.WriteSysIcons.sparkles(12) : '✧';
  },

  open(rangeIds) {
    this.close();
    const wrap = document.createElement('div');
    wrap.id = 'sketch-sel-modal';
    wrap.innerHTML = `
      <div class="ssm-box" role="dialog" aria-label="sketch from selection">
        <h3>sketch from selection</h3>
        <p class="ssm-hint">${rangeIds.length} sentence${rangeIds.length > 1 ? 's' : ''} → variation A (the frozen original), placed in the book.</p>
        <label class="ssm-radio"><input type="radio" name="ssm-pad" value="new" checked> New scratchpad</label>
        <label class="ssm-radio"><input type="radio" name="ssm-pad" value="existing"> Append to
          <select id="ssm-pad-pick" disabled><option>Loading…</option></select></label>
        <div class="ssm-actions">
          <button type="button" id="ssm-cancel">Cancel</button>
          <button type="button" id="ssm-go">Create</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    wrap.addEventListener('click', (e) => { if (e.target === wrap) this.close(); });
    document.getElementById('ssm-cancel').addEventListener('click', () => this.close());
    document.getElementById('ssm-go').addEventListener('click', () => this.create(rangeIds));
    // Existing pads for the append option.
    (async () => {
      try {
        const home = await (await fetch('api/home', { credentials: 'same-origin' })).json();
        const sel = document.getElementById('ssm-pad-pick');
        if (!sel) return;
        sel.innerHTML = (home.scratchpads || []).map(p =>
          `<option value="${p.scratchpad_id}">${(p.title || 'Untitled').replace(/</g, '&lt;')}</option>`).join('')
          || '<option value="">(no scratchpads yet)</option>';
        sel.disabled = false;
        wrap.querySelectorAll('input[name="ssm-pad"]').forEach(radio =>
          radio.addEventListener('change', () => { sel.disabled = radio.value !== 'existing' || !radio.checked; }));
      } catch (e) { /* keep 'new' as the only option */ }
    })();
  },

  close() {
    const el = document.getElementById('sketch-sel-modal');
    if (el) el.remove();
  },

  async create(rangeIds) {
    const go = document.getElementById('ssm-go');
    go.disabled = true;
    go.textContent = 'Creating…';
    try {
      const r = window.WriteSysRenderer;
      const sug = (window.WriteSysSuggestions && window.WriteSysSuggestions.bySentenceId) || {};
      const eff = (id) => (sug[id] !== undefined ? sug[id] : (r.sentenceMap[id] || ''));
      // Approximate raw of the selection: sentence texts carry their own
      // markers; unmarked neighbors joined with a space.
      let text = '';
      for (const id of rangeIds) {
        const t = eff(id);
        text += (t.startsWith('\n') || text === '' ? '' : ' ') + t;
      }
      text = text.trim();
      const mode = document.querySelector('input[name="ssm-pad"]:checked').value;
      let padId;
      if (mode === 'existing') {
        padId = parseInt(document.getElementById('ssm-pad-pick').value, 10);
        if (!padId) throw new Error('pick a scratchpad');
      } else {
        const pad = await (await fetch('api/scratchpads', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrf() },
          body: JSON.stringify({ title: 'Untitled' }),
        })).json();
        padId = pad.scratchpad_id;
      }
      const resp = await fetch('api/sketches', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrf() },
        body: JSON.stringify({ mode: 'from-selection', manuscript_id: r.manuscriptId, text, scratchpad_id: padId }),
      });
      if (!resp.ok) throw new Error((await resp.text()).trim() || String(resp.status));
      const ctx = await resp.json();
      const slug = ctx.sketch.sketch_id;
      // Wrap the selection in the group anchors — placement AROUND the
      // existing sentences, as ordinary reviewable suggestions.
      const firstId = rangeIds[0];
      const lastId = rangeIds[rangeIds.length - 1];
      const put = async (id, t) => {
        const pr = await fetch(`api/sentences/${encodeURIComponent(id)}/suggestion`, {
          method: 'PUT', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrf() },
          body: JSON.stringify({ text: t }),
        });
        if (!pr.ok) throw new Error(`anchor suggestion failed on ${id} (${pr.status})`);
      };
      // Label-less by design: the empty brace group keeps the token valid
      // (bare &sketch#id is prose per grammar) and the outline skips
      // unlabeled anchors.
      const opener = `&sketch#${slug}{}`;
      // The first sentence keeps ITS OWN leading marker after the opener —
      // "But first…" starting an indented paragraph must still start one
      // inside the region. Only a marker-less (mid-paragraph) start gets a
      // plain "\n" join (canonicalize's same-paragraph anchor form).
      const first = eff(firstId);
      const joined = /^\n[\n\t]/.test(first) ? `${opener}${first}` : `${opener}\n${first}`;
      if (firstId === lastId) {
        await put(firstId, `${joined}\n&end#${slug}`);
      } else {
        await put(firstId, joined);
        await put(lastId, `${eff(lastId)}\n&end#${slug}`);
      }
      this.close();
      if (window.WriteSysRangeDelete) window.WriteSysRangeDelete.exit();
      if (window.WriteSysSuggestions) await window.WriteSysSuggestions.loadForMigration(r.currentMigrationID);
      if (r.renderManuscript) await r.renderManuscript({ anchorSentenceId: firstId });
      if (window.WriteSysPush) window.WriteSysPush.refresh();
    } catch (err) {
      alert('Could not create the sketch: ' + err.message);
      go.disabled = false;
      go.textContent = 'Create';
    }
  },
};

if (typeof window !== 'undefined') {
  window.WriteSysSketchFromSelection = WriteSysSketchFromSelection;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => WriteSysSketchFromSelection.init());
  } else {
    WriteSysSketchFromSelection.init();
  }
}
