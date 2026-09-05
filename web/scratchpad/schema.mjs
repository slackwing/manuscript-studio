/**
 * Scratchpad SCHEMA (split out of editor-core.mjs — CODE_REVIEW_AUG_2026.md §1):
 * the ProseMirror node/mark specs, schema composition (lists + tables), and
 * modernizeDoc, the legacy-doc migrator that brings any stored doc up to the
 * current schema so it always opens.
 *
 * Cross-module imports are pinned (?v=N): the URL INCLUDING the query is the
 * module-instance key, so every importer of a sibling module must use the
 * identical specifier. The vendored prosemirror.mjs import stays relative and
 * unpinned everywhere so instanceof checks share one instance.
 */
import { Schema, addListNodes, tableNodes } from './vendor/prosemirror.mjs';

// ---------------------------------------------------------------- schema

const coreNodes = {
  doc: { content: 'block+' },
  paragraph: {
    group: 'block', content: 'inline*',
    parseDOM: [{ tag: 'p' }],
    toDOM: () => ['p', 0],
  },
  heading: {
    group: 'block', content: 'inline*', defining: true,
    attrs: { level: { default: 1 } },
    parseDOM: [1, 2, 3, 4].map(l => ({ tag: 'h' + l, attrs: { level: l } })),
    toDOM: n => ['h' + n.attrs.level, 0],
  },
  blockquote: {
    group: 'block', content: 'block+',
    parseDOM: [{ tag: 'blockquote' }],
    toDOM: () => ['blockquote', 0],
  },
  horizontal_rule: {
    group: 'block',
    parseDOM: [{ tag: 'hr' }],
    toDOM: () => ['hr'],
  },
  // Scratchpad-only images served from scratchpad_image (never in the book).
  image: {
    group: 'block', atom: true, draggable: true,
    attrs: { imageId: { default: '' }, alt: { default: '' } },
    parseDOM: [{
      tag: 'img[data-image-id]',
      getAttrs: dom => ({ imageId: dom.getAttribute('data-image-id') || '', alt: dom.getAttribute('alt') || '' }),
    }],
    toDOM: n => ['img', {
      'data-image-id': n.attrs.imageId,
      src: 'api/scratchpad-images/' + n.attrs.imageId,
      alt: n.attrs.alt,
      class: 'scratch-image',
    }],
  },
  // A sketch PLACEMENT (VARIATIONS_PLAN.md): atom marker for one variation.
  // All content/state lives server-side; the NodeView fetches its context.
  // Stored docs were typed 'snippet' before changeset 043 rewrote them;
  // modernizeDoc still heals any straggler on load.
  sketch: {
    group: 'block', atom: true, selectable: true,
    attrs: { variationId: { default: 0 } },
    parseDOM: [{
      tag: 'div[data-variation-id]',
      getAttrs: dom => ({ variationId: parseInt(dom.getAttribute('data-variation-id'), 10) || 0 }),
    }],
    toDOM: n => ['div', { 'data-variation-id': String(n.attrs.variationId) }],
  },
  // A note REFERENCE (NOTES_PLAN.md Phase 2, atomic rework): ONE inline atom that
  // holds the whole noted run — a small colored square + the (verbatim, snapshot)
  // highlighted text. The doc stores ONLY the note_id and the text; the COLOR is
  // NOT in the doc — the NodeView sources it from the note data (client cache),
  // so recoloring a note is a pure note-row update with no doc edit. This node
  // IS the anchor (deleting it soft-deletes the note). The text is uneditable
  // (it's an atom); it looks like normal highlighted prose.
  noteRef: {
    group: 'inline', inline: true, atom: true, selectable: false,
    attrs: { noteId: { default: 0 }, text: { default: '' } },
    parseDOM: [{
      tag: 'span[data-note-ref]',
      getAttrs: dom => ({
        noteId: parseInt(dom.getAttribute('data-note-ref'), 10) || 0,
        text: dom.getAttribute('data-note-text') || dom.textContent || '',
      }),
    }],
    // toDOM is the persistence/copy form (color not encoded); the live look is
    // rendered by NoteRefView.
    toDOM: n => ['span', {
      'data-note-ref': String(n.attrs.noteId),
      'data-note-text': n.attrs.text,
      class: 'sn-note-ref',
    }, n.attrs.text],
  },
  text: { group: 'inline' },
  hard_break: {
    group: 'inline', inline: true, selectable: false,
    parseDOM: [{ tag: 'br' }],
    toDOM: () => ['br'],
  },
};

const marks = {
  strong: { parseDOM: [{ tag: 'strong' }, { tag: 'b' }], toDOM: () => ['strong', 0] },
  em: { parseDOM: [{ tag: 'em' }, { tag: 'i' }], toDOM: () => ['em', 0] },
  // (The old noteHighlight mark is gone — the noteRef atom now carries the whole
  // noted run and sources its color from the note data, so color is no longer
  // stored in the doc.)
};

const base = new Schema({ nodes: coreNodes, marks });
const withLists = addListNodes(base.spec.nodes, 'paragraph block*', 'block');
const withTables = withLists.append(tableNodes({
  tableGroup: 'block',
  cellContent: 'block+',
  cellAttributes: {},
}));
export const schema = new Schema({ nodes: withTables, marks: base.spec.marks });

// Bring a stored doc up to the current schema so it always opens:
//  - drop pre-variations sketch nodes ("book_content", or "sketch" without a
//    positive variationId).
//  - CONVERT the pre-atomic note representation (a `noteAnchor` inline node +
//    a `noteHighlight` mark on the following text, both tagged with noteId)
//    into the current atomic `noteRef {noteId, text}` node. Without this, a doc
//    saved by the old build throws "Unknown node type: noteAnchor" on load.
export function modernizeDoc(json) {
  // Rewrite one inline-content array: fold legacy anchor + highlighted text into
  // a single noteRef; strip any orphan noteHighlight mark.
  const convertInline = (content) => {
    if (!Array.isArray(content)) return content;
    const out = [];
    for (let i = 0; i < content.length; i++) {
      const node = content[i];
      if (node && node.type === 'noteAnchor') {
        const noteId = (node.attrs && node.attrs.noteId) || 0;
        // Gather the run of following text nodes carrying this note's highlight.
        let text = '';
        while (i + 1 < content.length) {
          const nxt = content[i + 1];
          const hl = nxt && nxt.type === 'text' && (nxt.marks || []).find(
            m => m.type === 'noteHighlight' && (m.attrs && m.attrs.noteId) === noteId);
          if (!hl) break;
          text += nxt.text || '';
          i++;
        }
        if (noteId > 0) out.push({ type: 'noteRef', attrs: { noteId, text } });
        else if (text) out.push({ type: 'text', text }); // no id → just keep the text
        continue;
      }
      // A stray text node with a noteHighlight mark but no anchor: drop the mark.
      if (node && node.type === 'text' && Array.isArray(node.marks)) {
        const marks = node.marks.filter(m => m.type !== 'noteHighlight');
        out.push(marks.length ? { ...node, marks } : { ...node, marks: undefined });
        continue;
      }
      out.push(node);
    }
    return out;
  };

  const clean = (n) => {
    if (!n || typeof n !== 'object') return null;
    if (n.type === 'book_content') return null;
    if (n.type === 'snippet') n.type = 'sketch'; // pre-043 node type
    if (n.type === 'sketch' && !(n.attrs && n.attrs.variationId > 0)) return null;
    if (Array.isArray(n.content)) {
      // Convert legacy note representation within this node's inline content
      // first, then recurse into children.
      if (n.content.some(c => c && (c.type === 'noteAnchor'
          || (c.type === 'text' && (c.marks || []).some(m => m.type === 'noteHighlight'))))) {
        n.content = convertInline(n.content);
      }
      n.content = n.content.map(clean).filter(Boolean);
    }
    return n;
  };
  return clean(json) || { type: 'doc', content: [{ type: 'paragraph' }] };
}
