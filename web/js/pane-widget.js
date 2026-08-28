/**
 * WriteSysPaneWidget — the ONE two-pane widget shell, shared by the sketch
 * widget (sketch-view.mjs, via window.*) and the suggest-edit modal
 * (suggestions.js). Classic script on purpose: both module worlds can
 * reach it.
 *
 * The unified geometry (2026-08-22 design round):
 *   [ sn-header: caller HTML · save · action slot ]
 *   [ left pane: main | rail ][ right pane: main | rail ]
 * - The LEFT pane always shows; its rail selects what the left main
 *   displays (radio — something is always selected).
 * - The RIGHT pane is collapsible: clicking a right-rail button opens it
 *   (or switches targets); re-clicking the selected one closes it. While
 *   collapsed only its rail shows, flush against the left pane's rail —
 *   two vertical bars. `right.openByDefault` says which way it starts
 *   (sketch: closed; suggest modal: open).
 * - Subject ACTIONS are icon buttons with hover titles. Two kinds:
 *   STATE buttons carry a `color` and read pressed/tinted while
 *   `active()` (freeze-blue, accept-green, reject-red — all one
 *   mechanism); plain buttons just run their lambda. Each pane's actions
 *   live in ITS OWN action row, collapsed or not — the header never
 *   borrows them (cfg.headerActions is the only header slot).
 * - Rail entries are re-derived by lambdas on every refresh(), so labels
 *   (0↔letter), state colors, and disabled-ness stay live.
 *
 * Entry:  { key, label, title, className, color, disabled, ts }
 * - ts (optional, any Date-parseable value) timestamps what the entry
 *   SHOWS. When both selected entries carry one and the right's is newer,
 *   the right pane wears a red corner NEW — "what you're comparing
 *   against postdates the thing you're viewing." Supplying timestamps IS
 *   the enable switch; cfg.newBadgeTitle overrides its hover title.
 * Button: { icon, title, className, color, active(), onClick, disabled }
 * Both content hosts belong to the CALLER — the widget never touches what
 * is inside leftContent / rightContent, it only shows/hides the right one.
 */
window.WriteSysPaneWidget = {
  // formattedMono: a pane CONTENT-MODE controller — FORMATTED at rest,
  // monospace on click, formatted again when the mono surface blurs (the
  // sketch widget's preview↔edit rhythm, reusable). The caller supplies
  // the pieces: `render()` paints the formatted view (diff it against the
  // other pane's text for the "compare to what's over there" reading);
  // `showMono`/`hideMono` flip the caller's mono elements; `focusMono`
  // lands the caret. Wire the mono surface's blur to `.exitMono()`.
  formattedMono({ fmtEl, render, showMono, hideMono, focusMono }) {
    let mono = false;
    const sync = () => {
      fmtEl.hidden = mono;
      if (mono) {
        showMono();
      } else {
        hideMono();
        render();
      }
    };
    fmtEl.addEventListener('click', () => {
      mono = true;
      sync();
      if (focusMono) focusMono();
    });
    const ctl = {
      sync,
      isMono: () => mono,
      exitMono: () => { mono = false; sync(); },
    };
    sync();
    return ctl;
  },

  create(cfg) {
    const el = document.createElement('div');
    el.className = 'pw' + (cfg.className ? ' ' + cfg.className : '');
    el.innerHTML = `
      <div class="sn-header">
        <div class="sn-head-left">
          <span class="pw-head-slot"></span>
          <span class="sn-actions pw-header-actions"></span>
          <span class="sn-save"></span>
          <span class="pw-nav" hidden>
            <button type="button" class="pw-nav-prev" title="Previous">&lsaquo;</button>
            <span class="pw-nav-count"></span>
            <button type="button" class="pw-nav-next" title="Next">&rsaquo;</button>
          </span>
        </div>
      </div>
      <div class="sn-cols pw-cols">
        <div class="sn-pane pw-left">
          <div class="sn-main pw-main">
            <div class="sn-actionrow pw-actionrow pw-actionrow-left" hidden>
              <span class="pw-row-title"></span><span class="sn-actions"></span>
            </div>
            <div class="pw-content pw-content-left"></div>
          </div>
          <div class="sn-rail pw-rail-left"></div>
        </div>
        <div class="sn-pane pw-right">
          <div class="sn-main pw-main">
            <span class="pw-new" hidden>NEW</span>
            <div class="sn-actionrow pw-actionrow pw-actionrow-right" hidden>
              <span class="pw-row-title"></span><span class="sn-actions"></span>
            </div>
            <div class="pw-content pw-content-right"></div>
          </div>
          <div class="sn-rail pw-rail-right"></div>
        </div>
      </div>`;

    const w = {
      el,
      header: el.querySelector('.sn-header'),
      headSlot: el.querySelector('.pw-head-slot'),
      saveEl: el.querySelector('.sn-save'),
      leftContent: el.querySelector('.pw-content-left'),
      rightContent: el.querySelector('.pw-content-right'),
      leftKey: null,
      rightKey: null,
    };
    if (cfg.headerHTML) w.headSlot.innerHTML = cfg.headerHTML;

    const leftRailEl = el.querySelector('.pw-rail-left');
    const rightRailEl = el.querySelector('.pw-rail-right');
    const rightPane = el.querySelector('.pw-right');
    const headerActions = el.querySelector('.pw-header-actions');
    const leftRow = el.querySelector('.pw-actionrow-left');
    const rightRow = el.querySelector('.pw-actionrow-right');

    const mkBtn = (b) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pw-actbtn' + (b.className ? ' ' + b.className : '');
      btn.title = b.title || '';
      btn.innerHTML = b.icon || '';
      if (b.disabled) btn.disabled = true;
      if (b.color) {
        btn.style.setProperty('--pw-c', b.color);
        btn.classList.add('pw-colored');
        if (b.tint) btn.classList.add('pw-tint'); // colored at rest, not just hover
        if (b.active && b.active()) btn.classList.add('pw-on');
      }
      // Don't steal focus on mousedown: blurring the mono editor mid-click
      // re-renders the formatted view, the centered modal re-flows, and the
      // button moves out from under the cursor before mouseup — the click
      // never lands. No focus transfer → no blur → stable geometry.
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (b.onClick) b.onClick(btn);
      });
      return btn;
    };

    const mkRailBtn = (entry, active, onClick) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sn-rail-btn' + (entry.className ? ' ' + entry.className : '')
        + (active ? ' active' : '');
      btn.title = entry.title || '';
      btn.textContent = entry.label;
      if (entry.disabled) btn.disabled = true;
      if (entry.key != null) btn.dataset.key = String(entry.key);
      Object.entries(entry.data || {}).forEach(([k, v]) => { btn.dataset[k] = v; });
      if (entry.color) {
        btn.style.setProperty('--pw-c', entry.color);
        btn.classList.add('pw-colored');
      }
      btn.addEventListener('mousedown', (e) => e.preventDefault()); // see mkBtn
      btn.addEventListener('click', () => onClick(entry));
      return btn;
    };

    // Re-render a host ONLY when its derived content actually changed
    // (signature compare). A blur→re-render mid-click would otherwise
    // replace the very button being pressed and swallow the click — the
    // exact bug the old sketch widget's relocate-don't-rebuild cluster
    // existed to avoid.
    const fill = (host, btns) => {
      const sig = JSON.stringify((btns || []).map((b) => [b.icon, b.title, b.className,
        !!b.disabled, b.color || '', !!(b.active && b.active())]));
      if (host._pwSig === sig) return;
      host._pwSig = sig;
      host.replaceChildren();
      (btns || []).forEach((b) => host.appendChild(mkBtn(b)));
    };
    const fillRail = (host, entries, selectedKey, onClick) => {
      const sig = JSON.stringify([selectedKey, entries.map((e) => [e.key, e.label, e.title,
        e.className, !!e.disabled, e.color || '', e.data || null])]);
      if (host._pwSig === sig) return;
      host._pwSig = sig;
      host.replaceChildren();
      entries.forEach((entry) => host.appendChild(
        mkRailBtn(entry, entry.key === selectedKey, () => onClick(entry))));
    };

    const navEl = el.querySelector('.pw-nav');
    if (cfg.nav) {
      el.querySelectorAll('.pw-nav-prev, .pw-nav-next').forEach((b) =>
        b.addEventListener('mousedown', (e) => e.preventDefault())); // see mkBtn
      el.querySelector('.pw-nav-prev').addEventListener('click', () => cfg.nav.prev());
      el.querySelector('.pw-nav-next').addEventListener('click', () => cfg.nav.next());
    }

    const refresh = () => {
      if (cfg.nav) {
        const { i, n } = cfg.nav.info() || {};
        navEl.hidden = !n;
        // Spaced count, en-dash when the current item isn't in the nav
        // space (nothing selected yet / a reverted edit left the list) —
        // "– / 19" transitions smoothly into "3 / 19".
        if (n) el.querySelector('.pw-nav-count').textContent = i ? `${i} / ${n}` : `– / ${n}`;
      }
      // Rails re-derive from the lambdas — labels/colors/disabled are live.
      const leftEntries = (cfg.left && cfg.left.rail ? cfg.left.rail() : []);
      if (w.leftKey == null && leftEntries.length) w.leftKey = leftEntries[0].key;
      fillRail(leftRailEl, leftEntries, w.leftKey, (entry) => selectLeft(entry.key));

      const rightEntries = (cfg.right && cfg.right.rail ? cfg.right.rail() : []);
      fillRail(rightRailEl, rightEntries, w.rightKey, (entry) => toggleRight(entry.key));

      // NEW badge — see the Entry doc above. Both sides must opt in with a
      // ts; comparison is strict (equal stamps show nothing).
      const tsOf = (entries, key) => {
        const e = entries.find((x) => x.key === key);
        return e && e.ts != null ? +new Date(e.ts) : NaN;
      };
      const lts = tsOf(leftEntries, w.leftKey);
      const rts = tsOf(rightEntries, w.rightKey);
      const newEl = el.querySelector('.pw-new');
      newEl.hidden = !(isFinite(lts) && isFinite(rts) && rts > lts);
      if (!newEl.hidden) newEl.title = cfg.newBadgeTitle || 'Newer';

      // Collapse state. Actions stay pinned to their panes either way.
      const open = w.rightKey != null;
      rightPane.classList.toggle('pw-collapsed', !open);
      const setRow = (row, title, btns) => {
        row.querySelector('.pw-row-title').textContent = title || '';
        fill(row.querySelector('.sn-actions'), btns);
        row.hidden = !title && btns.length === 0;
      };
      setRow(leftRow,
        cfg.left && cfg.left.title ? cfg.left.title() : '',
        cfg.left && cfg.left.actions ? cfg.left.actions() : []);
      setRow(rightRow,
        open && cfg.right && cfg.right.title ? cfg.right.title(w.rightKey) : '',
        open && cfg.right && cfg.right.actions ? cfg.right.actions(w.rightKey) : []);
    };

    const selectLeft = (key) => {
      if (key === w.leftKey) return;
      w.leftKey = key;
      if (cfg.left && cfg.left.onSelect) cfg.left.onSelect(key);
      refresh();
    };

    const toggleRight = (key) => {
      w.rightKey = (w.rightKey === key) ? null : key;
      if (cfg.right && cfg.right.onChange) cfg.right.onChange(w.rightKey);
      refresh();
    };

    w.refresh = refresh;
    w.selectLeft = selectLeft;
    w.openRight = (key) => { if (w.rightKey !== key) toggleRight(key); };
    w.closeRight = () => { if (w.rightKey != null) toggleRight(w.rightKey); };

    if (cfg.headerActions) fill(headerActions, cfg.headerActions);

    // openByDefault seeds the selection only — the caller paints the
    // initial right-pane content itself (its renderer may not exist yet).
    if (cfg.right && cfg.right.openByDefault && cfg.right.defaultKey != null) {
      w.rightKey = cfg.right.defaultKey;
    }
    refresh();
    return w;
  },
};
