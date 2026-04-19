/**
 * Test utilities for Manuscript Studio integration tests.
 *
 * Ported from 14.writesys/tests/test-utils.js. Faithfully maintains the same
 * exported surface (TEST_MANUSCRIPT_ID, TEST_URL, API_BASE_URL,
 * cleanupTestAnnotations, loginAsTestUser) so ported tests need no changes.
 *
 * Adaptations:
 *  - TEST_MANUSCRIPT_ID is 1 (dev has only one manuscript: test-manuscripts).
 *  - Cleanup uses psql against the dev Postgres on localhost:5433, then
 *    calls the admin /sync endpoint to re-bootstrap.
 *  - Login selects manuscript "test-manuscripts" (our only manuscript).
 *  - Test user is "test" with password "test".
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
 * Login to the application with test credentials.
 * @param {Page} page - Playwright page object
 */
async function loginAsTestUser(page) {
  const loginUrl = 'http://localhost:5001/login.html';

  await page.goto(loginUrl, { waitUntil: 'networkidle' });
  await page.waitForLoadState('domcontentloaded');

  // Wait for users and manuscripts dropdowns to populate via JS.
  await page.waitForTimeout(1000);

  await page.selectOption('#username', TEST_USERNAME);
  await page.waitForTimeout(500);
  await page.fill('#password', TEST_PASSWORD);
  await page.selectOption('#manuscript', TEST_MANUSCRIPT_NAME);
  await page.click('#login-btn');

  // Wait for redirect to main app
  await page.waitForURL(/localhost:5001\/?(\?.*)?$/, { timeout: 5000 });
  await page.waitForTimeout(1000);
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
  loginAsTestUser
};
