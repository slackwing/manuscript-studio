/**
 * Two annotation-note fixes:
 *
 * 1. No-op blur must not PUT. The server appends an annotation_version row
 *    on every save, so focus+blur with no edit used to bloat history with
 *    identical versions. The blur handler now skips the save when the
 *    normalized textarea value equals the annotation's current note.
 *
 * 2. Note-create race: handleAddNewNote used to re-read
 *    this.currentSentenceId AFTER the awaited POST, so clicking another
 *    sentence during the round-trip attached the local annotation object to
 *    the wrong sentence (and rendered it under the wrong sentence's panel).
 *    The sentence id is now captured before the POST.
 */

const { execSync } = require('child_process');
const { chromium } = require('playwright');
const {
  TEST_URL,
  cleanupTestAnnotations,
  loginAsTestUser,
} = require('./test-utils');

function psql(sql) {
  return execSync(
    `PGPASSWORD=manuscript_dev psql -h localhost -p 5433 -U manuscript_dev -d manuscript_studio_dev -At -c "${sql.replace(/"/g, '\\"')}"`,
    { encoding: 'utf-8' }
  ).trim();
}

(async () => {
  console.log('=== Annotation notes: no-op blur save + create race ===\n');

  await cleanupTestAnnotations();

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1400, height: 900 });

  let failed = false;
  function assert(cond, msg) {
    if (cond) console.log(`✓ ${msg}`);
    else { console.log(`✗ ${msg}`); failed = true; }
  }

  const annotationPuts = [];
  page.on('request', r => {
    if (r.method() === 'PUT' && /\/api\/annotations\/\d+/.test(r.url())) {
      annotationPuts.push(r.url());
    }
  });

  try {
    await loginAsTestUser(page);
    await page.goto(TEST_URL);
    await page.waitForSelector('.pagedjs_page', { timeout: 30000 });
    await page.waitForSelector('.sentence', { timeout: 10000 });
    await page.waitForTimeout(1500);

    // Three distinct prose sentences: one for the blur check, two for the race.
    const targets = await page.evaluate(() => {
      const seen = new Set();
      const out = [];
      for (const el of document.querySelectorAll('.sentence[data-sentence-id]')) {
        const t = el.textContent.trim();
        const id = el.dataset.sentenceId;
        if (t.length > 30 && !t.startsWith('#') && !seen.has(id)) {
          seen.add(id);
          out.push(id);
        }
        if (out.length === 3) break;
      }
      return out;
    });
    assert(targets.length === 3, `Found 3 prose sentences (got ${targets.length})`);
    const [blurSid, raceSidA, raceSidB] = targets;

    // ---- Fix 1: focus + blur with no edit issues no PUT / no version row ----

    await page.locator(`.sentence[data-sentence-id="${blurSid}"]`).first().click();
    await page.waitForSelector('.sticky-note.uncreated-note.first-uncreated .note-input', { timeout: 5000 });
    await page.locator('.sticky-note.uncreated-note.first-uncreated .note-input').click();
    await page.keyboard.type('a stable note');
    // Let the create POST land and the 1s debounced text save drain.
    await page.waitForSelector('.sticky-note:not(.uncreated-note) .note-input', { timeout: 5000 });
    await page.waitForTimeout(2500);

    const annId = await page.evaluate(() => {
      const a = window.WriteSysAnnotations && window.WriteSysAnnotations.annotations[0];
      return a ? a.annotation_id : null;
    });
    assert(!!annId, `Annotation created (id ${annId})`);

    const versionsBefore = psql(`SELECT COUNT(*) FROM annotation_version WHERE annotation_id=${annId}`);
    const putsBefore = annotationPuts.length;

    // Focus the note, then blur without editing.
    const noteInput = page.locator(`.sticky-note[data-annotation-id="${annId}"] .note-input`);
    await noteInput.click();
    await page.waitForTimeout(300);
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.waitForTimeout(1500);

    assert(annotationPuts.length === putsBefore,
      `No PUT fired on focus+blur without edits (got ${annotationPuts.length - putsBefore} extra)`);
    const versionsAfter = psql(`SELECT COUNT(*) FROM annotation_version WHERE annotation_id=${annId}`);
    assert(versionsAfter === versionsBefore,
      `No new version row appended (before ${versionsBefore}, after ${versionsAfter})`);

    // A REAL edit followed by blur must still save.
    await noteInput.click();
    await noteInput.evaluate(el => el.setSelectionRange(el.value.length, el.value.length));
    await page.keyboard.type(' now edited');
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.waitForTimeout(1500);
    assert(annotationPuts.length > putsBefore, 'Edit + blur still PUTs the new text');
    const savedNote = psql(`SELECT note FROM annotation WHERE annotation_id=${annId}`);
    assert(savedNote === 'a stable note now edited',
      `Edited note persisted (got "${savedNote}")`);

    // ---- Fix 2: clicking another sentence during the create POST ----

    // Delay the create POST so we can switch sentences mid-flight.
    await page.route('**/api/annotations', async route => {
      if (route.request().method() === 'POST') {
        await new Promise(r => setTimeout(r, 1500));
      }
      return route.continue();
    });

    await page.locator(`.sentence[data-sentence-id="${raceSidA}"]`).first().click();
    await page.waitForSelector('.sticky-note.uncreated-note.first-uncreated .note-input', { timeout: 5000 });
    await page.locator('.sticky-note.uncreated-note.first-uncreated .note-input').click();
    await page.keyboard.type('z'); // first char fires the delayed POST
    // While the POST is in flight, select a different sentence.
    await page.waitForTimeout(300);
    await page.locator(`.sentence[data-sentence-id="${raceSidB}"]`).first().click();
    // Let the POST resolve and everything settle.
    await page.waitForTimeout(3000);
    await page.unroute('**/api/annotations');

    const race = await page.evaluate(({ a, b }) => {
      const cache = (window.WriteSysRenderer && window.WriteSysRenderer.currentAnnotations) || [];
      const created = cache.find(x => (x.note || '').startsWith('z'));
      return {
        createdSentenceId: created ? created.sentence_id : null,
        currentSentenceId: window.WriteSysAnnotations.currentSentenceId,
        realNotesInPanel: document.querySelectorAll('#sticky-notes-container .sticky-note:not(.uncreated-note)').length,
        cachedForB: cache.filter(x => x.sentence_id === b).length,
      };
    }, { a: raceSidA, b: raceSidB });

    assert(race.createdSentenceId === raceSidA,
      `Local annotation object attached to the ORIGINAL sentence (got ${race.createdSentenceId}, want ${raceSidA})`);
    assert(race.cachedForB === 0,
      `No annotation leaked onto the newly-clicked sentence (got ${race.cachedForB})`);
    assert(race.currentSentenceId === raceSidB && race.realNotesInPanel === 0,
      `Panel for the newly-clicked sentence shows no stray note (got ${race.realNotesInPanel})`);

    const dbSentence = psql(`SELECT sentence_id FROM annotation WHERE note='z' AND deleted_at IS NULL`);
    assert(dbSentence === raceSidA,
      `Server row points at the original sentence (got "${dbSentence}")`);

    // Re-selecting the original sentence shows the note (cache add worked).
    await page.locator(`.sentence[data-sentence-id="${raceSidA}"]`).first().click();
    await page.waitForTimeout(500);
    const shownOnA = await page.evaluate(() =>
      document.querySelectorAll('#sticky-notes-container .sticky-note:not(.uncreated-note)').length);
    assert(shownOnA === 1, `Note appears when its own sentence is re-selected (got ${shownOnA})`);

  } catch (e) {
    console.log(`✗ Test errored: ${e.message}`);
    failed = true;
  } finally {
    await browser.close();
    await cleanupTestAnnotations();
  }

  if (failed) {
    console.log('\n❌ Test failed');
    process.exit(1);
  }
  console.log('\n✅ Test passed');
})().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
