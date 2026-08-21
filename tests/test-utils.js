/**
 * Test utilities for Manuscript Studio integration tests.
 *
 * The single bootstrap surface for tests:
 *   - TEST_MANUSCRIPT_ID / TEST_MANUSCRIPT_NAME / TEST_URL — this WORKER's
 *     fixture. Parallel suite runs (test-all.sh) set MS_TEST_WORKER=1..K;
 *     worker 1 keeps the historical test/test-manuscripts pair, worker N
 *     uses testN/test-manuscripts-wN (provisioned by provision-workers.sh),
 *     so workers never touch each other's sentences, annotations,
 *     suggestions, or scratchpads.
 *   - loginAsTestUser(page) — API login (fast; the login FORM has its own
 *     dedicated e2e test using loginViaForm).
 *   - cleanupTestAnnotations() — FAST wipe of per-user layers (annotations,
 *     suggestions, tags, scratchpads). Does NOT touch sentences/migrations.
 *   - resetTestManuscript() — the nuclear option: wipes sentences +
 *     migrations and re-syncs (full re-segmentation). test-all.sh runs it
 *     once per worker at suite start; individual tests only need it if they
 *     corrupt the migration itself.
 *   - waitForPagination(page) / waitForRepagination(page, prev) — condition
 *     waits on the pagedjs-config afterRendered counter
 *     (document.body.dataset.paginated) instead of timing guesses.
 *
 * If something here changes shape, every test inherits the change. Resist
 * the urge to do bespoke login flows in individual tests — fold any new
 * setup steps into here.
 */

const { execSync } = require('child_process');

const WORKER = parseInt(process.env.MS_TEST_WORKER || '1', 10);

const TEST_MANUSCRIPT_NAME = WORKER === 1 ? 'test-manuscripts' : `test-manuscripts-w${WORKER}`;
const TEST_USERNAME = WORKER === 1 ? 'test' : `test${WORKER}`;
const TEST_PASSWORD = 'test';

// Server port — MS_TEST_PORT points a run at a second dev server (e.g. a
// worktree build on 5002) without touching the main `make dev` on 5001.
const PORT = parseInt(process.env.MS_TEST_PORT || '5001', 10);
const BASE_URL = `http://localhost:${PORT}`;
const API_BASE_URL = `${BASE_URL}/api`;

const DB_HOST = 'localhost';
const DB_PORT = 5433;
const DB_NAME = 'manuscript_studio_dev';
const DB_USER = 'manuscript_dev';
const DB_PASSWORD = 'manuscript_dev';
const SYSTEM_TOKEN = 'dev-system-token-not-for-production';

// Run SQL against the dev Postgres. Tries host psql first (fast path);
// falls back to `docker exec` into the dev container if psql isn't installed.
function psql(sql) {
  const escaped = sql.replace(/"/g, '\\"');
  try {
    return execSync(
      `PGPASSWORD="${DB_PASSWORD}" psql -h ${DB_HOST} -p ${DB_PORT} -U ${DB_USER} -d ${DB_NAME} -v ON_ERROR_STOP=1 -c "${escaped}"`,
      { encoding: 'utf-8', stdio: 'pipe' }
    );
  } catch (err) {
    // Fall back to docker exec if host psql is unavailable or fails to connect.
    if (err.status === 127 || /psql: not found|command not found/.test(err.message || '')) {
      return execSync(
        `docker exec -i manuscript-studio-dev-postgres psql -U ${DB_USER} -d ${DB_NAME} -v ON_ERROR_STOP=1 -c "${escaped}"`,
        { encoding: 'utf-8', stdio: 'pipe' }
      );
    }
    throw err;
  }
}

// The manuscript_id is per-worker and assigned by the DB at bootstrap, so
// it's resolved from git_repo_path (unique per fixture) instead of hardcoded.
function resolveManuscriptId() {
  try {
    const out = psql(`SELECT manuscript_id FROM manuscript WHERE git_repo_path LIKE '%repos/${TEST_MANUSCRIPT_NAME}' ORDER BY manuscript_id LIMIT 1;`);
    const m = out.match(/^\s*(\d+)\s*$/m);
    if (m) return parseInt(m[1], 10);
  } catch (e) { /* fresh DB — resetTestManuscript will create it */ }
  return WORKER === 1 ? 1 : 0;
}

let TEST_MANUSCRIPT_ID = resolveManuscriptId();
let TEST_URL = `${BASE_URL}/?manuscript_id=${TEST_MANUSCRIPT_ID}`;

/**
 * FAST cleanup: wipes the per-user data layers for THIS worker's fixture —
 * annotations (+tags/versions), suggestions, tags, and the worker user's
 * scratchpads/images. Sentences and migrations stay (they only change when
 * the manuscript itself changes; see resetTestManuscript).
 */
async function cleanupTestNotes() {
  try {
    psql(`
      -- point_event FKs to note (027) — clear this worker's events before
      -- any note delete or the FK blocks the wipe (N11's cousin).
      DELETE FROM point_event WHERE note_id IN (
        SELECT note_id FROM note WHERE user_id = '${TEST_USERNAME}'
      );
      DELETE FROM point_event WHERE note_id IN (
        SELECT note_id FROM note WHERE sentence_id IN (
          SELECT sentence_id FROM sentence WHERE migration_id IN (
            SELECT migration_id FROM migration WHERE manuscript_id = ${TEST_MANUSCRIPT_ID}
          )
        )
      );
      DELETE FROM note_tag WHERE note_id IN (
        SELECT note_id FROM note WHERE sentence_id IN (
          SELECT sentence_id FROM sentence WHERE migration_id IN (
            SELECT migration_id FROM migration WHERE manuscript_id = ${TEST_MANUSCRIPT_ID}
          )
        )
      );
      DELETE FROM note_version WHERE note_id IN (
        SELECT note_id FROM note WHERE sentence_id IN (
          SELECT sentence_id FROM sentence WHERE migration_id IN (
            SELECT migration_id FROM migration WHERE manuscript_id = ${TEST_MANUSCRIPT_ID}
          )
        )
      );
      DELETE FROM note WHERE sentence_id IN (
        SELECT sentence_id FROM sentence WHERE migration_id IN (
          SELECT migration_id FROM migration WHERE manuscript_id = ${TEST_MANUSCRIPT_ID}
        )
      );
      -- Scratchpad/standalone notes have NO sentence, so the sentence-scoped
      -- wipe above misses them; a crashed test's leftover note then haunts the
      -- next test's landing page as an orphaned "no context" card.
      DELETE FROM note_tag WHERE note_id IN (
        SELECT note_id FROM note WHERE user_id = '${TEST_USERNAME}' AND sentence_id IS NULL
      );
      DELETE FROM note_version WHERE note_id IN (
        SELECT note_id FROM note WHERE user_id = '${TEST_USERNAME}' AND sentence_id IS NULL
      );
      DELETE FROM note WHERE user_id = '${TEST_USERNAME}' AND sentence_id IS NULL;
      DELETE FROM suggested_change WHERE sentence_id IN (
        SELECT sentence_id FROM sentence WHERE migration_id IN (
          SELECT migration_id FROM migration WHERE manuscript_id = ${TEST_MANUSCRIPT_ID}
        )
      );
      DELETE FROM tag WHERE user_id = '${TEST_USERNAME}';
      DELETE FROM scratchpad_revision WHERE scratchpad_id IN (
        SELECT scratchpad_id FROM scratchpad WHERE user_id = '${TEST_USERNAME}'
      );
      DELETE FROM scratchpad WHERE user_id = '${TEST_USERNAME}';
      DELETE FROM scratchpad_image WHERE user_id = '${TEST_USERNAME}';
      UPDATE sketch SET canon_variation_id = NULL WHERE user_id = '${TEST_USERNAME}';
      DELETE FROM variation_revision WHERE variation_id IN (
        SELECT variation_id FROM variation WHERE sketch_id IN (
          SELECT sketch_id FROM sketch WHERE user_id = '${TEST_USERNAME}'
        )
      );
      DELETE FROM variation WHERE sketch_id IN (
        SELECT sketch_id FROM sketch WHERE user_id = '${TEST_USERNAME}'
      );
      DELETE FROM sketch WHERE user_id = '${TEST_USERNAME}';
    `);
    console.log(`[CLEANUP] fast wipe done (worker ${WORKER}, manuscript_id=${TEST_MANUSCRIPT_ID})`);
  } catch (error) {
    console.warn('[CLEANUP] Warning:', error.message);
  }
}

/**
 * NUCLEAR reset: wipe sentences + migrations too, then /admin/sync to
 * re-bootstrap from the fixture repo (full re-segmentation server-side).
 * test-all.sh runs this once per worker before the roster; tests only call
 * it themselves if they corrupt the migration.
 */
async function resetTestManuscript() {
  try {
    await cleanupTestNotes();
    if (TEST_MANUSCRIPT_ID > 0) {
      psql(`
        DELETE FROM command_slug WHERE migration_id IN (
          SELECT migration_id FROM migration WHERE manuscript_id = ${TEST_MANUSCRIPT_ID}
        );
        DELETE FROM sentence WHERE migration_id IN (
          SELECT migration_id FROM migration WHERE manuscript_id = ${TEST_MANUSCRIPT_ID}
        );
        DELETE FROM migration WHERE manuscript_id = ${TEST_MANUSCRIPT_ID};
      `);
    }

    const response = await fetch(`${API_BASE_URL}/admin/sync`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SYSTEM_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ manuscript_name: TEST_MANUSCRIPT_NAME })
    });
    if (!response.ok) {
      throw new Error(`admin/sync returned ${response.status}: ${await response.text()}`);
    }

    // Sync runs async in a goroutine; poll for a completed migration.
    TEST_MANUSCRIPT_ID = resolveManuscriptId();
    for (let i = 0; i < 80; i++) {
      if (TEST_MANUSCRIPT_ID > 0) {
        const out = psql(`SELECT COUNT(*) FROM migration WHERE manuscript_id = ${TEST_MANUSCRIPT_ID} AND status = 'done';`);
        if (/\b[1-9]\d*\b/.test(out)) break;
      } else {
        TEST_MANUSCRIPT_ID = resolveManuscriptId();
      }
      await new Promise(r => setTimeout(r, 250));
    }
    TEST_URL = `${BASE_URL}/?manuscript_id=${TEST_MANUSCRIPT_ID}`;
    console.log(`[RESET] manuscript re-bootstrapped (worker ${WORKER}, manuscript_id=${TEST_MANUSCRIPT_ID})`);
  } catch (error) {
    console.warn('[RESET] Warning:', error.message);
  }
}

/**
 * Login via the API — installs the session cookie into the page's context
 * without driving the login form (the form has its own e2e test:
 * test-login-form.js, which uses loginViaForm below).
 */
async function loginAsTestUser(page) {
  const resp = await page.request.post(`${API_BASE_URL}/login`, {
    data: { username: TEST_USERNAME, password: TEST_PASSWORD },
  });
  if (!resp.ok()) {
    throw new Error(`API login failed (${resp.status()}): ${(await resp.text()).slice(0, 200)}`);
  }
}

/**
 * Login by driving the login page UI — the e2e coverage of the form itself.
 */
async function loginViaForm(page) {
  await page.goto(`${BASE_URL}/login.html`, { waitUntil: 'domcontentloaded' });
  await page.fill('#username', TEST_USERNAME);
  await page.fill('#password', TEST_PASSWORD);
  await page.click('#login-btn');
  // Post-login lands on home.html (HOME_PLAN.md).
  await page.waitForURL(new RegExp(`localhost:${PORT}/home\\.html.*$`), { timeout: 5000, waitUntil: 'commit' });
}

/**
 * Wait until paged.js has completed a pagination pass and sentences exist.
 * Replaces "goto + sleep and hope" (the afterRendered hook in
 * pagedjs-config.js bumps document.body.dataset.paginated).
 */
async function waitForPagination(page, timeout = 30000) {
  await page.waitForFunction(
    () => document.body.dataset.paginated && document.querySelector('.pagedjs_pages .sentence'),
    null, { timeout }
  );
}

/** Snapshot the pagination counter (pair with waitForRepagination). */
async function paginationStamp(page) {
  return page.evaluate(() => document.body.dataset.paginated || '0');
}

/** Wait for a NEW pagination pass after `prev = await paginationStamp()`. */
async function waitForRepagination(page, prev, timeout = 30000) {
  await page.waitForFunction(
    (p) => (document.body.dataset.paginated || '0') !== p,
    prev, { timeout }
  );
}

/**
 * Wipe sessions for the test user. Call between runs that depend on a
 * clean "no last-opened manuscript" state.
 */
async function cleanupTestSessions() {
  try {
    psql(`DELETE FROM session WHERE username = '${TEST_USERNAME}';`);
  } catch (err) {
    console.warn('[CLEANUP] session cleanup warning:', err.message);
  }
}

module.exports = {
  get TEST_MANUSCRIPT_ID() { return TEST_MANUSCRIPT_ID; },
  TEST_MANUSCRIPT_NAME,
  get TEST_URL() { return TEST_URL; },
  BASE_URL,
  API_BASE_URL,
  TEST_USERNAME,
  TEST_PASSWORD,
  SYSTEM_TOKEN,
  WORKER,
  cleanupTestNotes,
  psql,
  // Back-compat alias while individual test files migrate to cleanupTestNotes.
  cleanupTestAnnotations: cleanupTestNotes,
  resetTestManuscript,
  cleanupTestSessions,
  loginAsTestUser,
  loginViaForm,
  waitForPagination,
  paginationStamp,
  waitForRepagination,
};
