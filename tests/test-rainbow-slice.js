/**
 * Tests for rainbow-slice.js
 * Generic array deduplication utility tests
 */

const { rainbowSlice } = require('../web/js/rainbow-slice.js');

function assert(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
    return true;
  } else {
    console.log(`✗ ${message}`);
    return false;
  }
}

function arrayEqual(a, b) {
  return a.length === b.length && a.every((val, i) => val === b[i]);
}

function runTests() {
  let passed = 0;
  let failed = 0;

  function test(input, expected, description) {
    const result = rainbowSlice(input);
    const success = arrayEqual(result, expected);
    if (success) {
      passed++;
    } else {
      failed++;
    }
    assert(success, `${description}\n  Input:    [${input.join(', ')}]\n  Expected: [${expected.join(', ')}]\n  Got:      [${result.join(', ')}]`);
  }

  console.log('=== rainbow-slice.js Tests ===\n');

  // Test 1: All unique colors represented - deduplicate from back bit by bit
  test(
    ['yellow', 'yellow', 'green', 'yellow', 'blue', 'yellow'],
    ['yellow', 'green', 'yellow', 'blue'],
    'All 3 unique colors fit in 4 slots - deduplicate from back'
  );

  // Test 2: Duplicates hide unique colors - deduplicate and take first occurrence of each
  test(
    ['yellow', 'red', 'red', 'red', 'red', 'red', 'green', 'blue', 'purple'],
    ['red', 'green', 'blue', 'purple'],
    'Four unique values fit in 4 slots - deduplicate'
  );

  // Test 3: All same color
  test(
    ['yellow', 'yellow', 'yellow', 'yellow', 'yellow'],
    ['yellow', 'yellow', 'yellow', 'yellow'],
    'All same color - non-dedupe fits and represents all colors'
  );

  // Test 4: Only 2 items total
  test(
    ['yellow', 'green'],
    ['green'],
    'Only 1 item after skip - return it'
  );

  // Test 5: Exactly 5 items, all unique
  test(
    ['yellow', 'green', 'blue', 'purple', 'red'],
    ['green', 'blue', 'purple', 'red'],
    '4 unique after skip - take all 4'
  );

  // Test 6: Many items, all unique
  test(
    ['yellow', 'green', 'blue', 'purple', 'red', 'orange'],
    ['green', 'blue', 'purple', 'red'],
    '5 unique but only 4 slots - take first 4'
  );

  // Test 7: Adjacent duplicates
  test(
    ['yellow', 'green', 'green', 'blue', 'blue', 'purple'],
    ['green', 'green', 'blue', 'purple'],
    'Three unique fit in 4 slots - deduplicate from back, keep one duplicate'
  );

  // Test 8: Empty array
  test(
    [],
    [],
    'Empty array - return empty'
  );

  // Test 9: Single item
  test(
    ['yellow'],
    [],
    'Single item (skip=1) - return empty'
  );

  // Test 10: Alternating pattern
  test(
    ['yellow', 'green', 'yellow', 'green', 'yellow', 'green'],
    ['green', 'yellow', 'green', 'yellow'],
    'Two unique colors - deduplicate from back, preserve pattern'
  );

  // Test 11: Three of one, one of another
  test(
    ['yellow', 'red', 'red', 'red', 'green'],
    ['red', 'red', 'red', 'green'],
    'Non-dedupe (4 items) fits in 4 slots and represents all colors'
  );

  // Test 12: Last duplicate removed
  test(
    ['yellow', 'red', 'green', 'blue', 'blue', 'purple'],
    ['red', 'green', 'blue', 'purple'],
    'Four unique fit in 4 slots - deduplicate'
  );

  // Test 13: Two pairs of duplicates
  test(
    ['yellow', 'red', 'red', 'green', 'green', 'blue', 'purple'],
    ['red', 'green', 'blue', 'purple'],
    'Four unique fit in 4 slots - deduplicate both pairs'
  );

  // Test 14: More unique values than slots - take first maxSize
  test(
    ['yellow', 'red', 'green', 'blue', 'purple', 'orange', 'pink'],
    ['red', 'green', 'blue', 'purple'],
    'Six unique but only 4 slots - take first 4 (cannot fit all anyway)'
  );

  // Test 15: Many duplicates at start hiding later uniques
  test(
    ['yellow', 'red', 'red', 'red', 'red', 'red', 'red', 'green', 'blue', 'purple', 'orange'],
    ['red', 'green', 'blue', 'purple'],
    'Five unique total, deduplicate to fit max 4'
  );

  // Test 16: Alternating duplicates
  test(
    ['yellow', 'red', 'green', 'red', 'green', 'blue'],
    ['red', 'green', 'red', 'blue'],
    'Three unique - deduplicate from back, preserve one duplicate'
  );

  // Test 17: Three duplicates at end
  test(
    ['yellow', 'red', 'green', 'blue', 'blue', 'blue', 'purple'],
    ['red', 'green', 'blue', 'purple'],
    'Four unique - deduplicate triple at end'
  );

  // Test 18: All unique values represented with duplicates
  test(
    ['yellow', 'red', 'red', 'red', 'green'],
    ['red', 'red', 'red', 'green'],
    'Non-dedupe (4 items) fits and represents all unique values'
  );

  // Test 19: Non-dedupe can fully represent all colors - use non-dedupe
  test(
    ['blue', 'blue', 'blue'],
    ['blue', 'blue'],
    'Non-dedupe (2 items) fits in 4 slots and represents all colors - keep duplicates'
  );

  // Test 20: Only one unique color in remaining array - don't deduplicate
  test(
    ['blue', 'yellow', 'yellow', 'yellow', 'yellow', 'yellow'],
    ['yellow', 'yellow', 'yellow', 'yellow'],
    'Five yellows but only 1 unique - take first 4 (deduplication would lose quantity info)'
  );

  // Test 21: Multiple colors with many duplicates - deduplicate from back bit by bit
  test(
    ['b', 'y', 'g', 'g', 'y', 'y', 'y', 'g'],
    ['y', 'g', 'g', 'y'],
    'Complex pattern - deduplicate from back preserving quantity info'
  );

  // Test 22: Custom skip parameter (skip 2)
  const custom1 = rainbowSlice(['a', 'b', 'c', 'd', 'e', 'f'], { skip: 2, maxSize: 4 });
  const custom1Expected = ['c', 'd', 'e', 'f'];
  if (arrayEqual(custom1, custom1Expected)) {
    passed++;
    assert(true, `Custom skip=2 - works correctly\n  Got: [${custom1.join(', ')}]`);
  } else {
    failed++;
    assert(false, `Custom skip=2 - failed\n  Expected: [${custom1Expected.join(', ')}]\n  Got: [${custom1.join(', ')}]`);
  }

  // Test 22: Custom maxSize parameter (maxSize 2)
  const custom2 = rainbowSlice(['yellow', 'red', 'green', 'blue', 'purple'], { skip: 1, maxSize: 2 });
  const custom2Expected = ['red', 'green'];
  if (arrayEqual(custom2, custom2Expected)) {
    passed++;
    assert(true, `Custom maxSize=2 - works correctly\n  Got: [${custom2.join(', ')}]`);
  } else {
    failed++;
    assert(false, `Custom maxSize=2 - failed\n  Expected: [${custom2Expected.join(', ')}]\n  Got: [${custom2.join(', ')}]`);
  }

  // Test 23: Skip 0 (include first item)
  const custom3 = rainbowSlice(['yellow', 'yellow', 'green', 'blue'], { skip: 0, maxSize: 4 });
  const custom3Expected = ['yellow', 'yellow', 'green', 'blue'];
  if (arrayEqual(custom3, custom3Expected)) {
    passed++;
    assert(true, `Custom skip=0 - works correctly\n  Got: [${custom3.join(', ')}]`);
  } else {
    failed++;
    assert(false, `Custom skip=0 - failed\n  Expected: [${custom3Expected.join(', ')}]\n  Got: [${custom3.join(', ')}]`);
  }

  console.log('\n=== Test Summary ===');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total: ${passed + failed}`);

  if (failed > 0) {
    console.log('\n❌ Some tests failed');
    process.exit(1);
  } else {
    console.log('\n✅ All tests passed!');
    process.exit(0);
  }
}

runTests();
