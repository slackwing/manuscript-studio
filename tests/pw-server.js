// Shared Chromium for the whole suite (test-all.sh): one browser server,
// each test connects and gets its own isolated context — same e2e fidelity,
// no per-test cold start. Prints the ws endpoint on stdout; SIGTERM closes.
const { chromium } = require('playwright');

(async () => {
  const server = await chromium.launchServer({ headless: true });
  console.log(server.wsEndpoint());
  const bye = async () => { try { await server.close(); } catch (e) {} process.exit(0); };
  process.on('SIGTERM', bye);
  process.on('SIGINT', bye);
})().catch(e => { console.error(e); process.exit(1); });
