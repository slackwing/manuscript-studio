package fractional

import (
	"fmt"
	"strings"
)

// GeneratePositionBetween generates a lexicographically ordered position string
// between two existing positions. This implements fractional indexing for annotation ordering.
//
// Examples:
//   - GeneratePositionBetween("", "a0001") -> "a0000" (before first)
//   - GeneratePositionBetween("a0001", "") -> "a0002" (after last)
//   - GeneratePositionBetween("a0000", "a0002") -> "a0001" (between)
//   - GeneratePositionBetween("a0000", "a0001") -> "a00005" (midpoint with more precision)
func GeneratePositionBetween(before, after string) (string, error) {
	// Case 1: Insert at beginning (before all)
	if before == "" && after != "" {
		return decrementPosition(after)
	}

	// Case 2: Insert at end (after all)
	if before != "" && after == "" {
		return incrementPosition(before)
	}

	// Case 3: Insert between two positions
	if before != "" && after != "" {
		return midpoint(before, after)
	}

	// Case 4: First item ever
	return "a0000", nil
}

// incrementPosition generates the next position after the given one
// "a0000" -> "a0001"
// "a9999" -> "b0000"
func incrementPosition(pos string) (string, error) {
	if pos == "" {
		return "a0000", nil
	}

	// Extract prefix and numeric part
	prefix := pos[0:1]
	numStr := pos[1:]

	var num int
	fmt.Sscanf(numStr, "%d", &num)

	num++

	// If we overflow the numeric part, increment the prefix
	if num > 9999 {
		if prefix[0] >= 'z' {
			return "", fmt.Errorf("position overflow: cannot increment beyond z9999")
		}
		return string(prefix[0]+1) + "0000", nil
	}

	return fmt.Sprintf("%s%04d", prefix, num), nil
}

// decrementPosition generates the previous position before the given one
// "a0001" -> "a0000"
// "a0000" -> "Z9999" (wraps to previous letter)
func decrementPosition(pos string) (string, error) {
	if pos == "" {
		return "a0000", nil
	}

	// Extract prefix and numeric part
	prefix := pos[0:1]
	numStr := pos[1:]

	var num int
	fmt.Sscanf(numStr, "%d", &num)

	num--

	// If we underflow, decrement the prefix
	if num < 0 {
		if prefix[0] <= 'A' {
			return "", fmt.Errorf("position underflow: cannot decrement below A0000")
		}
		return string(prefix[0]-1) + "9999", nil
	}

	return fmt.Sprintf("%s%04d", prefix, num), nil
}

// midpoint generates a position between two positions
// "a0000" and "a0002" -> "a0001"
// "a0000" and "a0001" -> "a00005" (adds more precision)
func midpoint(before, after string) (string, error) {
	if before >= after {
		return "", fmt.Errorf("invalid positions: before (%s) must be < after (%s)", before, after)
	}

	// If the positions have a simple gap, use the middle
	beforePrefix := before[0:1]
	afterPrefix := after[0:1]

	if beforePrefix == afterPrefix {
		beforeNum := 0
		afterNum := 0
		fmt.Sscanf(before[1:], "%d", &beforeNum)
		fmt.Sscanf(after[1:], "%d", &afterNum)

		// If there's room between them
		if afterNum - beforeNum > 1 {
			midNum := (beforeNum + afterNum) / 2
			return fmt.Sprintf("%s%04d", beforePrefix, midNum), nil
		}

		// Need more precision - append a digit
		// "a0000" and "a0001" -> "a00005"
		return before + "5", nil
	}

	// Different prefixes - should not happen in normal use
	return "", fmt.Errorf("positions have different prefixes: %s and %s", before, after)
}

// GetPositionAtIndex calculates the position for inserting at a specific index
// in a list of existing positions
func GetPositionAtIndex(positions []string, index int) (string, error) {
	// Validate index
	if index < 0 {
		return "", fmt.Errorf("invalid index: %d (must be >= 0)", index)
	}

	if index > len(positions) {
		return "", fmt.Errorf("invalid index: %d (max is %d)", index, len(positions))
	}

	// Case 1: Insert at beginning
	if index == 0 {
		if len(positions) == 0 {
			return "a0000", nil
		}
		return GeneratePositionBetween("", positions[0])
	}

	// Case 2: Insert at end
	if index == len(positions) {
		return GeneratePositionBetween(positions[len(positions)-1], "")
	}

	// Case 3: Insert in middle
	return GeneratePositionBetween(positions[index-1], positions[index])
}

// NormalizePosition ensures a position string is in the standard format
func NormalizePosition(pos string) string {
	if pos == "" {
		return "a0000"
	}

	// Trim any whitespace
	pos = strings.TrimSpace(pos)

	// Ensure it has at least a prefix and 4 digits
	if len(pos) < 5 {
		return "a0000"
	}

	return pos
}
