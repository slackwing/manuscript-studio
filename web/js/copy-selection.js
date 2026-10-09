// Copy from selection: the third gutter button of a shift-click range
// (range-delete.js), above sketch and trash. Copies the selected sentences
// as the book would read with every suggestion APPLIED — the rendered
// winner per sentence (accepted, else People order), canonicalized like the
// push; a delete proposal drops the sentence, its paragraph break with it.
// Marker syntax rides along only while the stats-pane markers toggle is on.
// Sentences join with exactly one space; paragraph / section breaks keep the
// manuscript's own \n\t / \n\n.
window.WriteSysCopySelection = {
  buttonHTML() {
    return window.WriteSysIcons && window.WriteSysIcons.copy ? window.WriteSysIcons.copy(12) : '⧉';
  },

  // The effective text of each sentence in manuscript order, joined.
  textFor(ids) {
    const R = window.WriteSysRenderer;
    const S = window.WriteSysSuggestions;
    const sug = (S && S.renderBySentenceId) || {};
    const canon = (window.WriteSysCanonicalize && window.WriteSysCanonicalize.canonicalize) || ((t) => t);
    const keepMarkers = !(R && R.hiddenLayers && R.hiddenLayers.markers);
    let out = '';
    for (const id of ids) {
      const committed = String((R && R.sentenceMap && R.sentenceMap[id]) || '');
      const suggestion = sug[id];
      if (suggestion !== undefined && String(suggestion).trim() === '') continue; // deleted
      let text = canon(suggestion !== undefined ? suggestion : committed);
      if (!keepMarkers) text = this.stripMarkers(text);
      const lead = text.startsWith('\n\n') ? '\n\n' : (text.startsWith('\n\t') ? '\n\t' : '');
      const body = this.tidy(text.slice(lead.length));
      if (!body) continue;
      out += out === '' ? body : (lead || ' ') + body;
    }
    return out;
  },

  // Drop every &marker / &mark command, closing up the space it stood in:
  // "It was &marker#x tonight" → "It was tonight", "word &marker#x." →
  // "word.", "pulp&footnote{…}&marker#x, because" keeps its comma tight.
  stripMarkers(text) {
    const lib = window.WriteSysCommand;
    if (!lib || text.indexOf('&mark') < 0) return text;
    const chars = Array.from(text);
    const hits = lib.findInline(text).filter((c) => c.kind === 'marker' || c.kind === 'mark');
    for (let k = hits.length - 1; k >= 0; k--) {
      const { start, end } = hits[k];
      let before = chars.slice(0, start).join('');
      let after = chars.slice(end).join('');
      const spaceBefore = / +$/.test(before);
      const spaceAfter = /^ +/.test(after);
      if (spaceBefore && spaceAfter) {
        after = after.replace(/^ +/, '');
      } else if (spaceBefore && (after === '' || /^[\n.,;:!?)\]”’"']/.test(after))) {
        before = before.replace(/ +$/, '');
      } else if (spaceAfter && (before === '' || /[\n\t]$/.test(before))) {
        after = after.replace(/^ +/, '');
      }
      chars.splice(0, chars.length, ...Array.from(before + after));
    }
    return chars.join('');
  },

  // One space between words, none at line ends; a line's leading tab (a
  // paragraph indent inside a multi-paragraph suggestion) stays.
  tidy(text) {
    return text.split('\n')
      .map((line) => {
        const indent = line.match(/^\t*/)[0];
        return indent + line.slice(indent.length).replace(/[ \t]+/g, ' ').trim();
      })
      .join('\n')
      .trim();
  },

  async copy(ids, btn) {
    const text = this.textFor(ids);
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch (e) {
      // No async clipboard (insecure origin, old browser): the textarea path.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:-1000px;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
      ta.remove();
    }
    if (btn) {
      btn.classList.toggle('copied', ok);
      btn.title = ok ? 'Copied' : 'Copy failed';
      if (ok && window.WriteSysIcons && window.WriteSysIcons.check) btn.innerHTML = window.WriteSysIcons.check(12);
      clearTimeout(this._reset);
      this._reset = setTimeout(() => {
        if (!btn.isConnected) return;
        btn.classList.remove('copied');
        btn.title = this.titleFor(ids);
        btn.innerHTML = this.buttonHTML();
      }, 1200);
    }
    return ok ? text : null;
  },

  titleFor(ids) {
    return `Copy ${ids.length} sentence${ids.length > 1 ? 's' : ''}`;
  },
};
