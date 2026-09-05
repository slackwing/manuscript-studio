// Pinned tabs — the row under the top bar, on every logged-in page.
// Pinning happens from the pad modal's pin button and the book strip's pin
// button (manuscripts and scratchpads only; notes' "See all" is a landing
// view, not a place). Pins live in localStorage: switching between a book
// and a pad no longer routes through the landing page.
//
// chrome.js renders the empty #ms-tabs shell right under #controls; this
// file (loaded after it on every page) owns state + rendering. The row
// occupies layout only when pins exist: html.has-ms-tabs flips the shared
// --tabs-h variable that every fixed-top rule adds on.
window.WriteSysTabs = (function () {
  const KEY = 'ms_pinned_tabs';

  const read = () => {
    try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch (e) { return []; }
  };
  const write = (tabs) => {
    localStorage.setItem(KEY, JSON.stringify(tabs));
    render();
  };

  const bookId = () => parseInt(new URLSearchParams(location.search).get('manuscript_id'), 10) || null;
  const isPinned = (type, id) => read().some((p) => p.type === type && p.id === id);

  const pin = (type, id, name) => {
    if (!id || isPinned(type, id)) return;
    write([...read(), { type, id, name: name || (type === 'manuscript' ? 'Manuscript' : 'Untitled') }]);
  };
  const unpin = (type, id) => write(read().filter((p) => !(p.type === type && p.id === id)));
  const toggle = (type, id, name) => (isPinned(type, id) ? unpin(type, id) : pin(type, id, name));

  const go = (p) => {
    if (p.type === 'manuscript') {
      if (p.id === bookId()) return; // already reading it
      location.href = './?manuscript_id=' + p.id;
    } else if (window.WriteSysScratchpadModal) {
      window.WriteSysScratchpadModal.open(p.id);
    } else {
      location.href = 'home.html#scratchpad=' + p.id;
    }
  };

  const render = () => {
    const host = document.getElementById('ms-tabs');
    if (!host) return;
    const tabs = read();
    document.documentElement.classList.toggle('has-ms-tabs', tabs.length > 0);
    host.hidden = !tabs.length;
    host.replaceChildren();
    const controls = document.getElementById('controls');
    if (controls) host.style.top = Math.round(controls.getBoundingClientRect().height) + 'px';
    tabs.forEach((p) => {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'ms-tab ms-tab-' + p.type
        + (p.type === 'manuscript' && p.id === bookId() ? ' active' : '');
      tab.title = p.name;
      const label = document.createElement('span');
      label.className = 'ms-tab-label';
      label.textContent = p.name;
      const x = document.createElement('span');
      x.className = 'ms-tab-x';
      x.title = 'Unpin';
      x.textContent = '×';
      x.addEventListener('click', (e) => { e.stopPropagation(); unpin(p.type, p.id); });
      tab.append(label, x);
      tab.addEventListener('click', () => go(p));
      host.appendChild(tab);
    });
    // Book-page pin button reflects the current manuscript's pin state.
    const pinBtn = document.getElementById('mc-pin');
    if (pinBtn) pinBtn.classList.toggle('pinned', isPinned('manuscript', bookId()));
  };

  // Cross-tab sync + late layout (fonts can nudge the header height).
  window.addEventListener('storage', (e) => { if (e.key === KEY) render(); });
  window.addEventListener('resize', render);

  // Book strip pin button (present on index.html only).
  document.addEventListener('DOMContentLoaded', () => {
    const pinBtn = document.getElementById('mc-pin');
    if (pinBtn) {
      pinBtn.addEventListener('click', () => {
        const name = (document.getElementById('mc-name') || {}).textContent || 'Manuscript';
        toggle('manuscript', bookId(), name.trim());
      });
    }
    // Manuscripts don't open in a modal — opening one IS opening a tab,
    // so the visit pins it (pads pin explicitly from their modal). The
    // display name lands async (renderer's setName retry loop); follow it.
    const id = bookId();
    const nameEl = document.getElementById('mc-name');
    if (id && nameEl) {
      const nameNow = () => (nameEl.textContent || '').trim();
      if (!isPinned('manuscript', id)) pin('manuscript', id, nameNow() || 'Manuscript');
      new MutationObserver(() => {
        const tabs = read();
        const t = tabs.find((p) => p.type === 'manuscript' && p.id === id);
        if (t && nameNow() && t.name !== nameNow()) { t.name = nameNow(); write(tabs); }
      }).observe(nameEl, { childList: true, characterData: true, subtree: true });
    }
    render();
  });
  render();

  return { pin, unpin, toggle, isPinned, render };
})();
