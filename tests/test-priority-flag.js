const { chromium } = require('playwright');
const { TEST_URL, cleanupTestAnnotations, loginAsTestUser } = require('./test-utils');

(async () => {
  console.log('=== Priority/Flag Chips Test ===\n');

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

    // Test 1: P/flag chips are per-note and exist only on real notes
    console.log('Test 1: Priority/flag chips absent on uncreated-note, present on real note...');
    const firstSentence = await page.locator('.sentence').first();
    const sentenceId = await firstSentence.getAttribute('data-sentence-id');
    await firstSentence.click();
    await page.waitForSelector('.sticky-note.uncreated-note', { timeout: 5000 });
    await page.waitForTimeout(500);

    const uncreatedHasChips = await page.locator('.sticky-note.uncreated-note .priority-chip').count();
    if (uncreatedHasChips === 0) {
      console.log('✓ Uncreated (grey) sticky note has no priority chips');
    } else {
      console.log(`✗ Uncreated note should not have priority chips (found ${uncreatedHasChips})`);
      failed++;
    }

    // Create a yellow annotation. Use force hover + retry because the palette
    // has a 200ms mouseleave delay that can flake with single-shot hover.
    async function createYellow() {
      for (let i = 0; i < 3; i++) {
        try {
          await page.locator('.sticky-note.uncreated-note .sticky-note-color-circle').first().hover({ force: true });
          await page.waitForTimeout(400);
          await page.waitForSelector('.sticky-note.uncreated-note .sticky-note-palette.visible', { timeout: 2000 });
          await page.locator('.sticky-note.uncreated-note .color-circle[data-color="yellow"]').first().click({ force: true });
          await page.waitForSelector('.sticky-note:not(.uncreated-note) .priority-chip[data-priority="P0"]', { timeout: 5000 });
          await page.waitForTimeout(600);
          return;
        } catch (e) {
          if (i === 2) throw e;
          await page.waitForTimeout(500);
        }
      }
    }
    await createYellow();

    const realHasChips = await page.locator('.sticky-note:not(.uncreated-note) .priority-chip').count();
    const realHasFlag = await page.locator('.sticky-note:not(.uncreated-note) .flag-chip').count();
    if (realHasChips >= 4 && realHasFlag >= 1) {
      console.log(`✓ Real sticky-note has priority (${realHasChips}) and flag (${realHasFlag}) controls`);
    } else {
      console.log(`✗ Real note should have 4 priority chips + 1 flag (got p=${realHasChips}, f=${realHasFlag})`);
      failed++;
    }

    // Test 2: priority-flag-container is visible on real note
    console.log('\nTest 2: priority-flag-container display...');
    const pfDisplay = await page.locator('.sticky-note:not(.uncreated-note) .priority-flag-container').first().evaluate(el => window.getComputedStyle(el).display);
    if (pfDisplay !== 'none') {
      console.log(`✓ priority-flag-container visible (display=${pfDisplay})`);
    } else {
      console.log(`✗ priority-flag-container should be visible, got display=${pfDisplay}`);
      failed++;
    }

    // Test 3: Click P0 — chip becomes active
    console.log('\nTest 3: Click P0...');
    const p0 = page.locator('.sticky-note:not(.uncreated-note) .priority-chip[data-priority="P0"]').first();
    await p0.click();
    await page.waitForTimeout(500);
    const p0Active = await p0.evaluate(el => el.classList.contains('active'));
    if (p0Active) {
      console.log('✓ P0 chip active after click');
    } else {
      console.log('✗ P0 chip not active');
      failed++;
    }

    // Test 4: Click P1 — radio (P0 deactivates, P1 activates)
    console.log('\nTest 4: Priority radio behavior...');
    const p1 = page.locator('.sticky-note:not(.uncreated-note) .priority-chip[data-priority="P1"]').first();
    await p1.click();
    await page.waitForTimeout(500);
    const p0StillActive = await p0.evaluate(el => el.classList.contains('active'));
    const p1Active = await p1.evaluate(el => el.classList.contains('active'));
    if (!p0StillActive && p1Active) {
      console.log('✓ P0 deactivated, P1 activated');
    } else {
      console.log(`✗ Expected P0 inactive & P1 active (P0 active=${p0StillActive}, P1 active=${p1Active})`);
      failed++;
    }

    // Test 5: Toggle P1 off
    console.log('\nTest 5: Priority toggle off...');
    await p1.click();
    await page.waitForTimeout(500);
    const p1StillActive = await p1.evaluate(el => el.classList.contains('active'));
    if (!p1StillActive) {
      console.log('✓ Clicking P1 again deactivates it');
    } else {
      console.log('✗ Clicking P1 again should toggle off');
      failed++;
    }

    // Test 6: Flag chip toggle
    console.log('\nTest 6: Flag chip toggle...');
    const flag = page.locator('.sticky-note:not(.uncreated-note) .flag-chip').first();
    await flag.click();
    await page.waitForTimeout(500);
    const flagActive = await flag.evaluate(el => el.classList.contains('active'));
    if (flagActive) {
      console.log('✓ Flag active after click');
    } else {
      console.log('✗ Flag should be active after click');
      failed++;
    }

    // Test 7: Flag independent from priority
    console.log('\nTest 7: Flag independent from priority...');
    const p2 = page.locator('.sticky-note:not(.uncreated-note) .priority-chip[data-priority="P2"]').first();
    await p2.click();
    await page.waitForTimeout(500);
    const flagStillActive = await flag.evaluate(el => el.classList.contains('active'));
    const p2Active = await p2.evaluate(el => el.classList.contains('active'));
    if (flagStillActive && p2Active) {
      console.log('✓ Flag remains active when priority is changed');
    } else {
      console.log(`✗ Expected flag active & P2 active (flag=${flagStillActive}, p2=${p2Active})`);
      failed++;
    }

    // Test 8: Persistence after reload
    console.log('\nTest 8: Persistence after reload...');
    await page.reload();
    await page.waitForSelector('.pagedjs_page', { timeout: 30000 });
    await page.waitForSelector('.sentence', { timeout: 5000 });
    await page.waitForTimeout(2000);

    await page.locator(`.sentence[data-sentence-id="${sentenceId}"]`).first().click();
    await page.waitForSelector('.sticky-note:not(.uncreated-note) .priority-chip[data-priority="P2"]', { timeout: 5000 });
    await page.waitForTimeout(500);

    const p2AfterReload = await page.locator('.sticky-note:not(.uncreated-note) .priority-chip[data-priority="P2"]').first().evaluate(el => el.classList.contains('active'));
    const flagAfterReload = await page.locator('.sticky-note:not(.uncreated-note) .flag-chip').first().evaluate(el => el.classList.contains('active'));
    if (p2AfterReload && flagAfterReload) {
      console.log('✓ P2 + flag state persists after reload');
    } else {
      console.log(`✗ State should persist (P2=${p2AfterReload}, flag=${flagAfterReload})`);
      failed++;
    }

    await cleanupTestAnnotations();

    if (failed > 0) {
      console.log(`\n❌ ${failed} assertion(s) failed`);
      process.exit(1);
    } else {
      console.log('\n✅ All Priority/Flag Tests Passed!');
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
