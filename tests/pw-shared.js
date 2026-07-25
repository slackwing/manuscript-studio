// Preloaded via NODE_OPTIONS by test-all.sh: transparently reroutes
// chromium.launch() to the suite's shared browser server (MS_TEST_WS).
// Tests stay untouched — browser.close() on a connected browser only
// disconnects, leaving the server for the next test. Standalone runs
// (no MS_TEST_WS) launch their own browser exactly as before.
const pw = require('playwright');

const origLaunch = pw.chromium.launch.bind(pw.chromium);
pw.chromium.launch = async function patchedLaunch(opts) {
  if (process.env.MS_TEST_WS) {
    return pw.chromium.connect(process.env.MS_TEST_WS);
  }
  return origLaunch(opts);
};
