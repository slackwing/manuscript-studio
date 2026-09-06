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
// SPLIT PANE (SPLIT_PANE_PLAN.md): the shell can split the panel area into
// LEFT and RIGHT panes, each with its own tab bar. The split button at the
// strip's right end moves the focused tab right; tabs drag between bars;
// the last right tab leaving (drag or ×) collapses the split. Panels NEVER
// reparent (that reloads an iframe) — pane assignment is a class, position
// is CSS off --split-x. Each pane is its own iframe viewport, so the framed
// pages' 1239px mobile breakpoint fires per pane for free. Home is the
// shell page itself, so it lives in the left pane only and never drags.
//
// Outside the shell (a standalone book page from an old link, settings),
// the bar still renders but tab clicks travel to the shell
// (home.html#tab=<key>) — state lives in ONE place.
//
// The bar is ALWAYS visible: Home first (uncloseable — it's the landing
// page, not a pin), then one tab per pin, each with its own ×. × closes
// what it shows: the panel is destroyed (pads flush their save first).
// Pins live in localStorage (shared across browser tabs); the split layout
// (right-pane keys + divider) does too. Which tab is active in each pane
// and which pane has focus are PER-BROWSER-TAB (sessionStorage) — two
// browser tabs may focus different documents. There is no full-screen mode.
window.WriteSysTabs = (function () {
  const KEY = 'ms_pinned_tabs';
  const SPLIT_KEY = 'ms_split'; // { right: [keys], dividerPct } — shared layout
  const SESSION_KEY = 'ms_split_session'; // { leftActive, rightActive, focused }
  const MIN_PANE = 480; // px — divider clamp
  // Inside a panel iframe: no bar, no auto-pin, page hides its own chrome.
  const EMBED = (() => { try { return window.self !== window.top; } catch (e) { return true; } })();
  if (EMBED) document.documentElement.classList.add('embedded');

  const read = () => {
    try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch (e) { return []; }
  };
  const write = (tabs) => {
    localStorage.setItem(KEY, JSON.stringify(tabs));
    reconcileSplit();
    render();
  };

  const splitRead = () => {
    try {
      const s = JSON.parse(localStorage.getItem(SPLIT_KEY)) || {};
      return { right: Array.isArray(s.right) ? s.right : [], dividerPct: +s.dividerPct || 50 };
    } catch (e) { return { right: [], dividerPct: 50 }; }
  };
  const splitWrite = (s) => localStorage.setItem(SPLIT_KEY, JSON.stringify(s));
  const isSplit = () => splitRead().right.length > 0;
  const paneOf = (key) => (splitRead().right.includes(key) ? 'right' : 'left');

  const bookId = () => parseInt(new URLSearchParams(location.search).get('manuscript_id'), 10) || null;
  const onHomePage = () => /home\.html$/.test(location.pathname);
  const SHELL = !EMBED && onHomePage();
  const keyOf = (p) => p.type[0] + p.id; // 'm42' / 's7877'
  const findByKey = (key) => read().find((p) => keyOf(p) === key);
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
  const rename = (type, id, name) => {
    const tabs = read();
    const t = tabs.find((p) => p.type === type && p.id === id);
    if (t && name && t.name !== name) { t.name = name; write(tabs); }
  };

  // ---- per-browser-tab pane state (shell only) ---------------------------
  let leftActive = null; // key | null (null = Home)
  let rightActive = null; // key | null (null = unsplit)
  let focused = 'left'; // which pane keyboard/opens target
  const mru = []; // keys, most recent first — "next most recent" fallbacks
  const touchMru = (key) => {
    if (!key) return;
    const i = mru.indexOf(key);
    if (i >= 0) mru.splice(i, 1);
    mru.unshift(key);
    if (mru.length > 24) mru.pop();
  };
  const mruFallback = (pane, exclude) => {
    const ok = (k) => k && k !== exclude && findByKey(k) && (!isSplit() || paneOf(k) === pane);
    const hit = mru.find(ok);
    if (hit) return hit;
    const pool = read().map(keyOf).filter(ok);
    return pool[0] || null;
  };
  const saveSession = () => {
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify({ leftActive, rightActive, focused })); } catch (e) { /* private mode */ }
  };
  const loadSession = () => {
    try {
      const s = JSON.parse(sessionStorage.getItem(SESSION_KEY)) || {};
      leftActive = s.leftActive || null;
      rightActive = s.rightActive || null;
      focused = s.focused === 'right' ? 'right' : 'left';
    } catch (e) { /* defaults stand */ }
  };
  // Derived state can go stale (another browser tab unpinned or moved a
  // tab, a pin vanished): prune the right set to live pins, then re-seat
  // any active that no longer sits in its pane.
  const reconcileSplit = () => {
    const s = splitRead();
    const live = s.right.filter((k) => !!findByKey(k));
    if (live.length !== s.right.length) splitWrite({ right: live, dividerPct: s.dividerPct });
    if (!live.length) { rightActive = null; if (focused === 'right') focused = 'left'; }
    else if (!rightActive || paneOf(rightActive) !== 'right') rightActive = mruFallback('right');
    // A vacated LEFT pane falls back to Home (the landing page is its
    // resting state); only the right pane MRU-hops, since it has no Home.
    if (leftActive && (!findByKey(leftActive) || paneOf(leftActive) === 'right')) leftActive = null;
    saveSession();
  };
  const focusedActive = () => (focused === 'right' ? rightActive : leftActive);
  const setFocus = (pane) => {
    if (!SHELL || focused === pane || (pane === 'right' && !isSplit())) return;
    focused = pane;
    updateHash();
    saveSession();
    render();
  };

  // ---- panels (shell only): one kept-alive iframe per activated pin ------
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

  const ensureFrame = (key) => {
    if (!key || panels.has(key)) return;
    const p = findByKey(key);
    if (!p) return;
    const frame = document.createElement('iframe');
    frame.className = 'ms-panel';
    frame.src = panelSrc(p);
    // Clicks inside an iframe never bubble out — reach in (same-origin) so
    // interacting with a pane focuses it. Pane is computed at event time
    // (the tab may have been dragged across since load).
    frame.addEventListener('load', () => {
      try {
        frame.contentWindow.addEventListener('pointerdown', () => setFocus(isSplit() ? paneOf(key) : 'left'));
      } catch (e) { /* teardown race */ }
    });
    panels.set(key, frame);
    panelsHost().appendChild(frame);
  };

  // Position everything from state. Panels never move in the DOM — only
  // classes flip. When Home shows in the left pane the host shrinks to the
  // right region (.home-left) so the landing page stays interactive.
  const applyLayout = () => {
    if (!SHELL) return;
    const host = panelsHost();
    const s = splitRead();
    const split = s.right.length > 0;
    document.documentElement.classList.toggle('ms-split', split);
    document.documentElement.style.setProperty('--split-x', s.dividerPct + 'vw');
    ensureFrame(leftActive);
    ensureFrame(rightActive);
    host.classList.toggle('split', split);
    host.classList.toggle('home-left', split && !leftActive);
    host.hidden = !split && !leftActive;
    panels.forEach((f, k) => {
      f.classList.toggle('pane-right', split && paneOf(k) === 'right');
      f.classList.toggle('active', k === leftActive || (split && k === rightActive));
    });
    ensureDivider(split);
  };

  const updateHash = () => {
    const url = new URL(location.href);
    const k = focusedActive();
    url.hash = k ? 'tab=' + k : '';
    history.replaceState(null, '', url);
  };

  const activate = (key) => {
    if (!SHELL) return;
    if (openPadId()) closePad(); // a windowed modal never sits over a panel
    if (!key) { leftActive = null; focused = 'left'; }
    else {
      const p = findByKey(key);
      if (!p) { leftActive = null; focused = 'left'; applyLayout(); updateHash(); render(); return; }
      const pane = isSplit() ? paneOf(key) : 'left';
      if (pane === 'right') rightActive = key; else leftActive = key;
      focused = pane;
      touchMru(key);
    }
    applyLayout();
    updateHash();
    saveSession();
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

  // ---- splitting ---------------------------------------------------------
  // Eligible only when the focused tab is a pin (Home never splits) and
  // another pin remains for the left pane to fall back to.
  const canSplit = () => SHELL && !isSplit() && !!leftActive && read().length >= 2;
  const doSplit = () => {
    if (!canSplit()) return;
    const key = leftActive;
    splitWrite({ right: [key], dividerPct: splitRead().dividerPct });
    rightActive = key;
    leftActive = mruFallback('left', key); // next most recent stays left
    focused = 'right';
    applyLayout();
    updateHash();
    saveSession();
    render();
  };
  const unsplit = (keepLeft) => {
    splitWrite({ right: [], dividerPct: splitRead().dividerPct });
    if (keepLeft) { leftActive = keepLeft; touchMru(keepLeft); }
    rightActive = null;
    focused = 'left';
    applyLayout();
    updateHash();
    saveSession();
    render();
  };

  // ---- divider -----------------------------------------------------------
  let dividerPending = 0;
  const ensureDivider = (split) => {
    let d = document.getElementById('ms-split-divider');
    if (!split) { if (d) d.remove(); return; }
    if (d) return;
    d = document.createElement('div');
    d.id = 'ms-split-divider';
    d.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { d.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointers can't capture */ }
      // Iframes swallow pointermove — freeze them for the drag's duration.
      document.documentElement.classList.add('ms-divider-drag');
      dividerPending = splitRead().dividerPct;
    });
    d.addEventListener('pointermove', (e) => {
      if (!document.documentElement.classList.contains('ms-divider-drag')) return;
      const px = Math.min(Math.max(e.clientX, MIN_PANE), window.innerWidth - MIN_PANE);
      dividerPending = (px / window.innerWidth) * 100;
      document.documentElement.style.setProperty('--split-x', dividerPending + 'vw');
    });
    d.addEventListener('pointerup', () => {
      document.documentElement.classList.remove('ms-divider-drag');
      const s = splitRead();
      splitWrite({ right: s.right, dividerPct: dividerPending || s.dividerPct });
      render(); // bar widths track the seam
    });
    d.addEventListener('dblclick', () => {
      const s = splitRead();
      splitWrite({ right: s.right, dividerPct: 50 });
      applyLayout();
      render();
    });
    document.body.appendChild(d);
  };

  // ---- tab drag & drop (the people.js live-reorder pattern) --------------
  let dragKey = null;
  const wireTabDrag = (tab, key) => {
    tab.draggable = true;
    tab.dataset.key = key;
    tab.addEventListener('dragstart', (e) => {
      dragKey = key;
      tab.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', key); } catch (err) { /* IE-ism */ }
    });
    tab.addEventListener('dragend', () => {
      tab.classList.remove('dragging');
      if (dragKey) commitDrag();
      dragKey = null;
    });
  };
  const wireBarDrop = (bar) => {
    bar.addEventListener('dragover', (e) => {
      if (!dragKey) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const dragged = bar.closest('#ms-tabs').querySelector('.ms-tab.dragging');
      if (!dragged) return;
      const target = e.target.closest('.ms-tab');
      if (!target || target === dragged) {
        if (!target && dragged.parentElement !== bar) bar.appendChild(dragged);
        return;
      }
      if (target.classList.contains('ms-tab-home')) { // nothing lands before Home
        if (target.nextSibling !== dragged) target.after(dragged);
        return;
      }
      const r = target.getBoundingClientRect();
      const before = e.clientX < r.left + r.width / 2;
      if (before && target.previousSibling !== dragged) bar.insertBefore(dragged, target);
      else if (!before && target.nextSibling !== dragged) bar.insertBefore(dragged, target.nextSibling);
    });
    bar.addEventListener('drop', (e) => { if (dragKey) e.preventDefault(); });
  };
  // The DOM is the drag's source of truth: read both bars back into pin
  // order + the right set, then re-seat actives if the tab changed panes.
  const commitDrag = () => {
    const strip = document.getElementById('ms-tabs');
    if (!strip) return;
    const bars = [...strip.querySelectorAll('.ms-tabbar')];
    const keysIn = (bar) => (bar ? [...bar.querySelectorAll('.ms-tab[data-key]')].map((t) => t.dataset.key) : []);
    const leftKeys = keysIn(bars[0]);
    const rightKeys = keysIn(bars[1]);
    const wasPane = paneOf(dragKey);
    const pins = read();
    const byKey = new Map(pins.map((p) => [keyOf(p), p]));
    const ordered = [...leftKeys, ...rightKeys].map((k) => byKey.get(k)).filter(Boolean);
    if (ordered.length !== pins.length) { render(); return; } // lost one — bail, re-render truth
    const s = splitRead();
    const wasSplit = s.right.length > 0;
    localStorage.setItem(KEY, JSON.stringify(ordered));
    splitWrite({ right: rightKeys, dividerPct: s.dividerPct });
    if (wasSplit && !rightKeys.length) { unsplit(dragKey); return; } // last tab moved over
    const nowPane = rightKeys.includes(dragKey) ? 'right' : 'left';
    if (nowPane !== wasPane) {
      if (nowPane === 'right') { rightActive = dragKey; if (leftActive === dragKey) leftActive = mruFallback('left', dragKey); }
      else { leftActive = dragKey; if (rightActive === dragKey) rightActive = mruFallback('right', dragKey); }
      focused = nowPane;
      touchMru(dragKey);
    }
    reconcileSplit();
    applyLayout();
    updateHash();
    saveSession();
    render();
  };

  // ---- opening things as tabs --------------------------------------------
  const openTab = (type, id, name) => {
    const existed = isPinned(type, id);
    pin(type, id, name);
    const key = type[0] + id;
    // A NEW tab lands in the focused pane; an existing one stays put.
    if (SHELL && !existed && isSplit() && focused === 'right') {
      const s = splitRead();
      splitWrite({ right: [...s.right, key], dividerPct: s.dividerPct });
    }
    if (SHELL) activate(key);
    else location.href = 'home.html#tab=' + key;
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
  // flush first); the pane falls back to its next most recent tab — the
  // right pane collapsing the split when its last tab goes. On a
  // standalone book page, closing your own tab goes home.
  const closeTab = (p) => {
    const k = keyOf(p);
    const i = mru.indexOf(k);
    if (i >= 0) mru.splice(i, 1);
    unpin(p.type, p.id); // write() prunes the right set + re-seats actives
    if (SHELL) {
      destroyPanel(k);
      reconcileSplit();
      applyLayout();
      updateHash();
      saveSession();
      render();
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
    const split = SHELL && isSplit();
    // The tab bar is ALWAYS there (Home anchors it, uncloseable).
    document.documentElement.classList.add('has-ms-tabs');
    host.hidden = false;
    host.replaceChildren();
    host.classList.toggle('split', split);
    const controls = document.getElementById('controls');
    if (controls) {
      const h = Math.round(controls.getBoundingClientRect().height);
      host.style.top = h + 'px';
      // Where the fixed chrome ends — panels start here (CSS has a static
      // fallback so a late measurement can never swallow the header).
      document.documentElement.style.setProperty('--ms-chrome-b', (h + 36) + 'px'); // 36 = strip height (chrome.css)
    }

    const mkTab = (bar, cls, name, active, onClick) => {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'ms-tab ' + cls + (active ? ' active' : '');
      tab.title = name;
      const label = document.createElement('span');
      label.className = 'ms-tab-label';
      label.textContent = name;
      tab.appendChild(label);
      tab.addEventListener('click', onClick);
      bar.appendChild(tab);
      return tab;
    };
    const mkPinTab = (bar, p, active) => {
      const tab = mkTab(bar, 'ms-tab-' + p.type, p.name, active, () => go(p));
      const x = document.createElement('span');
      x.className = 'ms-tab-x';
      x.title = 'Close';
      x.textContent = '×';
      x.addEventListener('click', (e) => { e.stopPropagation(); closeTab(p); });
      tab.appendChild(x);
      if (SHELL) wireTabDrag(tab, keyOf(p));
      return tab;
    };
    const mkBar = (side) => {
      const bar = document.createElement('div');
      bar.className = 'ms-tabbar ms-tabbar-' + side
        + (split ? (focused === side ? ' focused' : ' unfocused') : '');
      host.appendChild(bar);
      if (SHELL) wireBarDrop(bar);
      return bar;
    };

    const leftBar = mkBar('left');
    const homeActive = SHELL ? (!leftActive && !openPadId()) : onHomePage();
    mkTab(leftBar, 'ms-tab-home', 'Home', homeActive, goHome);

    const activeOf = (p) => {
      if (!SHELL) {
        return p.type === 'manuscript' ? p.id === bookId() && !openPadId() : p.id === openPadId();
      }
      const k = keyOf(p);
      return split ? (k === leftActive || k === rightActive) : k === leftActive;
    };
    pins.filter((p) => !split || paneOf(keyOf(p)) === 'left')
      .forEach((p) => mkPinTab(leftBar, p, activeOf(p)));
    if (split) {
      const rightBar = mkBar('right');
      pins.filter((p) => paneOf(keyOf(p)) === 'right')
        .forEach((p) => mkPinTab(rightBar, p, activeOf(p)));
    }

    // Split button: shell-only, hidden while split (the split ends by
    // dragging or closing the right pane's last tab, not by a button).
    if (SHELL && !split) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'ms-split-btn';
      btn.title = 'Split right';
      btn.disabled = !canSplit();
      btn.innerHTML = (window.WriteSysIcons && window.WriteSysIcons.splitPane)
        ? window.WriteSysIcons.splitPane(13) : '';
      btn.addEventListener('click', doSplit);
      host.appendChild(btn);
    }
  };

  if (!EMBED) {
    // Cross-tab sync + late layout (fonts can nudge the header height) +
    // active-tab tracking as (unpinned, windowed) pads open and close.
    window.addEventListener('storage', (e) => {
      if (e.key !== KEY && e.key !== SPLIT_KEY) return;
      if (SHELL) { reconcileSplit(); applyLayout(); }
      render();
    });
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
      // Clicking the landing page focuses the left pane.
      document.addEventListener('pointerdown', (e) => {
        if (e.target.closest && (e.target.closest('#ms-tabs') || e.target.closest('#ms-split-divider'))) return;
        setFocus('left');
      });
      // Restore: split layout from localStorage, pane actives from this
      // browser tab's session, then let #tab=m42 (link compat) win focus.
      loadSession();
      reconcileSplit();
      const m = (location.hash || '').match(/[#&]tab=([ms]\d+)/);
      if (m && read().some((p) => keyOf(p) === m[1])) activate(m[1]);
      [leftActive, rightActive].forEach((k) => touchMru(k));
      applyLayout();
      render(); // icons.js has loaded by now — the split button gets its glyph
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
