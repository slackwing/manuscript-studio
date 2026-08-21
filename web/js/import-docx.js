/**
 * Docx import (MANUSCRIPT_LIFECYCLE_PLAN §6): the between-paragraph `+`
 * menu's second option. Everything happens in the browser —
 * mammoth (vendored) converts .docx → HTML, turndown (vendored) → markdown,
 * manuscript-normalize.js → house .manuscript conventions — and the result
 * is filed as ONE composed suggestion on the boundary sentence, exactly the
 * canonize shape. The server never sees docx or markdown; review + Push /
 * Commit land it through the normal migration path.
 *
 * The preview textarea is deliberately editable: import one chapter, eyeball
 * it, fix the conversion by hand or improve the normalizer, iterate.
 */
const WriteSysImportDocx = {
  csrf() { return window.getCSRFToken ? (window.getCSRFToken() || '') : ((localStorage.getItem('csrf_token') || sessionStorage.getItem('csrf_token')) || ''); },

  esc(t) {
    return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },

  target: null, // {sentenceId} — the boundary sentence the insert anchors to

  // mammoth is ~620KB — lazy-load the vendored converters on first open so
  // the book page pays nothing until a docx is actually imported. ONE
  // promise, shared (same pattern as the scratchpad-modal loader).
  _libsP: null,
  _loadLibs() {
    if (!this._libsP) {
      const load = (src) => new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = new URL(src, document.baseURI).href;
        s.onload = res;
        s.onerror = () => rej(new Error('failed to load ' + src));
        document.head.appendChild(s);
      });
      this._libsP = Promise.all([
        load('js/vendor/mammoth.browser.min.js'),
        load('js/vendor/turndown.js'),
      ]);
    }
    return this._libsP;
  },

  open(target) {
    this.close();
    this.target = target;
    const overlay = document.createElement('div');
    overlay.id = 'import-docx-overlay';
    // The sketch-widget chrome (sn-main/sn-header/sn-body) around the SHARED
    // mono edit pane (edit-pane.js) — tab/newline overlay for free, and the
    // converted text is editable before inserting.
    overlay.innerHTML = `
      <div id="import-docx-modal" role="dialog" aria-label="Import .docx">
        <div class="sn-main">
          <div class="sn-header">
            <span class="sn-status">Import .docx</span>
            <input type="file" id="idx-file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document">
          </div>
          <div class="sn-body">
            <div class="idx-editor" id="idx-editor"></div>
            <div class="idx-messages" id="idx-messages" hidden></div>
            <div class="idx-error" id="idx-error" hidden></div>
          </div>
          <div class="idx-actions">
            <button type="button" id="idx-cancel">Cancel</button>
            <button type="button" id="idx-go" disabled>Insert</button>
          </div>
        </div>
      </div>`;
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) this.close(); });
    document.body.appendChild(overlay);

    this._pane = window.WriteSysEditPane.createMonoEditor({
      value: '',
      overlayHTML: window.WriteSysEditPane.tabMarkupHTML,
      onInput: () => {
        document.getElementById('idx-go').disabled = !this._pane.textarea.value.trim();
      },
    });
    this._pane.textarea.classList.add('idx-preview');
    this._pane.textarea.id = 'idx-preview'; // stable hook (tests, tooling)
    document.getElementById('idx-editor').appendChild(this._pane.wrap);

    document.getElementById('idx-cancel').addEventListener('click', () => this.close());
    document.getElementById('idx-file').addEventListener('change', (e) => this.convert(e.target.files[0]));
    document.getElementById('idx-go').addEventListener('click', () => this.insert());
  },

  close() {
    const el = document.getElementById('import-docx-overlay');
    if (el) el.remove();
    this.target = null;
    this._pane = null;
  },

  showError(msg) {
    const el = document.getElementById('idx-error');
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
  },

  async convert(file) {
    if (!file) return;
    const err = document.getElementById('idx-error');
    if (err) err.hidden = true;
    try {
      await this._loadLibs();
      const buf = await file.arrayBuffer();
      const result = await window.mammoth.convertToHtml({ arrayBuffer: buf });
      const td = new window.TurndownService({
        headingStyle: 'atx',
        emDelimiter: '*',   // house style: *italics*
        strongDelimiter: '**',
      });
      const markdown = td.turndown(result.value || '');
      const normalized = window.WriteSysManuscriptNormalize.normalize(markdown);
      this._pane.textarea.value = normalized;
      this._pane.autoGrow();
      document.getElementById('idx-go').disabled = !normalized.trim();
      // mammoth reports unsupported styles etc. — surface, don't block.
      const msgs = (result.messages || []).map(m => m.message);
      const msgEl = document.getElementById('idx-messages');
      if (msgs.length && msgEl) {
        msgEl.textContent = 'Converter notes: ' + msgs.slice(0, 5).join(' · ') + (msgs.length > 5 ? ` (+${msgs.length - 5} more)` : '');
        msgEl.hidden = false;
      } else if (msgEl) {
        msgEl.hidden = true;
      }
    } catch (e) {
      this.showError('Conversion failed: ' + (e.message || e));
    }
  },

  // insertFragment composes exactly like canonize (import-scratchpad.js):
  // the fragment goes AFTER the boundary sentence's effective text, riding
  // any pending suggestion so both push together. Commands/headings get a
  // blank line; plain prose continues as an indented paragraph. Shared by
  // the docx import and the + menu's Chapter item. Throws on failure.
  async insertFragment(sentenceId, content) {
    const r = window.WriteSysRenderer;
    content = String(content || '').replace(/\s+$/, '');
    if (!r || !content) return;
    const committed = r.sentenceMap[sentenceId] || '';
    const pending = (window.WriteSysSuggestions && window.WriteSysSuggestions.bySentenceId) || {};
    const base = pending[sentenceId] !== undefined ? pending[sentenceId] : committed;
    const join = /^[#&]/.test(content) ? '\n\n' : '\n\t';
    const suggested = `${base.replace(/\s+$/, '')}${join}${content}`;

    const put = await fetch(`api/sentences/${encodeURIComponent(sentenceId)}/suggestion`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrf() },
      body: JSON.stringify({ text: suggested }),
    });
    if (put.status === 409) throw new Error('The manuscript changed under you — reload the page and retry.');
    if (!put.ok) throw new Error(`suggestion rejected (${put.status}): ${(await put.text()).slice(0, 200)}`);

    // A stale suggest-edit draft must not auto-restore over the insert.
    try { localStorage.removeItem(`ms-draft-suggest-${sentenceId}`); } catch (e) { /* non-fatal */ }

    if (window.WriteSysSuggestions) await window.WriteSysSuggestions.loadForMigration(r.currentMigrationID);
    if (window.WriteSysPush) window.WriteSysPush.refresh();
    await r.renderManuscript({ anchorSentenceId: sentenceId, selectSentenceId: sentenceId });
  },

  async insert() {
    const target = this.target;
    const content = this._pane ? this._pane.textarea.value : '';
    if (!target || !content.trim()) return;
    const go = document.getElementById('idx-go');
    go.disabled = true;
    go.textContent = 'Inserting…';
    try {
      const sid = target.sentenceId;
      await this.insertFragment(sid, content);
      this.close();
    } catch (e) {
      this.showError(e.message || String(e));
      go.disabled = false;
      go.textContent = 'Insert';
    }
  },
};

if (typeof window !== 'undefined') {
  window.WriteSysImportDocx = WriteSysImportDocx;
}
