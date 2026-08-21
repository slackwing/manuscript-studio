/**
 * Markdown → .manuscript normalizer (MANUSCRIPT_LIFECYCLE_PLAN §6).
 *
 * The "standard markdown → .manuscript converter": takes the markdown that
 * mammoth+turndown produce from a .docx (or any markdown) and emits text in
 * the house .manuscript conventions:
 *
 *   - headings become `&chapter{...}` commands (the house heading syntax —
 *     markdown # headers are DEPRECATED and render as plain prose); a
 *     merged "Chapter 1: The Predator Paradox" splits into
 *     `&chapter{Chapter 1}{The Predator Paradox}` (label on the page,
 *     description in the outline). There is NO scene concept.
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
    // chapter "Chapter 1" with description "The Predator Paradox").
    const boldOnly = (b) => {
      const m = b.match(/^\*\*(.+)\*\*$/s);
      return (m && m[1].length <= 60 && !m[1].includes('\n') && !m[1].includes('**')) ? m[1].trim() : null;
    };
    const promoted = [];
    for (let i = 0; i < rawBlocks.length; i++) {
      const inner = boldOnly(rawBlocks[i]);
      if (inner == null) { promoted.push(rawBlocks[i]); continue; }
      const parts = [inner];
      while (i + 1 < rawBlocks.length) {
        const next = boldOnly(rawBlocks[i + 1]);
        if (next == null) break;
        parts.push(next);
        i++;
      }
      promoted.push('# ' + parts.join(': '));
    }
    rawBlocks = promoted;

    const out = [];
    let prevWasText = false;
    let sectionBreak = false;
    for (const block of rawBlocks) {
      const h = block.match(/^(#{1,6})\s+(.*)$/s);
      if (h) {
        out.push({ kind: 'heading', text: this.chapterCommand(h[2].trim()) });
        prevWasText = false;
        sectionBreak = false;
        continue;
      }
      // Authors' hand-rolled section breaks ("***", "* * *", odd asterisk
      // variants, dots, dashes): drop the marker line and start the next
      // paragraph as a SECTION (\n\n, flush) instead.
      if (this.isSectionBreakMarker(block)) {
        sectionBreak = prevWasText;
        continue;
      }
      // A paragraph. Collapse internal newlines (turndown soft-wraps) into
      // spaces — .manuscript paragraphs are one source line each.
      const para = block.replace(/\s*\n\s*/g, ' ').trim();
      if (sectionBreak) {
        out.push({ kind: 'para-first', text: para });
        sectionBreak = false;
      } else {
        out.push({ kind: prevWasText ? 'para-cont' : 'para-first', text: para });
      }
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

  // isSectionBreakMarker: a short paragraph made ONLY of separator glyphs —
  // asterisk variants (incl. the odd middle one some authors use), dots,
  // dashes, tildes, section signs. No letters or digits, ≤ 12 glyphs.
  isSectionBreakMarker(block) {
    const t = block.replace(/\s+/g, '');
    if (!t || t.length > 12) return false;
    return /^[*∗✳✻✴⁂⁕※•·●○◦◆#~\-–—_=§|\\/+^]+$/.test(t);
  },

  // chapterCommand renders a heading as the house &chapter command.
  // "Chapter 1: The Predator Paradox" → &chapter{Chapter 1}{The Predator
  // Paradox} (the label shows on the page, the description in the
  // outline); anything else → &chapter{text}. Braces would break command
  // parsing, so they become parentheses.
  chapterCommand(text) {
    const clean = text.replace(/[{]/g, '(').replace(/[}]/g, ')');
    const m = clean.match(/^(.{1,40}?):\s+(.+)$/);
    if (m) return `&chapter{${m[1].trim()}}{${m[2].trim()}}`;
    return `&chapter{${clean}}`;
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
