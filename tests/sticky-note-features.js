const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1400, height: 900 });

  console.log('Testing sticky note features...\n');

  // Open the manuscript viewer
  // Login first
  await loginAsTestUser(page);

  await page.goto('http://localhost:5001?manuscript_id=1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);

  // Test 1: Default grey background
  console.log('Test 1: Checking default grey background...');
  const firstSentence = await page.locator('.sentence').first();
  await firstSentence.click();
  await page.waitForTimeout(500);

  let stickyNote = await page.locator('#sticky-note-container');
  let bgColor = await stickyNote.evaluate(el => window.getComputedStyle(el).backgroundColor);
  console.log(`  Default background: ${bgColor}`);
  await page.screenshot({ path: 'tests/screenshots/sticky-default.png' });

  // Test 2: Color change when selecting yellow
  console.log('\nTest 2: Selecting yellow color...');
  await page.locator('.color-circle[data-color="yellow"]').click();
  await page.waitForTimeout(300);

  let hasYellowClass = await stickyNote.evaluate(el => el.classList.contains('color-yellow'));
  console.log(`  Has yellow class: ${hasYellowClass}`);
  await page.screenshot({ path: 'tests/screenshots/sticky-yellow.png' });

  // Test 3: Type a long note to test auto-resize
  console.log('\nTest 3: Testing textarea auto-resize with long note...');
  const noteInput = await page.locator('#note-input');
  const longNote = 'This is a very long note that should cause the textarea to grow vertically. '.repeat(5);
  await noteInput.fill(longNote);
  await page.waitForTimeout(300);

  let textareaHeight = await noteInput.evaluate(el => el.offsetHeight);
  console.log(`  Textarea height after long note: ${textareaHeight}px`);
  await page.screenshot({ path: 'tests/screenshots/sticky-long-note.png' });

  // Test 4: Add tags to test wrapping and color inheritance
  console.log('\nTest 4: Adding tags to test wrapping and color inheritance...');
  await page.locator('.new-tag').click();
  await page.keyboard.type('character-development');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);

  await page.locator('.new-tag').click();
  await page.keyboard.type('foreshadowing');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);

  await page.locator('.new-tag').click();
  await page.keyboard.type('theme');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);

  let tagColors = await page.locator('.tag-chip:not(.new-tag)').evaluateAll(tags =>
    tags.map(tag => window.getComputedStyle(tag).backgroundColor)
  );
  console.log(`  Tag background colors: ${tagColors.join(', ')}`);
  await page.screenshot({ path: 'tests/screenshots/sticky-with-tags.png' });

  // Test 5: Click priority chip to test color inheritance
  console.log('\nTest 5: Testing priority chip color inheritance...');
  await page.locator('.priority-chip[data-priority="P1"]').click();
  await page.waitForTimeout(200);

  let p1Color = await page.locator('.priority-chip[data-priority="P1"]').evaluate(el =>
    window.getComputedStyle(el).backgroundColor
  );
  console.log(`  P1 chip background: ${p1Color}`);
  await page.screenshot({ path: 'tests/screenshots/sticky-with-priority.png' });

  // Test 6: Erase note to test grey revert
  console.log('\nTest 6: Erasing note to test grey background revert...');
  await noteInput.fill('');
  await page.waitForTimeout(300);

  hasYellowClass = await stickyNote.evaluate(el => el.classList.contains('color-yellow'));
  bgColor = await stickyNote.evaluate(el => window.getComputedStyle(el).backgroundColor);
  console.log(`  Has yellow class after erase: ${hasYellowClass}`);
  console.log(`  Background after erase: ${bgColor}`);
  await page.screenshot({ path: 'tests/screenshots/sticky-after-erase.png' });

  console.log('\n✓ All sticky note feature tests complete!');
  console.log('Screenshots saved to tests/screenshots/');

  await browser.close();
})();
