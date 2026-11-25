// THE note default — the browser's mirror of Go sentence.NoteDefault (keep
// them in lockstep: tests/fixtures/note-default-cases.json drives BOTH
// test suites). What a note shows while its owner's text is blank:
//   - every {fill-in} in the text, in order, braces kept, space-joined
//     ("{adjective} {something here}"); braces of &-commands don't count;
//   - else the WHOLE sentence as plain prose (commands dropped, emphasis
//     marks removed, whitespace folded) — 2026-11-25; it was the first
//     three words + "...".
// Sentence notes only (a sketch note's default comes from the server, which
// can segment the sketch). The margin computes it live from the sentence
// as you see it, so editing a suggestion updates the note's default.
(function () {
  const cmdLib = () => (typeof window !== 'undefined' && window.WriteSysCommand)
    || (typeof require === 'function' ? require('./command.js') : null);

  // Drop every &-command (its own {…} arguments with it), leaving a space.
  function stripCommands(s) {
    const C = cmdLib();
    const chars = Array.from(s);
    let out = '';
    for (let i = 0; i < chars.length;) {
      if (chars[i] === '&' && C) {
        const cmd = C.parse(chars.slice(i).join(''));
        if (cmd) { i += Array.from(cmd.raw).length; out += ' '; continue; }
      }
      out += chars[i];
      i++;
    }
    return out;
  }

  function plainProse(s) {
    let out = stripCommands(s).replace(/\*/g, '');
    out = out.replace(/(^|[^\p{L}\p{N}_])_+([^_]+?)_+([^\p{L}\p{N}_]|$)/gu, '$1$2$3');
    out = out.split(/\s+/u).filter(Boolean).join(' ');
    out = out.replace(/ +([.,;:!?)\]”’])/g, '$1');
    return out.trim();
  }

  function noteDefault(text) {
    const fills = stripCommands(String(text || '')).match(/\{[^{}]*[^{}\s][^{}]*\}/g);
    if (fills && fills.length) {
      return fills.map((f) => '{' + f.slice(1, -1).split(/\s+/u).filter(Boolean).join(' ') + '}').join(' ');
    }
    return plainProse(String(text || ''));
  }

  const api = { noteDefault, stripCommands, plainProse };
  if (typeof window !== 'undefined') window.WriteSysNoteDefault = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
