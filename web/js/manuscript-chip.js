/**
 * WriteSysManuscriptChip — THE linked-manuscript chip, one component for every
 * surface: sketch widgets, the scratchpad title bar, and note cards. One
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

  const LINK_SVG = window.WriteSysIcons.link(11); // house icon, js/icons.js

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
        height: auto;
        margin: 0;
        box-sizing: border-box;
        /* UNIFIED with tag chips: same outer geometry (a tag chip is 4px/10px
           padding, 16px pill, 11px type, no border) — here the 2px gilt edge
           lives INSIDE that outline, so both chips are exactly the same size
           (2+2=4, 8+2=10). */
        padding: 2px 8px;
        /* 2px, not 1 — at 1px the gilt edge was too thin to read as gold
           against the leather and just looked like fuzz. */
        border: 2px solid #c9a227;
        border-radius: 16px;
        /* Flat vertical leather — a diagonal gradient + inset sheen smeared
           around the pill's rounded ends and read as blotches. */
        background: linear-gradient(#66492b, #573d21);
        background-clip: padding-box;
        color: #f3e6c4;
        font: 11px "Helvetica", sans-serif;
        white-space: nowrap;
        box-shadow: none;
        text-shadow: none;
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
      /* Unlinked: same dashed-outline language as the note's other buttons
         (priority chips / trash / checkmark) — normal ink, no gilt until
         it's actually linked. Keeps the pill shape; +1px padding offsets
         the thinner border so the outer size doesn't shift. */
      .ms-chip.unlinked {
        background: transparent;
        border: 1px dashed #ccc;
        padding: 3px 9px;
        color: #999;
        box-shadow: none;
        text-shadow: none;
        cursor: pointer;
      }
      .ms-chip.unlinked:hover {
        background: #f5f5f5;
        border-color: #999;
        color: #666;
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
