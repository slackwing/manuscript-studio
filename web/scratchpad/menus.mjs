/**
 * Scratchpad toolbar MENUS + PM command helpers (split out of editor-core.mjs
 * — CODE_REVIEW_AUG_2026.md §1): insertBlockSafely, the mark/heading/table/
 * blockquote state helpers, the Word-style table-size picker, and the
 * ⧉ Sketch ▾ menu (with its shared search-and-pick popover, buildPickerPop).
 */
import { NodeSelection, wrapIn, liftTarget } from './vendor/prosemirror.mjs';
import { schema } from './schema.mjs?v=1';
import { variationApi } from './api.mjs?v=1';
import { esc, letterOf, parseVariationRef, refreshSketchSiblings } from './sketch-view.mjs?v=3';

// fmtDeleted renders a deleted_at ISO timestamp as a short local date for the
// Restore… list (e.g. "Jul 26"). Empty/invalid → ''.
export function fmtDeleted(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Insert a block node WITHOUT destroying a node-selected atom.
export function insertBlockSafely(state, dispatch, node) {
  if (!node) return false;
  if (dispatch) {
    const tr = (state.selection instanceof NodeSelection)
      ? state.tr.insert(state.selection.to, node)
      : state.tr.replaceSelectionWith(node);
    dispatch(tr.scrollIntoView());
  }
  return true;
}

function insertTableOfSize(state, dispatch, rows, cols) {
  const { table, table_row, table_cell } = schema.nodes;
  const mkRow = () => table_row.create(null,
    Array.from({ length: cols }, () => table_cell.createAndFill()));
  return insertBlockSafely(state, dispatch,
    table.create(null, Array.from({ length: rows }, mkRow)));
}

export function markActive(state, type) {
  const { from, $from, to, empty } = state.selection;
  if (empty) return !!type.isInSet(state.storedMarks || $from.marks());
  return state.doc.rangeHasMark(from, to, type);
}

export function headingActive(state, level) {
  const n = state.selection.$from.parent;
  return n.type === schema.nodes.heading && n.attrs.level === level;
}

// tableNodes stamps tableRole into each node spec — the robust "am I in a
// table?" check, independent of node names.
export function inTable(state) {
  const $from = state.selection.$from;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.spec.tableRole === 'table') return true;
  }
  return false;
}

export function inBlockquote(state) {
  const $from = state.selection.$from;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type === schema.nodes.blockquote) return true;
  }
  return false;
}

// Blockquote is a toggle: inside a quote the button lifts one level out
// (wrapIn alone would stack quote-in-quote on every press); outside, it wraps.
export function toggleBlockquote(state, dispatch) {
  const { $from, $to } = state.selection;
  const range = $from.blockRange($to, n => n.type === schema.nodes.blockquote);
  if (range) {
    const target = liftTarget(range);
    if (target == null) return false;
    if (dispatch) dispatch(state.tr.lift(range, target).scrollIntoView());
    return true;
  }
  return wrapIn(schema.nodes.blockquote)(state, dispatch);
}

// The Word-style rows×cols grid dropdown behind the Table button.
export function buildTablePicker(toolbarEl, getView) {
  const MAX = 8;
  const wrap = document.createElement('span');
  wrap.className = 'tb-tablewrap';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.title = 'Insert table';
  btn.textContent = 'Table ▾';
  const pop = document.createElement('div');
  pop.className = 'tb-grid';
  pop.hidden = true;
  const label = document.createElement('div');
  label.className = 'tb-grid-label';
  const cellsHost = document.createElement('div');
  cellsHost.className = 'tb-grid-cells';
  cellsHost.style.gridTemplateColumns = `repeat(${MAX}, 1fr)`;
  const cells = [];
  for (let r = 1; r <= MAX; r++) {
    for (let c = 1; c <= MAX; c++) {
      const cell = document.createElement('span');
      cell.className = 'tb-grid-cell';
      cell.dataset.r = r;
      cell.dataset.c = c;
      cell.addEventListener('mouseenter', () => {
        cells.forEach(el =>
          el.classList.toggle('on', +el.dataset.r <= r && +el.dataset.c <= c));
        label.textContent = `${c} × ${r}`;
      });
      cell.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const view = getView();
        insertTableOfSize(view.state, view.dispatch, r, c);
        close();
        view.focus();
      });
      cellsHost.appendChild(cell);
      cells.push(cell);
    }
  }
  pop.append(label, cellsHost);
  wrap.append(btn, pop);

  const reset = () => {
    cells.forEach(el => el.classList.remove('on'));
    label.textContent = 'Table size';
  };
  reset();
  const onDocDown = (e) => { if (!wrap.contains(e.target)) close(); };
  const close = () => {
    pop.hidden = true;
    document.removeEventListener('mousedown', onDocDown, true);
    reset();
  };
  btn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    if (pop.hidden) {
      pop.hidden = false;
      document.addEventListener('mousedown', onDocDown, true);
    } else {
      close();
    }
  });
  toolbarEl.appendChild(wrap);
}

// The ⧉ Sketch ▾ menu: New sketch, or Based on… (variation picker sorted
// by variation updated_at, then a freeze-the-source choice).
export function buildSketchMenu(toolbarEl, getView) {
  const wrap = document.createElement('span');
  wrap.className = 'tb-tablewrap';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sn-btn';
  btn.title = 'Insert a Manuscript Sketch (new, or a variation based on an existing one)';
  btn.textContent = '⧉ Sketch ▾';
  const pop = document.createElement('div');
  pop.className = 'sn-insertpop';
  pop.hidden = true;
  wrap.append(btn, pop);

  const onDocDown = (e) => { if (!wrap.contains(e.target)) close(); };
  const close = () => {
    pop.hidden = true;
    document.removeEventListener('mousedown', onDocDown, true);
  };

  const insertVariation = (ctx) => {
    const view = getView();
    insertBlockSafely(view.state, view.dispatch,
      schema.nodes.snippet.create({ variationId: ctx.variation.variation_id }));
    close();
    view.focus();
    // A new sibling changes the group's variation list, so every EXISTING widget of
    // the same sketch must refresh to show the new one in its tab bar (the new
    // widget just mounted fresh with the full list). Without this, related
    // widgets don't get the new tab until a reload.
    const sketchId = (ctx.sketch && ctx.sketch.sketch_id)
      || (ctx.variation && ctx.variation.sketch_id);
    refreshSketchSiblings(sketchId, ctx.variation.variation_id);
  };

  const renderRoot = () => {
    pop.innerHTML = `
      <button type="button" class="sn-ins-new">New sketch</button>
      <button type="button" class="sn-ins-based">Related to…</button>
      <button type="button" class="sn-ins-clip" disabled title="Copy a sketch reference first (the copy button on a sketch widget)">From clipboard</button>
      <button type="button" class="sn-ins-restore">Restore…</button>`;
    pop.querySelector('.sn-ins-new').addEventListener('click', async () => {
      try { insertVariation(await variationApi.createNew()); }
      catch (e) { alert('Could not create sketch: ' + e.message); }
    });
    pop.querySelector('.sn-ins-based').addEventListener('click', renderPicker);
    pop.querySelector('.sn-ins-restore').addEventListener('click', renderRestore);
    // "From clipboard" lights up only when the app's record of the last
    // copy-button press points at a VALID variation (confirmed against the
    // API so a stale/foreign id stays disabled). Deliberately NO
    // navigator.clipboard.readText() here: Firefox answers that with its
    // paste PROMPT, which stole the menu's first click ("have to hit New
    // sketch twice"). The copy button writes both the clipboard and
    // ms_last_variation_ref — the record suffices.
    (async () => {
      const clipBtn = pop.querySelector('.sn-ins-clip');
      const spin = document.createElement('span');
      spin.className = 'sn-clip-spin';
      clipBtn.appendChild(spin);
      try {
        const id = parseInt(localStorage.getItem('ms_last_variation_ref') || '', 10) || null;
        if (id == null) return;
        const ctx = await variationApi.context(id);
        if (!clipBtn.isConnected) return; // menu re-rendered/closed meanwhile
        const preview = ((ctx.variation && ctx.variation.text) || '').trim().slice(0, 40);
        clipBtn.disabled = false;
        clipBtn.title = `New variation related to the copied one${preview ? `: “${preview}”` : ''}`;
        clipBtn.addEventListener('click', async () => {
          try { insertVariation(await variationApi.createFrom(id)); }
          catch (err) { alert('Could not create variation: ' + err.message); }
        });
      } catch (_) { /* no clipboard access or invalid reference — stays disabled */ }
      finally { spin.remove(); }
    })();
  };

  // THE search-and-pick popover (DRY.md item 4, scoped to this menu's two
  // pickers): input + debounced load + button list; Escape closes the
  // POPOVER ONLY — stopPropagation so the modal's document-level Escape
  // handler doesn't also close the whole pad.
  const buildPickerPop = async ({ placeholder, fetchRows, rowHTML, emptyText, errorText, onPick }) => {
    pop.innerHTML = `
      <input type="text" class="sn-ins-q" placeholder="${placeholder}" autocomplete="off">
      <div class="sn-ins-list"><span class="sn-linkpop-empty">Loading…</span></div>`;
    const q = pop.querySelector('.sn-ins-q');
    const list = pop.querySelector('.sn-ins-list');
    q.focus();
    const load = async () => {
      let rows;
      try {
        rows = await fetchRows(q.value.trim());
      } catch (e) {
        list.innerHTML = `<span class="sn-linkpop-empty">${errorText}</span>`;
        return;
      }
      list.innerHTML = rows.length
        ? rows.map(rowHTML).join('')
        : `<span class="sn-linkpop-empty">${emptyText}</span>`;
    };
    let t;
    q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 250); });
    q.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
    });
    list.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-vid]');
      if (b) onPick(parseInt(b.dataset.vid, 10));
    });
    await load();
  };

  // Restore… picker: soft-deleted variations, newest deletion first. Selecting
  // one un-deletes it and inserts its widget.
  const renderRestore = () => buildPickerPop({
    placeholder: 'Search deleted variations…',
    fetchRows: async (q) => (await variationApi.listDeleted(q)).variations || [],
    rowHTML: (r) => `
          <button type="button" data-vid="${r.variation_id}">
            <span class="sn-ins-letter">${esc(letterOf(r.ordinal))}</span>
            <span class="sn-ins-preview">${esc(r.preview || '(empty)')}</span>
            <span class="sn-ins-deleted">${esc(fmtDeleted(r.deleted_at))}</span>
          </button>`,
    emptyText: 'No deleted variations',
    errorText: 'Could not load deleted variations',
    onPick: async (vid) => {
      try { insertVariation(await variationApi.restore(vid)); }
      catch (err) { alert('Could not restore variation: ' + err.message); }
    },
  });

  // Related to… picker. Picking a source variation mints a NEW sibling
  // variation directly (next letter, text copied). No freeze dialog — the
  // source is left as-is.
  const renderPicker = () => buildPickerPop({
    placeholder: 'Search variations…',
    fetchRows: async (q) => (await variationApi.list(q)).variations || [],
    rowHTML: (r) => `
          <button type="button" data-vid="${r.variation_id}">
            <span class="sn-ins-letter">${esc(letterOf(r.ordinal))}</span>
            <span class="sn-ins-preview">${esc(r.preview || '(empty)')}</span>
          </button>`,
    emptyText: 'No variations yet',
    errorText: 'Could not load variations',
    onPick: async (vid) => {
      try { insertVariation(await variationApi.createFrom(vid)); }
      catch (err) { alert('Could not create variation: ' + err.message); }
    },
  });

  btn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    if (pop.hidden) {
      pop.hidden = false;
      renderRoot();
      document.addEventListener('mousedown', onDocDown, true);
    } else {
      close();
    }
  });
  toolbarEl.appendChild(wrap);
}
