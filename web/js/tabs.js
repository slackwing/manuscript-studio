// The tab bar + its LIVE PANELS — real, stateful tabs.
//
// home.html is the SHELL: Home is the landing page itself, and every pin
// (manuscript or scratchpad) gets a PANEL — a same-origin iframe below the
// chrome that is created on first activation and then KEPT ALIVE. Switching
// tabs only flips which panel is visible; nothing reloads, scroll and
// editor state survive. Panels host the existing pages (./?manuscript_id=N,
// pad.html?scratchpad_id=N); framed pages detect the embed and hide their
// own chrome (html.embedded — see book.css) and skip auto-pin.
//
// Outside the shell (a standalone book page from an old link, settings),
// the bar still renders but tab clicks travel to the shell
// (home.html#tab=<key>) — state lives in ONE place.
//
// The bar is ALWAYS visible: Home first (uncloseable — it's the landing
// page, not a pin), then one tab per pin, each with its own ×. × closes
// what it shows: the panel is destroyed (pads flush their save first).
// Pins live in localStorage. Manuscripts auto-pin on a standalone visit;
// pads pin from the modal's pin button (pinning turns the modal into a
// panel). There is no full-screen mode.
window.WriteSysTabs = (function () {
  const KEY = 'ms_pinned_tabs';
  // Inside a panel iframe: no bar, no auto-pin, page hides its own chrome.
  const EMBED = (() => { try { return window.self !== window.top; } catch (e) { return true; } })();
  if (EMBED) document.documentElement.classList.add('embedded');

  const read = () => {
    try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch (e) { return []; }
  };
  const write = (tabs) => {
    localStorage.setItem(KEY, JSON.stringify(tabs));
    render();
  };

  const bookId = () => parseInt(new URLSearchParams(location.search).get('manuscript_id'), 10) || null;
  const onHomePage = () => /home\.html$/.test(location.pathname);
  const SHELL = !EMBED && onHomePage();
  const keyOf = (p) => p.type[0] + p.id; // 'm42' / 's7877'
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
  const findPin = (type, id) => read().find((p) => p.type === type && p.id === id);

  const pin = (type, id, name) => {
    if (!id || isPinned(type, id)) return;
    write([...read(), { type, id, name: name || (type === 'manuscript' ? 'Manuscript' : 'Untitled') }]);
  };
  const unpin = (type, id) => write(read().filter((p) => !(p.type === type && p.id === id)));
  const toggle = (type, id, name) => (isPinned(type, id) ? unpin(type, id) : pin(type, id, name));
  const rename = (type, id, name) => {
    const tabs = read();
    const t = tabs.find((p) => p.type === type && p.id === id);
    if (t && name && t.name !== name) { t.name = name; write(tabs); }
  };

  // ---- panels (shell only): one kept-alive iframe per activated pin ------
  let activeKey = null; // null = Home
  const panels = new Map(); // key → iframe

  const panelsHost = () => {
    let host = document.getElementById('ms-tab-panels');
    if (!host) {
      host = document.createElement('div');
      host.id = 'ms-tab-panels';
      host.hidden = true;
      document.body.appendChild(host);
    }
    return host;
  };

  const panelSrc = (p) => (p.type === 'manuscript'
    ? './?manuscript_id=' + p.id
    : 'pad.html?scratchpad_id=' + p.id);

  const activate = (key) => {
    if (!SHELL) return;
    if (openPadId()) closePad(); // a windowed modal never sits over a panel
    activeKey = key || null;
    const host = panelsHost();
    if (activeKey) {
      const p = read().find((q) => keyOf(q) === activeKey);
      if (!p) { activeKey = null; host.hidden = true; render(); return; }
      let frame = panels.get(activeKey);
      if (!frame) {
        frame = document.createElement('iframe');
        frame.className = 'ms-panel';
        frame.src = panelSrc(p);
        panels.set(activeKey, frame);
        host.appendChild(frame);
      }
      host.hidden = false;
      panels.forEach((f, k) => f.classList.toggle('active', k === activeKey));
    } else {
      host.hidden = true;
    }
    const url = new URL(location.href);
    url.hash = activeKey ? 'tab=' + activeKey : '';
    history.replaceState(null, '', url);
    render();
  };

  // Destroy a panel; a live pad flushes its save first (same-origin reach-in).
  const destroyPanel = async (key) => {
    const frame = panels.get(key);
    if (!frame) return;
    panels.delete(key);
    try {
      const ed = frame.contentWindow && frame.contentWindow.WriteSysScratchpad;
      if (ed && typeof ed.saveNow === 'function') await ed.saveNow();
    } catch (e) { /* cross-frame teardown races are non-fatal */ }
    frame.remove();
  };

  // ---- opening things as tabs --------------------------------------------
  const openTab = (type, id, name) => {
    pin(type, id, name);
    if (SHELL) activate(type[0] + id);
    else location.href = 'home.html#tab=' + type[0] + id;
  };
  const openManuscript = (id, name) => openTab('manuscript', id, name);
  const openPad = (id, name) => openTab('scratchpad', id, name);

  const goHome = () => {
    if (SHELL) { activate(null); return; }
    location.href = 'home.html';
  };

  const go = (p) => {
    if (SHELL) { activate(keyOf(p)); return; }
    if (p.type === 'manuscript' && p.id === bookId()) { if (openPadId()) closePad(); return; }
    location.href = 'home.html#tab=' + keyOf(p);
  };

  // Closing a tab (×) closes what it shows: its panel is destroyed (pads
  // flush first); on a standalone book page, closing your own tab goes home.
  const closeTab = (p) => {
    const k = keyOf(p);
    unpin(p.type, p.id);
    if (SHELL) {
      destroyPanel(k);
      if (activeKey === k) activate(null);
      return;
    }
    if (p.type === 'scratchpad' && p.id === openPadId()) closePad();
    if (p.type === 'manuscript' && p.id === bookId()) location.href = 'home.html';
  };

  const render = () => {
    if (EMBED) return; // panels have no bar of their own
    const host = document.getElementById('ms-tabs');
    if (!host) return;
    const pins = read();
    // The tab bar is ALWAYS there (Home anchors it, uncloseable).
    document.documentElement.classList.add('has-ms-tabs');
    host.hidden = false;
    host.replaceChildren();
    const controls = document.getElementById('controls');
    if (controls) {
      const h = Math.round(controls.getBoundingClientRect().height);
      host.style.top = h + 'px';
      // Where the fixed chrome ends — panels start here (CSS has a static
      // fallback so a late measurement can never swallow the header).
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

    const homeActive = SHELL ? (!activeKey && !openPadId()) : onHomePage();
    mkTab('ms-tab-home', 'Home', homeActive, goHome);

    pins.forEach((p) => {
      const active = SHELL
        ? activeKey === keyOf(p)
        : (p.type === 'manuscript' ? p.id === bookId() && !openPadId() : p.id === openPadId());
      const tab = mkTab('ms-tab-' + p.type, p.name, active, () => go(p));
      const x = document.createElement('span');
      x.className = 'ms-tab-x';
      x.title = 'Close';
      x.textContent = '×';
      x.addEventListener('click', (e) => { e.stopPropagation(); closeTab(p); });
      tab.appendChild(x);
    });
  };

  if (!EMBED) {
    // Cross-tab sync + late layout (fonts can nudge the header height) +
    // active-tab tracking as (unpinned, windowed) pads open and close.
    window.addEventListener('storage', (e) => { if (e.key === KEY) render(); });
    window.addEventListener('resize', render);
    window.addEventListener('scratchpad-modal-opened', render);
    window.addEventListener('scratchpad-modal-closed', render);
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (EMBED) return;
    if (SHELL) {
      // Manuscript cards open IN PLACE as live panels — never a navigation.
      document.addEventListener('click', (e) => {
        const card = e.target.closest && e.target.closest('a.card-manuscript');
        if (!card) return;
        const id = parseInt((new URL(card.href, location.href)).searchParams.get('manuscript_id'), 10);
        if (!id) return;
        e.preventDefault();
        const name = (card.querySelector('.card-title') || {}).textContent || 'Manuscript';
        openManuscript(id, name.trim());
      }, true);
      // Restore the active tab across reloads (#tab=m42 / #tab=s7877).
      const m = (location.hash || '').match(/[#&]tab=([ms]\d+)/);
      if (m && read().some((p) => keyOf(p) === m[1])) activate(m[1]);
      return;
    }
    // Standalone book page (old link): opening a manuscript IS opening a
    // tab, so the visit pins it. The display name lands async (renderer's
    // setName retry loop); follow it.
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

  return { pin, unpin, toggle, rename, isPinned, render, openManuscript, openPad, activate };
})();
