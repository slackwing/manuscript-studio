// The tab bar — the row under the top bar, on every logged-in page, ALWAYS
// visible: Home first (uncloseable — it's the landing page, not a pin),
// then one tab per pin, each with its own ×. A pinned pad renders as that
// tab's page — filling the space BELOW the header and strip (spm-tabbed;
// there is no full-screen mode). Manuscripts auto-pin on open. Pinning
// happens from the pad modal's pin button and the book strip's pin button
// (manuscripts and scratchpads only; notes' "See all" is a landing view,
// not a place). Pins live in localStorage: switching between tabs never
// routes through a card grid.
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
  const onHomePage = () => /home\.html$/.test(location.pathname);
  // WriteSysScratchpadModal starts as a lazy-loader shim (scratchpad-modal.js)
  // that only grows currentId/close once the real module loads — and nothing
  // can be open before that.
  const modal = () => window.WriteSysScratchpadModal || null;
  const openPadId = () => {
    const m = modal();
    return (m && typeof m.currentId === 'function' && m.currentId()) || 0;
  };
  const closePad = () => {
    const m = modal();
    if (m && typeof m.close === 'function') m.close();
  };
  const isPinned = (type, id) => read().some((p) => p.type === type && p.id === id);

  const pin = (type, id, name) => {
    if (!id || isPinned(type, id)) return;
    write([...read(), { type, id, name: name || (type === 'manuscript' ? 'Manuscript' : 'Untitled') }]);
  };
  const unpin = (type, id) => write(read().filter((p) => !(p.type === type && p.id === id)));
  const toggle = (type, id, name) => (isPinned(type, id) ? unpin(type, id) : pin(type, id, name));

  const goHome = () => {
    if (!onHomePage()) { location.href = 'home.html'; return; }
    if (openPadId()) closePad();
  };

  const go = (p) => {
    if (p.type === 'manuscript') {
      if (p.id === bookId()) { if (openPadId()) closePad(); return; }
      location.href = './?manuscript_id=' + p.id;
    } else if (modal()) {
      if (p.id === openPadId()) return; // already looking at it
      modal().open(p.id);
    } else {
      location.href = 'home.html#scratchpad=' + p.id;
    }
  };

  // Closing a tab (×) closes what it shows: an open pad's modal closes with
  // its tab; the manuscript you're reading sends you back to the landing page.
  const closeTab = (p) => {
    const wasOpenPad = p.type === 'scratchpad' && p.id === openPadId();
    const wasCurrentBook = p.type === 'manuscript' && p.id === bookId();
    unpin(p.type, p.id);
    if (wasOpenPad) closePad();
    if (wasCurrentBook) location.href = 'home.html';
  };

  const render = () => {
    const host = document.getElementById('ms-tabs');
    if (!host) return;
    const pins = read();
    // The tab bar is ALWAYS there (Home anchors it, uncloseable) — no
    // appearing/disappearing chrome, no full-screen anything.
    document.documentElement.classList.add('has-ms-tabs');
    host.hidden = false;
    host.replaceChildren();
    const controls = document.getElementById('controls');
    if (controls) {
      const h = Math.round(controls.getBoundingClientRect().height);
      host.style.top = h + 'px';
      // Where the fixed chrome ends — a pinned pad's page starts here so the
      // header and strip always stay visible (CSS carries a static fallback).
      document.documentElement.style.setProperty('--ms-chrome-b', (h + 30) + 'px'); // 30 = strip height (chrome.css)
    }

    const mkTab = (cls, name, active, onClick) => {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'ms-tab ' + cls + (active ? ' active' : '');
      tab.title = name;
      const label = document.createElement('span');
      label.className = 'ms-tab-label';
      label.textContent = name;
      tab.appendChild(label);
      tab.addEventListener('click', onClick);
      host.appendChild(tab);
      return tab;
    };

    // The landing page anchors the row (not itself a pin — no ×): active
    // when nothing else is on top of it.
    mkTab('ms-tab-home', 'Home', onHomePage() && !openPadId(), goHome);

    pins.forEach((p) => {
      const active = p.type === 'manuscript'
        ? (p.id === bookId() && !openPadId())
        : p.id === openPadId();
      const tab = mkTab('ms-tab-' + p.type, p.name, active, () => go(p));
      const x = document.createElement('span');
      x.className = 'ms-tab-x';
      x.title = 'Close';
      x.textContent = '×';
      x.addEventListener('click', (e) => { e.stopPropagation(); closeTab(p); });
      tab.appendChild(x);
    });
    // Book-page pin button reflects the current manuscript's pin state.
    const pinBtn = document.getElementById('mc-pin');
    if (pinBtn) pinBtn.classList.toggle('pinned', isPinned('manuscript', bookId()));
  };

  // Cross-tab sync + late layout (fonts can nudge the header height) +
  // active-tab tracking as pads open and close.
  window.addEventListener('storage', (e) => { if (e.key === KEY) render(); });
  window.addEventListener('resize', render);
  window.addEventListener('scratchpad-modal-opened', render);
  window.addEventListener('scratchpad-modal-closed', render);

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
