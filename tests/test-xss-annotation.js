// Stored-XSS regression test for annotation notes.
//
// Before the fix, annotation notes were rendered into a textarea via innerHTML
// with template-literal interpolation. A note containing
//   <img src=x onerror="window.__xss=1">
// would execute when the annotation list was rendered.
//
// This test inserts such a payload directly into the database via psql,
// loads the page, and asserts that window.__xss never gets set.

const { chromium } = require('playwright');
const {
  TEST_URL,
  TEST_MANUSCRIPT_ID,
  cleanupTestAnnotations,
  loginAsTestUser,
} = require('./test-utils');
const { execSync } = require('child_process');

const DB_HOST = 'localhost';
const DB_PORT = 5433;
const DB_NAME = 'manuscript_studio_dev';
const DB_USER = 'manuscript_dev';
const DB_PASSWORD = 'manuscript_dev';

function psql(sql) {
  const escaped = sql.replace(/"/g, '\\"');
  try {
    return execSync(
      `PGPASSWORD="${DB_PASSWORD}" psql -h ${DB_HOST} -p ${DB_PORT} -U ${DB_USER} -d ${DB_NAME} -v ON_ERROR_STOP=1 -At -c "${escaped}"`,
      { encoding: 'utf-8', stdio: 'pipe' }
    );
  } catch (err) {
    if (err.status === 127 || /psql: not found|command not found/.test(err.message || '')) {
      return execSync(
        `docker exec -i manuscript-studio-dev-postgres psql -U ${DB_USER} -d ${DB_NAME} -v ON_ERROR_STOP=1 -At -c "${escaped}"`,
        { encoding: 'utf-8', stdio: 'pipe' }
      );
    }
    throw err;
  }
}

(async () => {
  console.log('=== XSS Annotation Note Test ===\n');

  await cleanupTestAnnotations();

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  let exitCode = 0;

  try {
    await loginAsTestUser(page);
    await page.goto(TEST_URL);
    await page.waitForSelector('.pagedjs_page', { timeout: 30000 });
    await page.waitForSelector('.sentence', { timeout: 5000 });
    await page.waitForTimeout(1500);

    // Pick a real sentence_id from the page so the annotation links to
    // something the renderer will actually display when we click it.
    const sentenceId = await page.locator('.sentence').first().getAttribute('data-sentence-id');
    if (!sentenceId) throw new Error('no sentences rendered');

    // Inject an annotation directly into the DB with an XSS payload note.
    const payload = '<img src=x onerror="window.__xss_fired=true">';
    psql(`
      INSERT INTO annotation (sentence_id, user_id, color, note, priority, flagged, position)
      VALUES ('${sentenceId}', 'test', 'yellow', '${payload}', 'none', false, 0);
    `);

    // Reload the page so the renderer fetches the new annotation.
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.sentence', { timeout: 5000 });
    await page.waitForTimeout(1000);

    // Click the sentence to open its annotation panel — this is when the
    // textarea is populated with the note, which is where the original bug
    // would fire.
    await page.locator(`.sentence[data-sentence-id="${sentenceId}"]`).first().click();
    await page.waitForSelector('.sticky-note', { timeout: 5000 });
    await page.waitForTimeout(500);

    // Check that the payload did not execute.
    const xssFired = await page.evaluate(() => window.__xss_fired === true);
    if (xssFired) {
      console.error('✗ FAIL: XSS payload executed');
      exitCode = 1;
    } else {
      console.log('✓ XSS payload did not execute');
    }

    // Also verify the textarea's value contains the literal payload string —
    // i.e. it was rendered as text, not interpreted as HTML.
    const textareaValue = await page.locator('.sticky-note .note-input').first().inputValue();
    if (textareaValue !== payload) {
      console.error(`✗ FAIL: textarea value is ${JSON.stringify(textareaValue)}, expected ${JSON.stringify(payload)}`);
      exitCode = 1;
    } else {
      console.log('✓ Textarea contains literal payload as text');
    }

    // Check the DOM didn't grow an <img> child as a result of the payload.
    const imgInside = await page.locator('.sticky-note img').count();
    if (imgInside > 0) {
      console.error(`✗ FAIL: payload created ${imgInside} <img> element(s) inside sticky-note`);
      exitCode = 1;
    } else {
      console.log('✓ No <img> children inside sticky-note');
    }

  } catch (err) {
    console.error('Test errored:', err);
    exitCode = 1;
  } finally {
    await browser.close();
    process.exit(exitCode);
  }
})();
