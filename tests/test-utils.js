/**
 * Test utilities for Manuscript Studio integration tests.
 *
 * The single bootstrap surface for tests:
 *   - TEST_MANUSCRIPT_ID / TEST_MANUSCRIPT_NAME / TEST_URL — the test manuscript.
 *   - cleanupTestAnnotations() — wipes test data + re-bootstraps the manuscript.
 *   - loginAsTestUser(page) — logs in (no manuscript dropdown anymore; the
 *     test page navigates directly to TEST_URL).
 *
 * If something here changes shape, every test inherits the change. Resist
 * the urge to do bespoke login flows in individual tests — fold any new
 * setup steps into here.
 */

const { execSync } = require('child_process');

const TEST_MANUSCRIPT_ID = 1; // test-manuscripts (only manuscript in dev)
const TEST_MANUSCRIPT_NAME = 'test-manuscripts';
const TEST_URL = `http://localhost:5001/?manuscript_id=${TEST_MANUSCRIPT_ID}`;
const API_BASE_URL = 'http://localhost:5001/api';

const DB_HOST = 'localhost';
const DB_PORT = 5433;
const DB_NAME = 'manuscript_studio_dev';
const DB_USER = 'manuscript_dev';
const DB_PASSWORD = 'manuscript_dev';
const SYSTEM_TOKEN = 'dev-system-token-not-for-production';

const TEST_USERNAME = 'test';
const TEST_PASSWORD = 'test';

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

/**
 * Clean up all test annotation data and re-bootstrap the test manuscript.
 * Should be called before each test run.
 *
 * Wipes all annotation/sentence/migration data for manuscript_id=TEST_MANUSCRIPT_ID,
 * then calls /api/admin/sync to re-bootstrap from the test repo. Faster than
 * dropping the whole schema.
 */
async function cleanupTestAnnotations() {
  try {
    // Wipe annotations + sentences + migrations for the test manuscript.
    // Leaves user/access rows intact.
    psql(`
      DELETE FROM annotation_tag WHERE annotation_id IN (
        SELECT annotation_id FROM annotation WHERE sentence_id IN (
          SELECT sentence_id FROM sentence WHERE migration_id IN (
            SELECT migration_id FROM migration WHERE manuscript_id = ${TEST_MANUSCRIPT_ID}
          )
        )
      );
      DELETE FROM annotation_version WHERE annotation_id IN (
        SELECT annotation_id FROM annotation WHERE sentence_id IN (
          SELECT sentence_id FROM sentence WHERE migration_id IN (
            SELECT migration_id FROM migration WHERE manuscript_id = ${TEST_MANUSCRIPT_ID}
          )
        )
      );
      DELETE FROM annotation WHERE sentence_id IN (
        SELECT sentence_id FROM sentence WHERE migration_id IN (
          SELECT migration_id FROM migration WHERE manuscript_id = ${TEST_MANUSCRIPT_ID}
        )
      );
      DELETE FROM tag WHERE migration_id IN (
        SELECT migration_id FROM migration WHERE manuscript_id = ${TEST_MANUSCRIPT_ID}
      );
      DELETE FROM sentence WHERE migration_id IN (
        SELECT migration_id FROM migration WHERE manuscript_id = ${TEST_MANUSCRIPT_ID}
      );
      DELETE FROM migration WHERE manuscript_id = ${TEST_MANUSCRIPT_ID};
    `);

    // Re-bootstrap via the admin sync endpoint. The server already has the
    // manuscript row; sync creates a new migration from the local test repo.
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

    // Sync runs async in a goroutine. Poll for a *completed* migration —
    // status='done' means sentences/annotations are queryable.
    for (let i = 0; i < 80; i++) {
      const out = psql(`SELECT COUNT(*) FROM migration WHERE manuscript_id = ${TEST_MANUSCRIPT_ID} AND status = 'done';`);
      if (/\b[1-9]\d*\b/.test(out)) break;
      await new Promise(r => setTimeout(r, 250));
    }

    console.log('[CLEANUP] Test manuscript cleaned and re-bootstrapped (manuscript_id=' + TEST_MANUSCRIPT_ID + ')');
  } catch (error) {
    // Cleanup errors are not fatal, just warn
    console.warn('[CLEANUP] Warning:', error.message);
  }
}

/**
 * Login to the application with test credentials. Manuscripts are no
 * longer chosen at login time — the post-login redirect goes to the user's
 * last-opened manuscript, falling back to the first accessible. For tests
 * we want the SAME manuscript every run; we follow the redirect (whatever
 * it is), then the test calls page.goto(TEST_URL) explicitly to land on
 * TEST_MANUSCRIPT_ID. That `goto` also covers the "no last-opened yet"
 * path on a fresh DB.
 *
 * @param {Page} page - Playwright page object
 */
async function loginAsTestUser(page) {
  const loginUrl = 'http://localhost:5001/login.html';

  await page.goto(loginUrl, { waitUntil: 'networkidle' });
  await page.waitForLoadState('domcontentloaded');

  // Wait for the username dropdown to populate via JS.
  await page.waitForTimeout(500);

  await page.selectOption('#username', TEST_USERNAME);
  await page.fill('#password', TEST_PASSWORD);
  await page.click('#login-btn');

  // Wait for the post-login redirect to land somewhere on the app.
  await page.waitForURL(/localhost:5001\/(\?.*)?$/, { timeout: 5000 });
  await page.waitForTimeout(500);
}

/**
 * Wipe sessions for the test user. Call between runs that depend on a
 * clean "no last-opened manuscript" state.
 */
async function cleanupTestSessions() {
  try {
    psql(`DELETE FROM session WHERE username = '${TEST_USERNAME}';
          UPDATE "user" SET last_manuscript_name = NULL WHERE username = '${TEST_USERNAME}';`);
  } catch (err) {
    console.warn('[CLEANUP] session cleanup warning:', err.message);
  }
}

module.exports = {
  TEST_MANUSCRIPT_ID,
  TEST_MANUSCRIPT_NAME,
  TEST_URL,
  API_BASE_URL,
  TEST_USERNAME,
  TEST_PASSWORD,
  SYSTEM_TOKEN,
  cleanupTestAnnotations,
  cleanupTestSessions,
  loginAsTestUser,
};
