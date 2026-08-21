/**
 * Markdown → .manuscript normalizer (MANUSCRIPT_LIFECYCLE_PLAN §6).
 *
 * The "standard markdown → .manuscript converter": takes the markdown that
 * mammoth+turndown produce from a .docx (or any markdown) and emits text in
 * the house .manuscript conventions:
 *
 *   - headings shifted so the fragment's top level becomes `##` (chapters);
 *     there is NO scene concept — deeper levels just shift along
 *   - paragraph breaks become the `\n\t` indent convention: the first
 *     paragraph after a heading (or at the start) sits flush, each following
 *     paragraph joins with a single newline + tab
 *   - headings keep blank lines around them
 *   - Word/turndown cruft removed: curly quotes → straight, non-breaking
 *     spaces → spaces, backslash-escapes unescaped, en/em spacing normalized
 *
 * Standalone on purpose: classic script for the browser, module.exports for
 * Node (tests, future CLI). No DOM, no fetch — pure text in, text out.
 */
const WriteSysManuscriptNormalize = {
  // normalize(md) → .manuscript fragment (no trailing newline).
  normalize(md) {
    let text = String(md || '').replace(/\r\n?/g, '\n');

    text = this.stripCruft(text);

    // Parse into blocks separated by blank lines.
    let rawBlocks = text.split(/\n{2,}/).map(b => b.trim()).filter(Boolean);
    if (!rawBlocks.length) return '';

    // Word manuscripts often mark chapter titles as short BOLD paragraphs
    // rather than real heading styles ("**Chapter 1**"). Promote those to
    // headings, merging a bold title line that directly follows a bold
    // chapter line ("**Chapter 1**" + "**The Predator Paradox**" →
    // "# Chapter 1: The Predator Paradox") before the level shift runs.
    const boldOnly = (b) => {
      const m = b.match(/^\*\*(.+)\*\*$/s);
      return (m && m[1].length <= 60 && !m[1].includes('\n') && !m[1].includes('**')) ? m[1].trim() : null;
    };
    const promoted = [];
    for (let i = 0; i < rawBlocks.length; i++) {
      const inner = boldOnly(rawBlocks[i]);
      if (inner == null) { promoted.push(rawBlocks[i]); continue; }
      let title = inner;
      while (i + 1 < rawBlocks.length) {
        const next = boldOnly(rawBlocks[i + 1]);
        if (next == null) break;
        title += ': ' + next;
        i++;
      }
      promoted.push('# ' + title);
    }
    rawBlocks = promoted;

    // Heading shift: the shallowest heading in the fragment becomes ##.
    const levels = rawBlocks
      .map(b => (b.match(/^(#{1,6})\s/) || [])[1])
      .filter(Boolean)
      .map(h => h.length);
    const shift = levels.length ? Math.max(0, 2 - Math.min(...levels)) : 0;

    const out = [];
    let prevWasText = false;
    for (const block of rawBlocks) {
      const h = block.match(/^(#{1,6})\s+(.*)$/s);
      if (h) {
        const level = Math.min(6, h[1].length + shift);
        out.push({ kind: 'heading', text: '#'.repeat(level) + ' ' + h[2].trim() });
        prevWasText = false;
        continue;
      }
      // A paragraph. Collapse internal newlines (turndown soft-wraps) into
      // spaces — .manuscript paragraphs are one source line each.
      const para = block.replace(/\s*\n\s*/g, ' ').trim();
      out.push({ kind: prevWasText ? 'para-cont' : 'para-first', text: para });
      prevWasText = true;
    }

    // Assemble: blank lines around headings; continuation paragraphs join
    // their predecessor with "\n\t".
    let result = '';
    out.forEach((b, i) => {
      if (i === 0) {
        result = b.kind === 'para-cont' ? '\t' + b.text : b.text;
        return;
      }
      if (b.kind === 'para-cont') {
        result += '\n\t' + b.text;
      } else {
        result += '\n\n' + b.text;
      }
    });
    return result;
  },

  // Word/turndown cruft, applied to the whole text before block parsing.
  stripCruft(text) {
    return text
      // Curly quotes → straight (N9: source of truth uses straight quotes;
      // smartquotes runs at render time).
      .replace(/[‘’ʼ]/g, "'")
      .replace(/[“”]/g, '"')
      // Non-breaking / odd spaces → plain space.
      .replace(/[   ]/g, ' ')
      // Turndown backslash-escapes markdown punctuation in prose; the
      // .manuscript source wants the plain characters.
      .replace(/\\([\\`*_{}[\]()#+\-.!>])/g, '$1')
      // Zero-width junk Word sometimes leaves behind.
      .replace(/[​‌‍﻿]/g, '')
      // Trailing whitespace per line.
      .replace(/[ \t]+$/gm, '');
  },
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = WriteSysManuscriptNormalize;
}
if (typeof window !== 'undefined') {
  window.WriteSysManuscriptNormalize = WriteSysManuscriptNormalize;
}
