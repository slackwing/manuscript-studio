// Nuclear per-worker fixture reset (see test-utils.resetTestManuscript).
// test-all.sh runs this once per worker before the roster.
const { resetTestManuscript } = require('./test-utils');
resetTestManuscript().then(() => process.exit(0)).catch(e => {
  console.error(e);
  process.exit(1);
});
