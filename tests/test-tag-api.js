const { chromium } = require('playwright');
const { TEST_URL, TEST_MANUSCRIPT_ID, cleanupTestAnnotations } = require('./test-utils');

(async () => {
  console.log('=== Tag API Test ===\n');

  await cleanupTestAnnotations();

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    // Load the page
  // Login first
  await loginAsTestUser(page);

    await page.goto(TEST_URL);
    await page.waitForSelector('.pagedjs_page', { timeout: 30000 });
    await page.waitForSelector('.sentence', { timeout: 5000 });
    await page.waitForTimeout(2000);

    // Click a sentence and create an annotation
    const firstSentence = await page.locator('.sentence').first();
    const sentenceId = await firstSentence.getAttribute('data-sentence-id');
    console.log(`Sentence ID: ${sentenceId}`);

    await firstSentence.click();
    await page.waitForTimeout(300);

    // Type a note to create the annotation
    const noteInput = await page.locator('#note-input');
    await noteInput.type('Test note for tag');
    await page.waitForTimeout(500);

    // Wait for the annotation to be saved
    await page.waitForTimeout(1500);

    // Get the annotation ID from the API
    const apiUrl = 'http://localhost:5001';
    const annotationsResp = await fetch(`${apiUrl}/api/annotations/sentence/${sentenceId}`);
    const annotationsData = await annotationsResp.json();

    if (!annotationsData.annotations || annotationsData.annotations.length === 0) {
      console.log('✗ No annotation found for sentence');
      process.exit(1);
    }

    const annotationId = annotationsData.annotations[0].annotation_id;
    console.log(`✓ Annotation created with ID: ${annotationId}`);

    // Get the migration ID from the latest migration
    const migrationResp = await fetch(`${apiUrl}/api/migrations/latest?manuscript_id=${TEST_MANUSCRIPT_ID}`);
    const migrationData = await migrationResp.json();
    const migrationId = migrationData.migration_id;
    console.log(`✓ Using migration ID: ${migrationId}`);

    // Test 1: Add a tag
    const addTagResp = await fetch(`${apiUrl}/api/annotations/${annotationId}/tags`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tag_name: 'test-tag',
        migration_id: migrationId
      })
    });

    if (addTagResp.ok) {
      const addTagData = await addTagResp.json();
      console.log(`✓ Tag added successfully: ${JSON.stringify(addTagData.tags)}`);
    } else {
      console.log(`✗ Failed to add tag: ${addTagResp.status} ${await addTagResp.text()}`);
      process.exit(1);
    }

    // Test 2: Get tags for annotation
    const getTagsResp = await fetch(`${apiUrl}/api/annotations/${annotationId}/tags`);
    const getTagsData = await getTagsResp.json();

    if (getTagsData.tags && getTagsData.tags.length === 1 && getTagsData.tags[0].tag_name === 'test-tag') {
      console.log('✓ Get tags successful');
    } else {
      console.log(`✗ Expected 1 tag, got: ${JSON.stringify(getTagsData.tags)}`);
    }

    // Test 3: Add another tag
    const addTag2Resp = await fetch(`${apiUrl}/api/annotations/${annotationId}/tags`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tag_name: 'second-tag',
        migration_id: migrationId
      })
    });

    if (addTag2Resp.ok) {
      const addTag2Data = await addTag2Resp.json();
      console.log(`✓ Second tag added. Total tags: ${addTag2Data.tags.length}`);
    } else {
      console.log(`✗ Failed to add second tag`);
    }

    // Test 4: Remove a tag
    const tagId = getTagsData.tags[0].tag_id;
    const removeTagResp = await fetch(`${apiUrl}/api/annotations/${annotationId}/tags/${tagId}`, {
      method: 'DELETE'
    });

    if (removeTagResp.status === 204) {
      console.log('✓ Tag removed successfully');
    } else {
      console.log(`✗ Failed to remove tag: ${removeTagResp.status}`);
    }

    // Test 5: Verify tag was removed
    const getTagsResp2 = await fetch(`${apiUrl}/api/annotations/${annotationId}/tags`);
    const getTagsData2 = await getTagsResp2.json();

    if (getTagsData2.tags.length === 1 && getTagsData2.tags[0].tag_name === 'second-tag') {
      console.log('✓ Tag list correct after removal');
    } else {
      console.log(`✗ Expected 1 tag (second-tag), got: ${JSON.stringify(getTagsData2.tags)}`);
    }

    console.log('\n✅ Tag API Test Complete!');

    await cleanupTestAnnotations();

  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
