/**
 * Test to verify sticky notes maintain proper height when scrollable
 */

const { chromium } = require('playwright');
const { exit } = require('process');
const { TEST_URL, cleanupTestAnnotations, loginAsTestUser } = require('./test-utils');

async function runTests() {
  await cleanupTestAnnotations();

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`✓ ${message}`);
      passed++;
    } else {
      console.log(`✗ ${message}`);
      failed++;
    }
  }

  try {
    console.log('=== Scrollable Sticky Notes Test ===\n');

    // Load the page
  // Login first
  await loginAsTestUser(page);

    await page.goto(TEST_URL);
    await page.waitForTimeout(8000);

    // Click a sentence to show sticky notes panel
    await page.locator('.sentence').first().click();
    await page.waitForTimeout(500);

    // Create multiple notes with long text to trigger scrolling
    const longText = 'This is a very long note that should cause the textarea to expand vertically because it contains multiple lines of text. '.repeat(5);

    for (let i = 0; i < 8; i++) {
      // Type in the uncreated note to create it
      await page.locator('.uncreated-note .note-input').first().type(longText);
      await page.waitForTimeout(1000);

      // Click the subsequent + to add another note
      if (i < 7) {
        await page.locator('.uncreated-note').first().click();
        await page.waitForTimeout(300);
      }
    }

    // Check if container is scrollable
    const isScrollable = await page.evaluate(() => {
      const container = document.getElementById('sticky-notes-container');
      return container.scrollHeight > container.clientHeight;
    });
    assert(isScrollable, 'Container is scrollable with many notes');

    // Measure heights of all notes
    const noteHeights = await page.evaluate(() => {
      const notes = document.querySelectorAll('.sticky-note:not(.uncreated-note)');
      return Array.from(notes).map(note => {
        const textarea = note.querySelector('.note-input');
        const priorityContainer = note.querySelector('.priority-flag-container');
        const noteRect = note.getBoundingClientRect();
        const textareaRect = textarea.getBoundingClientRect();
        const priorityRect = priorityContainer ? priorityContainer.getBoundingClientRect() : null;

        return {
          noteHeight: noteRect.height,
          textareaHeight: textareaRect.height,
          noteBottom: noteRect.bottom,
          priorityTop: priorityRect ? priorityRect.top : null,
          priorityBottom: priorityRect ? priorityRect.bottom : null,
          // Check if priority chips are within note bounds
          priorityInBounds: priorityRect ? (priorityRect.bottom <= noteRect.bottom + 5) : true
        };
      });
    });

    // Verify all notes have expanded to fit their content
    const minExpectedHeight = 200; // Long text should make notes at least 200px tall
    const allNotesExpanded = noteHeights.every(h => h.noteHeight >= minExpectedHeight);
    assert(allNotesExpanded, `All notes expanded to fit content (heights: ${noteHeights.map(h => Math.round(h.noteHeight)).join(', ')})`);

    // Verify priority chips are within note bounds
    const allPrioritiesInBounds = noteHeights.every(h => h.priorityInBounds);
    const priorityPositions = noteHeights.map(h =>
      h.priorityBottom ? `${Math.round(h.noteBottom - h.priorityBottom)}px from bottom` : 'N/A'
    );
    assert(allPrioritiesInBounds, `Priority chips within note bounds (${priorityPositions.join(', ')})`);

    // Scroll the container and verify heights remain the same
    await page.evaluate(() => {
      const container = document.getElementById('sticky-notes-container');
      container.scrollTop = container.scrollHeight / 2;
    });
    await page.waitForTimeout(500);

    const noteHeightsAfterScroll = await page.evaluate(() => {
      const notes = document.querySelectorAll('.sticky-note:not(.uncreated-note)');
      return Array.from(notes).map(note => {
        const noteRect = note.getBoundingClientRect();
        const priorityContainer = note.querySelector('.priority-flag-container');
        const priorityRect = priorityContainer ? priorityContainer.getBoundingClientRect() : null;

        return {
          noteHeight: noteRect.height,
          noteBottom: noteRect.bottom,
          priorityBottom: priorityRect ? priorityRect.bottom : null,
          priorityInBounds: priorityRect ? (priorityRect.bottom <= noteRect.bottom + 5) : true
        };
      });
    });

    // Verify heights didn't change after scrolling
    const heightsMatch = noteHeights.every((before, i) => {
      const after = noteHeightsAfterScroll[i];
      return Math.abs(before.noteHeight - after.noteHeight) < 2; // Allow 1px rounding
    });
    assert(heightsMatch, 'Note heights remain consistent after scrolling');

    // Verify priorities still in bounds after scrolling
    const prioritiesStillInBounds = noteHeightsAfterScroll.every(h => h.priorityInBounds);
    assert(prioritiesStillInBounds, 'Priority chips still within bounds after scrolling');

    // Check scrollbar spacing
    const scrollbarSpacing = await page.evaluate(() => {
      const container = document.getElementById('sticky-notes-container');
      const computedStyle = window.getComputedStyle(container);
      return {
        paddingRight: computedStyle.paddingRight,
        overflowY: computedStyle.overflowY
      };
    });
    assert(scrollbarSpacing.overflowY === 'auto', `Container has overflow-y: auto (got ${scrollbarSpacing.overflowY})`);

    // Take screenshot
    await page.screenshot({ path: 'tests/screenshots/scrollable-notes.png', fullPage: true });

    console.log('\n=== Test Summary ===');
    console.log(`Passed: ${passed}`);
    console.log(`Failed: ${failed}`);
    console.log(`Total: ${passed + failed}`);
    console.log(`\nScreenshot saved to tests/screenshots/scrollable-notes.png`);

    await cleanupTestAnnotations();

    if (failed > 0) {
      console.log('\n❌ Some tests failed');
      await browser.close();
      exit(1);
    } else {
      console.log('\n✅ All tests passed!');
      await browser.close();
      exit(0);
    }

  } catch (error) {
    console.error('\n❌ Test crashed:', error);
    await cleanupTestAnnotations();
    await browser.close();
    exit(1);
  }
}

runTests();
