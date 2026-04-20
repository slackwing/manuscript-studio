const { chromium } = require('playwright');
const { TEST_URL, TEST_MANUSCRIPT_ID, cleanupTestAnnotations, loginAsTestUser } = require('./test-utils');

(async () => {
  console.log('=== Tag API Test ===\n');

  await cleanupTestAnnotations();

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1600, height: 1000 });
  page.on('dialog', async d => { try { await d.dismiss(); } catch (e) {} });

  let failed = 0;

  try {
    await loginAsTestUser(page);
    await page.goto(TEST_URL);
    await page.waitForSelector('.pagedjs_page', { timeout: 30000 });
    await page.waitForSelector('.sentence', { timeout: 5000 });
    await page.waitForTimeout(2000);

    // Click a sentence and create an annotation via the UI (real per-note flow)
    const firstSentence = await page.locator('.sentence').first();
    const sentenceId = await firstSentence.getAttribute('data-sentence-id');
    console.log(`Sentence ID: ${sentenceId}`);

    await firstSentence.click();
    await page.waitForSelector('.sticky-note.uncreated-note', { timeout: 5000 });
    await page.waitForTimeout(500);

    // Type into the uncreated note's .note-input — auto-creates a yellow annotation
    const uncreatedInput = page.locator('.sticky-note.uncreated-note .note-input').first();
    await uncreatedInput.type('Test note for tag', { delay: 5 });
    await page.waitForSelector('.sticky-note:not(.uncreated-note)', { timeout: 5000 });
    await page.waitForTimeout(1500);

    // Grab authenticated cookies from the Playwright context for API calls
    const cookies = await page.context().cookies();
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    // Get the annotation ID via the API
    const apiUrl = 'http://localhost:5001';
    const annotationsResp = await fetch(`${apiUrl}/api/annotations/sentence/${sentenceId}`, {
      headers: { 'Cookie': cookieHeader }
    });
    const annotationsData = await annotationsResp.json();

    if (!annotationsData.annotations || annotationsData.annotations.length === 0) {
      console.log('✗ No annotation found for sentence');
      process.exit(1);
    }
    const annotationId = annotationsData.annotations[0].annotation_id;
    console.log(`✓ Annotation created with ID: ${annotationId}`);

    // Get migration ID
    const migrationResp = await fetch(`${apiUrl}/api/migrations/latest?manuscript_id=${TEST_MANUSCRIPT_ID}`, {
      headers: { 'Cookie': cookieHeader }
    });
    const migrationData = await migrationResp.json();
    const migrationId = migrationData.migration_id;
    console.log(`✓ Using migration ID: ${migrationId}`);

    // Test 1: Add a tag
    const addTagResp = await fetch(`${apiUrl}/api/annotations/${annotationId}/tags`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': cookieHeader },
      body: JSON.stringify({ tag_name: 'test-tag', migration_id: migrationId })
    });
    if (addTagResp.ok) {
      console.log(`✓ Tag added (status ${addTagResp.status})`);
    } else {
      console.log(`✗ Failed to add tag: ${addTagResp.status} ${await addTagResp.text()}`);
      failed++;
    }

    // Test 2: Get tags for annotation
    const getTagsResp = await fetch(`${apiUrl}/api/annotations/${annotationId}/tags`, {
      headers: { 'Cookie': cookieHeader }
    });
    const getTagsData = await getTagsResp.json();
    if (getTagsData.tags && getTagsData.tags.length === 1 && getTagsData.tags[0].tag_name === 'test-tag') {
      console.log('✓ Get tags successful');
    } else {
      console.log(`✗ Expected 1 tag, got: ${JSON.stringify(getTagsData.tags)}`);
      failed++;
    }

    // Test 3: Add another tag
    const addTag2Resp = await fetch(`${apiUrl}/api/annotations/${annotationId}/tags`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': cookieHeader },
      body: JSON.stringify({ tag_name: 'second-tag', migration_id: migrationId })
    });
    if (addTag2Resp.ok) {
      const getTagsResp2 = await fetch(`${apiUrl}/api/annotations/${annotationId}/tags`, {
        headers: { 'Cookie': cookieHeader }
      });
      const getTagsData2 = await getTagsResp2.json();
      console.log(`✓ Second tag added. Total tags: ${getTagsData2.tags.length}`);
    } else {
      console.log(`✗ Failed to add second tag`);
      failed++;
    }

    // Test 4: Remove a tag
    const tagId = getTagsData.tags[0].tag_id;
    const removeTagResp = await fetch(`${apiUrl}/api/annotations/${annotationId}/tags/${tagId}`, {
      method: 'DELETE',
      headers: { 'Cookie': cookieHeader }
    });
    if (removeTagResp.status === 204) {
      console.log('✓ Tag removed successfully');
    } else {
      console.log(`✗ Failed to remove tag: ${removeTagResp.status}`);
      failed++;
    }

    // Test 5: Verify tag was removed
    const getTagsResp3 = await fetch(`${apiUrl}/api/annotations/${annotationId}/tags`, {
      headers: { 'Cookie': cookieHeader }
    });
    const getTagsData3 = await getTagsResp3.json();
    if (getTagsData3.tags.length === 1 && getTagsData3.tags[0].tag_name === 'second-tag') {
      console.log('✓ Tag list correct after removal');
    } else {
      console.log(`✗ Expected 1 tag (second-tag), got: ${JSON.stringify(getTagsData3.tags)}`);
      failed++;
    }

    await cleanupTestAnnotations();

    if (failed > 0) {
      console.log(`\n❌ ${failed} assertion(s) failed`);
      process.exit(1);
    } else {
      console.log('\n✅ Tag API Test Complete!');
    }
  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error(error.stack);
    await cleanupTestAnnotations();
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
