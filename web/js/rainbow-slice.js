/**
 * Skip `skip` items, then return up to `maxSize` from what's left, preferring
 * variety: if there's room, keep duplicates (quantity cue); if there isn't,
 * drop duplicates from the back so every unique value gets shown.
 *
 * Used for annotation-color sidebar bars (first annotation = sentence highlight,
 * next up to 4 = sidebar bars).
 *
 * See test-rainbow-slice.js.
 *
 * @example
 * rainbowSlice(['yellow', 'green', 'green', 'blue', 'blue', 'purple'])
 * // => ['green', 'blue', 'purple']  (3 uniques fit in 4 slots)
 *
 * @example
 * rainbowSlice(['yellow', 'red', 'green', 'blue', 'purple', 'orange'])
 * // => ['red', 'green', 'blue', 'purple']  (can't fit all 5)
 */
function rainbowSlice(array, options = {}) {
  const { skip = 1, maxSize = 4 } = options;

  if (!array || array.length === 0) return [];
  if (array.length <= skip) return [];

  const remaining = array.slice(skip);
  if (remaining.length === 0) return [];

  // Everything fits as-is — keep duplicates to preserve quantity/emphasis.
  if (remaining.length <= maxSize) {
    return remaining;
  }

  const uniqueInRemaining = new Set(remaining).size;

  if (uniqueInRemaining === 1) {
    return remaining.slice(0, maxSize);
  }

  // Drop duplicates from the back until we fit, preserving the unique values.
  const result = [];
  const seenFromFront = new Set();

  for (const item of remaining) {
    if (result.length >= maxSize) break;

    if (!seenFromFront.has(item)) {
      seenFromFront.add(item);
      result.push(item);
    } else {
      // Keep the duplicate only if there's room after all the remaining uniques.
      const remainingItems = remaining.slice(result.length);
      const remainingUniques = new Set(remainingItems.filter(x => !seenFromFront.has(x))).size;
      const slotsLeft = maxSize - result.length;

      if (slotsLeft > remainingUniques) {
        result.push(item);
      }
    }
  }

  return result;
}

// Export for Node (tests) and browser.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { rainbowSlice };
}
