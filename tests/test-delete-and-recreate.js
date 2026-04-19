/**
 * Test that verifies you can create a new annotation after deleting one
 * This tests whether soft-deleted annotations block new annotations due to unique constraint
 */

const { chromium } = require('playwright');
const { TEST_URL, cleanupTestAnnotations } = require('./test-utils');

async function testDeleteAndRecreate() {
  // Clean up any existing annotations before test
  await cleanupTestAnnotations();

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const errors = [];
  const alerts = [];

  page.on('console', msg => {
    if (msg.type() === 'error') {
      errors.push(msg.text());
    }
  });

  // Auto-accept confirmation dialogs for deletion
  page.on('dialog', async dialog => {
    if (dialog.message().includes('Delete this annotation?')) {
      console.log('   Accepting deletion confirmation');
      await dialog.accept();
    } else {
      alerts.push(dialog.message());
      console.log('❌ ALERT:', dialog.message());
      await dialog.dismiss();
    }
  });

  // Login first
  await loginAsTestUser(page);

  await page.goto(TEST_URL);
  await page.waitForTimeout(8000);

  console.log('=== Test: Delete annotation and create new one ===\n');

  // Step 1: Click a sentence
  const sentenceId = await page.evaluate(() => {
    const sentence = document.querySelector('.sentence');
    sentence.click();
    return sentence.dataset.sentenceId;
  });
  console.log('1. Selected sentence:', sentenceId);
  await page.waitForTimeout(500);

  // Step 2: Create annotation (yellow)
  await page.click('.color-circle[data-color="yellow"]');
  await page.waitForTimeout(1500);

  const hasYellow = await page.evaluate((sid) => {
    const sent = document.querySelector(`.sentence[data-sentence-id="${sid}"]`);
    return sent?.classList.contains('highlight-yellow');
  }, sentenceId);
  console.log('2. Created yellow annotation:', hasYellow);

  if (!hasYellow) {
    console.log('❌ FAILED: Could not create initial annotation');
    if (alerts.length > 0) console.log('   Alerts:', alerts);
    await browser.close();
    process.exit(1);
  }

  // Step 3: Delete annotation (toggle off by clicking yellow again)
  await page.click('.color-circle[data-color="yellow"]');
  await page.waitForTimeout(1500);

  const yellowRemoved = await page.evaluate((sid) => {
    const sent = document.querySelector(`.sentence[data-sentence-id="${sid}"]`);
    return !sent?.classList.contains('highlight-yellow');
  }, sentenceId);
  console.log('3. Deleted annotation (toggled off):', yellowRemoved);

  if (!yellowRemoved) {
    console.log('❌ FAILED: Could not delete annotation');
    await browser.close();
    process.exit(1);
  }

  // Clear error/alert tracking
  errors.length = 0;
  alerts.length = 0;

  // Step 4: Click the sentence again to reselect it
  await page.evaluate((sid) => {
    const sentence = document.querySelector(`.sentence[data-sentence-id="${sid}"]`);
    sentence.click();
  }, sentenceId);
  await page.waitForTimeout(500);

  // Step 5: Create NEW annotation with different color (green)
  console.log('4. Attempting to create NEW annotation (green) on same sentence...');
  await page.click('.color-circle[data-color="green"]');
  await page.waitForTimeout(1500);

  // Check if it worked
  const hasGreen = await page.evaluate((sid) => {
    const sent = document.querySelector(`.sentence[data-sentence-id="${sid}"]`);
    return sent?.classList.contains('highlight-green');
  }, sentenceId);

  console.log('5. New green annotation created:', hasGreen);

  if (errors.length > 0) {
    console.log('\n❌ Console errors:');
    errors.forEach(e => console.log('  ', e.substring(0, 150)));
  }

  if (alerts.length > 0) {
    console.log('\n❌ Alert dialogs:');
    alerts.forEach(a => console.log('  ', a));
  }

  await browser.close();

  // Clean up annotations after test
  await cleanupTestAnnotations();

  if (!hasGreen || alerts.length > 0) {
    console.log('\n❌ TEST FAILED: Cannot create new annotation after deleting old one');
    console.log('   This suggests the unique constraint does not account for soft deletes (deleted_at)');
    process.exit(1);
  } else {
    console.log('\n✅ TEST PASSED: Can create new annotation after deleting old one');
  }
}

testDeleteAndRecreate();
