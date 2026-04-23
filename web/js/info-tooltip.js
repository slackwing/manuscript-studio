/**
 * Tooltip for the ⓘ icon next to the manuscript picker.
 *
 * Same look-and-feel as the sentence-history popup (see .history-popup in
 * book.css) — borrowed via the .info-popup class. Appears immediately on
 * hover/focus (no native-tooltip delay), positioned anchored to the icon.
 *
 * The tooltip's contents are set externally via WriteSysInfoTooltip.set([
 *   ['Manuscript', 'mybook'],
 *   ['Commit', 'abc1234'],
 *   ...
 * ]). Setting a non-empty list reveals the icon; setting an empty list hides
 * it (e.g. when no manuscript is loaded).
 */

const WriteSysInfoTooltip = {
  _icon: null,
  _popup: null,
  _rows: [],

  init() {
    this._icon = document.getElementById('info-icon');
    if (!this._icon) return;
    this._icon.style.display = 'none'; // hidden until set() with rows
    this._icon.addEventListener('mouseenter', () => this._show());
    this._icon.addEventListener('mouseleave', () => this._hide());
    this._icon.addEventListener('focus', () => this._show());
    this._icon.addEventListener('blur', () => this._hide());
  },

  // rows: [[label, value], ...]
  set(rows) {
    this._rows = rows || [];
    if (!this._icon) return;
    this._icon.style.display = this._rows.length > 0 ? 'inline-flex' : 'none';
    this._hide();
  },

  _show() {
    if (this._rows.length === 0) return;
    if (this._popup) this._hide();
    const popup = document.createElement('div');
    popup.className = 'info-popup';
    popup.innerHTML = this._rows.map(([label, value]) => `
      <div class="info-popup-row">
        <span class="info-popup-label">${escapeHTML(label)}</span>
        <span class="info-popup-text">${escapeHTML(value)}</span>
      </div>
    `).join('');
    document.body.appendChild(popup);
    const rect = this._icon.getBoundingClientRect();
    // Position below + slightly left so the popup tail visually anchors
    // under the icon without spilling off-screen on narrow viewports.
    popup.style.left = `${Math.max(8, rect.left - 12)}px`;
    popup.style.top  = `${rect.bottom + 6 + window.scrollY}px`;
    this._popup = popup;
  },

  _hide() {
    if (this._popup) {
      this._popup.remove();
      this._popup = null;
    }
  },
};

function escapeHTML(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

window.WriteSysInfoTooltip = WriteSysInfoTooltip;
document.addEventListener('DOMContentLoaded', () => WriteSysInfoTooltip.init());
