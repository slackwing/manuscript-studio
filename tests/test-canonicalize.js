/**
 * Runs the shared canonicalize corpus (tests/canonicalize-scenarios.jsonl)
 * against the JS port, asserting output + idempotence. Parity with the Go
 * port (internal/sentence/canonicalize_test.go) is guaranteed by both running
 * the SAME corpus.
 *
 * Node-only (no browser): command.js and canonicalize.js both export via
 * module.exports, and canonicalize.js require()s command.js when window is
 * absent.
 */
const fs = require('fs');
const path = require('path');
const { canonicalize } = require('../web/js/canonicalize.js');

const corpus = path.join(__dirname, 'canonicalize-scenarios.jsonl');
const lines = fs.readFileSync(corpus, 'utf-8').split('\n').filter(Boolean);

let failed = 0;
for (const line of lines) {
  const { name, in: input, out: expected } = JSON.parse(line);
  const got = canonicalize(input);
  if (got !== expected) {
    console.log(`❌ ${name}: canonicalize(${JSON.stringify(input)}) = ${JSON.stringify(got)}, want ${JSON.stringify(expected)}`);
    failed++;
    continue;
  }
  const again = canonicalize(got);
  if (again !== got) {
    console.log(`❌ ${name}: not idempotent: canonicalize(${JSON.stringify(got)}) = ${JSON.stringify(again)}`);
    failed++;
  }
}

if (failed === 0) {
  console.log(`✅ canonicalize JS port: all ${lines.length} scenarios pass (+ idempotence)`);
  process.exit(0);
} else {
  console.log(`\n${failed} scenario(s) failed`);
  process.exit(1);
}
