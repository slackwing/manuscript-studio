// The browser's note default (web/js/note-default.js) against THE shared
// case table — the same one Go's TestNoteDefault runs, so the margin and
// the server can't disagree. (Sketch cases are server-only: they segment.)
const path = require('path');
const ND = require(path.join(__dirname, '..', 'web/js/note-default.js'));
const cases = require('./fixtures/note-default-cases.json');
let failed = 0;
for (const c of cases) {
  if (c.sketch) continue;
  const got = ND.noteDefault(c.text);
  const ok = got === c.want;
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${JSON.stringify(c.text).slice(0, 70)} → ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(c.want)})`}`);
}
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
