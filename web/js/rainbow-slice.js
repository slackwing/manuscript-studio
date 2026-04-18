/**
 * rainbow-slice.js
 *
 * Generic array utility for extracting a slice with smart deduplication.
 *
 * Use case: Given an ordered list of items, skip the first N, then take up to M items.
 * Goal: Show as many unique values as possible within M slots.
 *
 * Algorithm:
 * 1. Get all unique values from the remaining array (after skip)
 * 2. If unique values <= maxSize: Deduplicate to show each unique value once
 * 3. If unique values > maxSize: Just take first maxSize items (can't fit all anyway)
 *
 * Example use case: Showing annotation colors as sidebar bars
 * - First annotation = sentence highlight color (skip it)
 * - Next 4 annotations = sidebar bars (max 4)
 * - Show as many different colors as possible in those 4 bars
 */

/**
 * Extract a slice from an array with smart deduplication to maximize unique value representation
 *
 * @param {Array} array - The input array
 * @param {Object} options - Configuration options
 * @param {number} options.skip - Number of items to skip from the start (default: 1)
 * @param {number} options.maxSize - Maximum number of items in result (default: 4)
 * @returns {Array} - The resulting slice, optimized to show maximum unique values
 *
 * @example
 * // All unique colors fit - deduplicate to show variety
 * rainbowSlice(['yellow', 'green', 'green', 'blue', 'blue', 'purple'])
 * // Returns: ['green', 'blue', 'purple'] (3 unique values fit in 4 slots)
 *
 * @example
 * // More unique than slots - take first maxSize
 * rainbowSlice(['yellow', 'red', 'green', 'blue', 'purple', 'orange'])
 * // Returns: ['red', 'green', 'blue', 'purple'] (can't fit all 5 anyway)
 */
function rainbowSlice(array, options = {}) {
  const { skip = 1, maxSize = 4 } = options;

  // Handle edge cases
  if (!array || array.length === 0) return [];
  if (array.length <= skip) return [];

  // Get the remaining array after skip
  const remaining = array.slice(skip);
  if (remaining.length === 0) return [];

  // Decision: Should we deduplicate or keep original order?
  // If the non-deduplicated remaining array fits in maxSize, use it as-is
  // Only deduplicate if we need to save space to show more variety

  if (remaining.length <= maxSize) {
    // Everything fits - return as-is to preserve emphasis/quantity
    return remaining;
  }

  // Too many items to fit - deduplicate from the back bit by bit
  // Remove duplicates from the end until we fit in maxSize
  // This preserves as much quantity/order information as possible

  const uniqueInRemaining = new Set(remaining).size;

  // If only one unique value, just take first maxSize (no duplicates to remove)
  if (uniqueInRemaining === 1) {
    return remaining.slice(0, maxSize);
  }

  // Multiple unique values - deduplicate from the back
  // Strategy: Remove items from the end if they're duplicates of earlier items
  const result = [];
  const seenFromFront = new Set();

  for (const item of remaining) {
    // Stop if we've collected enough items
    if (result.length >= maxSize) break;

    // Always include first occurrence
    if (!seenFromFront.has(item)) {
      seenFromFront.add(item);
      result.push(item);
    } else {
      // This is a duplicate - check if we should include it
      // Only include duplicates if we have room after accounting for remaining uniques
      const remainingItems = remaining.slice(result.length);
      const remainingUniques = new Set(remainingItems.filter(x => !seenFromFront.has(x))).size;
      const slotsLeft = maxSize - result.length;

      // Include this duplicate if we have room after all uniques
      if (slotsLeft > remainingUniques) {
        result.push(item);
      }
    }
  }

  return result;
}

// Export for Node.js (tests) and browser
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { rainbowSlice };
}
