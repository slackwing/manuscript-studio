/**
 * WriteSysManuscriptChip — THE linked-manuscript chip, one component for every
 * surface: snippet widgets, the scratchpad title bar, and note cards. One
 * look (the old-library bookbinding leather with a gilt edge — canon = "in
 * the book", the chip names which book), one behavior:
 *
 *   linked + removable   →  [🔗 Name ×]   (× unlinks)
 *   linked + !removable  →  [🔗 Name]     (read-only, e.g. canon-pinned)
 *   unlinked             →  [🔗]          (click opens the manuscript picker)
 *
 * The picker and the manuscript list cache are also owned here — one picker,
 * one fetch, identical UX everywhere. Styles are self-injected so any page
 * that loads this script gets the identical chip.
 */
(function () {
  'use strict';

  const LINK_SVG = '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6.2 9.8l3.6-3.6"/><path d="M7.3 4.3l1.4-1.4a2.75 2.75 0 013.9 3.9l-1.4 1.4"/><path d="M8.7 11.7l-1.4 1.4a2.75 2.75 0 01-3.9-3.9l1.4-1.4"/></svg>';

  function injectStyles() {
    if (document.getElementById('ms-chip-style')) return;
    const st = document.createElement('style');
    st.id = 'ms-chip-style';
    st.textContent = `
      .ms-chip {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        max-width: 220px;
        padding: 2px 7px;
        border: 1px solid #c9a227;
        border-radius: 9px;
        background: linear-gradient(170deg, #7a5a34 0%, #5b3f22 60%, #6b4a28 100%);
        color: #f3e6c4;
        font: 10px "Helvetica", sans-serif;
        white-space: nowrap;
        box-shadow: inset 0 1px 0 rgba(255, 236, 180, 0.3);
        text-shadow: 0 1px 1px rgba(0, 0, 0, 0.35);
        cursor: default;
      }
      .ms-chip svg { flex: none; }
      .ms-chip-name { overflow: hidden; text-overflow: ellipsis; letter-spacing: 0.02em; line-height: 1.5; }
      .ms-chip-x {
        border: none;
        background: none;
        padding: 0 0 0 2px;
        font: inherit;
        font-size: 11px;
        line-height: 1;
        color: #e8d9b0;
        cursor: pointer;
        text-shadow: inherit;
      }
      .ms-chip-x:hover { color: #fff; }
      /* Unlinked: just the glyph, quiet until hover invites the link. */
      .ms-chip.unlinked {
        background: transparent;
        border-color: transparent;
        color: #b0a68f;
        box-shadow: none;
        text-shadow: none;
        cursor: pointer;
      }
      .ms-chip.unlinked:hover {
        color: #7a5a34;
        border-color: #c9a227;
        background: rgba(201, 162, 39, 0.08);
      }
    `;
    document.head.appendChild(st);
  }

  // Cached manuscript list (id + display name), shared by every picker.
  let manuscriptsPromise = null;
  function listManuscripts() {
    if (!manuscriptsPromise) {
      manuscriptsPromise = fetch('api/home', { credentials: 'same-origin' })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error('home ' + r.status))))
        .then((d) => (d.manuscripts || []).map((m) => ({ id: m.manuscript_id, name: m.display_name || m.name })));
      manuscriptsPromise.catch(() => { manuscriptsPromise = null; });
    }
    return manuscriptsPromise;
  }

  // THE manuscript picker: a search-and-pick popover anchored to `anchorEl`.
  // Calls onPick(manuscript_id). (Keeps the .note-linkpop classes — their
  // styles/z-index live in book.css and already layer above every modal.)
  function openPicker(anchorEl, onPick) {
    document.querySelectorAll('.note-linkpop').forEach((el) => el.remove());
    const pop = document.createElement('div');
    pop.className = 'note-linkpop';
    pop.innerHTML =
      '<input type="text" class="note-linkpop-q" placeholder="Search manuscripts…" autocomplete="off">' +
      '<div class="note-linkpop-list"><span class="note-linkpop-empty">Loading…</span></div>';
    document.body.appendChild(pop);
    const r = anchorEl.getBoundingClientRect();
    pop.style.position = 'absolute';
    pop.style.top = (window.scrollY + r.bottom + 4) + 'px';
    pop.style.left = (window.scrollX + Math.min(r.left, window.innerWidth - 240)) + 'px';

    const close = () => { document.removeEventListener('mousedown', outside, true); pop.remove(); };
    const outside = (e) => { if (!pop.contains(e.target)) close(); };
    setTimeout(() => document.addEventListener('mousedown', outside, true), 0);

    const q = pop.querySelector('.note-linkpop-q');
    const list = pop.querySelector('.note-linkpop-list');
    q.focus();
    listManuscripts().then((all) => {
      if (!pop.isConnected) return;
      const render = () => {
        const needle = q.value.trim().toLowerCase();
        const hits = all.filter((m) => m.name.toLowerCase().includes(needle));
        list.innerHTML = hits.length
          ? hits.map((m) => `<button type="button" data-mid="${m.id}"></button>`).join('')
          : '<span class="note-linkpop-empty">No matches</span>';
        // textContent (not innerHTML) for names — XSS-safe.
        const btns = list.querySelectorAll('button[data-mid]');
        hits.forEach((m, i) => { btns[i].textContent = m.name; });
      };
      render();
      q.addEventListener('input', render);
      q.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') close();
        if (e.key === 'Enter') { const b = list.querySelector('button[data-mid]'); if (b) b.click(); }
      });
      list.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-mid]');
        if (!b) return;
        close();
        onPick(parseInt(b.dataset.mid, 10));
      });
    }).catch(() => { list.innerHTML = '<span class="note-linkpop-empty">Could not load manuscripts</span>'; });
  }

  /**
   * build(opts) → chip element (or null when there's nothing to show).
   *   linkedId, linkedName   — current link (falsy id = unlinked)
   *   removable              — show × (default true when onUnlink given)
   *   onPick(id)             — enables the unlinked → picker flow
   *   onUnlink()             — the × action
   *   hintLinked / hintUnlinked / hintReadonly — title texts (defaults fine)
   *   extraClass             — legacy/context hook classes (test selectors,
   *                            card-compact CSS); NEVER used for skin.
   */
  function build(opts) {
    injectStyles();
    const linked = !!opts.linkedId;
    if (!linked && !opts.onPick) return null;

    const chip = document.createElement('span');
    chip.className = 'ms-chip ' + (opts.extraClass || '');
    const icon = document.createElement('span');
    icon.className = 'ms-chip-icon';
    icon.style.display = 'inline-flex';
    icon.innerHTML = LINK_SVG;
    chip.appendChild(icon);

    if (linked) {
      chip.classList.add('linked');
      const name = document.createElement('span');
      name.className = 'ms-chip-name';
      name.textContent = opts.linkedName || 'Manuscript';
      chip.appendChild(name);
      const removable = opts.removable !== false && !!opts.onUnlink;
      if (removable) {
        chip.title = opts.hintLinked || ('Linked to ' + (opts.linkedName || 'a manuscript') + '. Click × to unlink.');
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'ms-chip-x';
        rm.textContent = '×';
        rm.title = 'Unlink';
        rm.addEventListener('click', (e) => { e.stopPropagation(); opts.onUnlink(); });
        chip.appendChild(rm);
      } else {
        chip.classList.add('readonly');
        chip.title = opts.hintReadonly || ('In ' + (opts.linkedName || 'this manuscript'));
      }
    } else {
      chip.classList.add('unlinked');
      chip.title = opts.hintUnlinked || 'Link to a manuscript';
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        openPicker(chip, (id) => opts.onPick(id));
      });
    }
    return chip;
  }

  window.WriteSysManuscriptChip = { build, openPicker, listManuscripts, LINK_SVG };
})();
