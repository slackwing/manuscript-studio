/**
 * The note modal (2026-11-25): a note card on the landing, the daily board
 * or a board no longer "opens in context" — with placements (NOTE_PLACEMENTS
 * _PLAN.md) a note has no single source. Instead the page greys out and the
 * FULL note (the shared widget, editable, saving through the note API) sits
 * centred, with a tiling of one card per placement under it — a manuscript
 * card per sentence it sits on, a pad card per scratchpad — arranged in a
 * forming square (cols = ⌈√n⌉: 4 → 2×2, 5 → 3 + 2). Hovering a manuscript
 * card shows the sentence as the book sets it (scratch-render: the real
 * pipeline in a shadow root), as if snipped from the page; clicking goes
 * there. Escape / the backdrop close it.
 *
 *   WriteSysNoteModal.open(noteId, { focus })   WriteSysNoteModal.close()
 *   → dispatches 'note-modal-closed' ({ noteId }) on document after a close.
 */
(function () {
  let overlay = null;
  let hint = null;
  let current = null;

  const api = () => window.WriteSysNoteAPI;
  const csrf = () => (localStorage.getItem('csrf_token') || sessionStorage.getItem('csrf_token')) || '';

  function close() {
    if (!overlay) return;
    killHint();
    overlay.remove();
    overlay = null;
    document.removeEventListener('keydown', onKey, true);
    const id = current;
    current = null;
    document.dispatchEvent(new CustomEvent('note-modal-closed', { detail: { noteId: id } }));
  }
  function onKey(e) {
    if (e.key === 'Escape' && !document.querySelector('.note-linkpop')) { e.preventDefault(); close(); }
  }

  // The widget's handlers: every change goes to the API; delete / complete
  // close the modal (the page behind re-renders on 'note-modal-closed').
  function handlers(note, hostEl) {
    const A = api();
    return {
      onSaveText: (text) => { note.body = text.trim() || null; A.update(note.note_id, { body: text.trim() }).catch(() => {}); },
      onColor: (color) => {
        note.color = color;
        A.update(note.note_id, { color }).catch(() => {});
        rerender(note, hostEl);
      },
      onDims: (patch) => { Object.assign(note, patch); A.update(note.note_id, patch).catch(() => {}); window.WriteSysNoteWidget.updateDims(hostEl.firstElementChild, note); },
      onDelete: () => { A.remove(note.note_id).catch(() => {}); close(); },
      onComplete: () => { A.complete(note.note_id).catch(() => {}); close(); },
      onScorePoints: (points) => { A.scorePoints(note.note_id, points).catch(() => {}); },
      onAddTag: async (name) => { try { const r = await A.addTag(note.note_id, name); note.tags = (r && r.tags) || note.tags; } catch (e) { /* chips re-render from note */ } },
      onRemoveTag: async (tagId) => { try { await A.removeTag(note.note_id, tagId); note.tags = (note.tags || []).filter((t) => t.tag_id !== tagId); } catch (e) { /* ditto */ } },
      onLinkManuscript: async (mid) => { try { const r = await A.linkManuscript(note.note_id, mid); note.manuscript_id = r.manuscript_id || null; note.manuscript_name = r.manuscript_name || ''; } catch (e) { /* unchanged */ } },
      onUnlinkManuscript: async () => { try { await A.linkManuscript(note.note_id, 0); note.manuscript_id = null; note.manuscript_name = ''; } catch (e) { /* unchanged */ } },
      onPinned: () => {},
    };
  }

  function rerender(note, hostEl) {
    const W = window.WriteSysNoteWidget;
    const focused = document.activeElement && hostEl.contains(document.activeElement);
    hostEl.innerHTML = '';
    hostEl.appendChild(W.buildNoteElement(note, handlers(note, hostEl), { showDelete: true, showComplete: true }));
    const ta = hostEl.querySelector('.note-input');
    if (ta) { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; if (focused) ta.focus(); }
  }

  const cols = (n) => Math.max(1, Math.ceil(Math.sqrt(n)));

  // ---- the hover hint: the sentence as the book sets it ----
  function killHint() { if (hint) { hint.remove(); hint = null; } }
  function showHint(card, text) {
    killHint();
    if (!window.WriteSysScratchRender || !text) return;
    hint = document.createElement('div');
    hint.className = 'nm-hint';
    const page = document.createElement('div');
    page.className = 'nm-hint-page';
    hint.appendChild(page);
    overlay.appendChild(hint);
    window.WriteSysScratchRender.renderText(page, text);
    // Below the card when it fits, else above; clamped to the viewport.
    const r = card.getBoundingClientRect();
    const W = Math.min(440, window.innerWidth - 24);
    hint.style.width = W + 'px';
    const h = hint.offsetHeight || 120;
    const top = r.bottom + 8 + h <= window.innerHeight - 8 ? r.bottom + 8 : Math.max(8, r.top - 8 - h);
    hint.style.top = top + 'px';
    hint.style.left = Math.max(12, Math.min(r.left + r.width / 2 - W / 2, window.innerWidth - W - 12)) + 'px';
  }

  function placementCards(noteId, p) {
    const grid = document.createElement('div');
    grid.className = 'nm-cards';
    const items = [];
    (p.sentences || []).forEach((s) => items.push({ kind: 'manuscript', s }));
    (p.scratchpads || []).forEach((sp) => items.push({ kind: 'pad', sp }));
    if (!items.length) { grid.hidden = true; return grid; }
    grid.style.setProperty('--nm-cols', String(cols(items.length)));
    items.forEach((it) => {
      const card = document.createElement('div');
      card.className = 'card nm-card nm-card-' + it.kind;
      card.tabIndex = 0;
      card.setAttribute('role', 'button');
      const bar = document.createElement('span');
      bar.className = 'card-kindbar';
      card.appendChild(bar);
      const title = document.createElement('p');
      title.className = 'card-title';
      if (it.kind === 'manuscript') {
        title.textContent = it.s.manuscript_name || 'Manuscript';
        card.dataset.sentenceId = it.s.sentence_id;
        card.dataset.manuscriptId = it.s.manuscript_id;
        card.appendChild(title);
        if (!it.s.current) {
          const sub = document.createElement('p');
          sub.className = 'card-meta nm-card-sub';
          sub.textContent = 'earlier version';
          card.appendChild(sub);
        }
        card.addEventListener('mouseenter', () => showHint(card, it.s.text));
        card.addEventListener('mouseleave', killHint);
        card.addEventListener('focus', () => showHint(card, it.s.text));
        card.addEventListener('blur', killHint);
        const go = () => {
          const href = `./?manuscript_id=${it.s.manuscript_id}#note-sentence=${encodeURIComponent(it.s.sentence_id)}`;
          close();
          if (!(window.WriteSysTabs && window.WriteSysTabs.route(href))) window.location.href = href;
        };
        card.addEventListener('click', go);
        card.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      } else {
        title.textContent = it.sp.title || 'Scratchpad';
        card.dataset.scratchpadId = it.sp.scratchpad_id;
        card.appendChild(title);
        const go = () => {
          close();
          if (window.WriteSysScratchpadModal) window.WriteSysScratchpadModal.open(it.sp.scratchpad_id, { noteId });
        };
        card.addEventListener('click', go);
        card.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      }
      grid.appendChild(card);
    });
    return grid;
  }

  async function open(noteId, opts = {}) {
    close();
    const A = api();
    const W = window.WriteSysNoteWidget;
    if (!A || !W) return;
    let note, placements;
    try {
      [note, placements] = await Promise.all([A.get(noteId), A.placements(noteId)]);
    } catch (e) { return; }
    if (!note) return;
    note.note_id = note.note_id || noteId;
    current = noteId;
    overlay = document.createElement('div');
    overlay.className = 'nm-overlay';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    const box = document.createElement('div');
    box.className = 'nm-box';
    const noteHost = document.createElement('div');
    noteHost.className = 'nm-note';
    box.appendChild(noteHost);
    box.appendChild(placementCards(noteId, placements || {}));
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    rerender(note, noteHost);
    document.addEventListener('keydown', onKey, true);
    if (opts.focus !== false) {
      const ta = noteHost.querySelector('.note-input');
      if (ta) ta.focus();
    }
  }

  window.WriteSysNoteModal = { open, close, _cols: cols };
})();
