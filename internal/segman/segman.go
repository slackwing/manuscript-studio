package segman

import (
	"strings"
	"unicode"
)

// Version is segman's library version. Bumped by tools/bump-version.sh
// alongside js/segman.js, rust/Cargo.toml, and the root VERSION.json so
// all four stay in lockstep. The same string is what consumers should
// stamp onto their own data when they need to record "which segmenter
// produced this".
const Version = "1.0.0"

// nestedRegion represents a nested structure (quotes, parens, brackets, italics)
type nestedRegion struct {
	start int
	end   int
	typ   rune // '(', '[', '"', '*'
}

// boundaryMark represents a position where we should split sentences
type boundaryMark struct {
	pos    int
	reason string // for debugging
}

// isCommonAbbreviation checks if the word before a period is a common abbreviation
func isCommonAbbreviation(word string) bool {
	// Convert to lowercase for case-insensitive comparison
	lower := strings.ToLower(word)

	// Common abbreviations
	abbreviations := []string{
		"mr", "mrs", "ms", "dr", "prof", "sr", "jr",
		"st", "ave", "blvd", "rd", "ln", "ct",
		"jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
		"mon", "tue", "wed", "thu", "fri", "sat", "sun",
		"etc", "vs", "vol", "no", "pp", "ed", "eds",
		"co", "corp", "inc", "ltd",
	}

	for _, abbr := range abbreviations {
		if lower == abbr {
			return true
		}
	}

	// Note: Single letters (initials) are NOT automatically abbreviations here.
	// They're handled by the "followed by lowercase" heuristic in RULE 5.

	// Check for a.m. and p.m. patterns (already has a period before)
	if lower == "m" {
		return true // handles "a.m." and "p.m."
	}

	// Check for common Latin abbreviations
	if lower == "e" || lower == "i" {
		return true // handles "e.g.", "i.e."
	}

	return false
}

// Segment splits text into sentences using a 3-phase architecture:
// Phase 1: Mark all nested structures (quotes, parens, brackets, italics)
// Phase 2: Mark sentence boundaries (respecting nested regions)
// Phase 3: Split at boundaries and return sentences
func Segment(text string) []string {
	text = strings.TrimSpace(text)
	if text == "" {
		return []string{}
	}

	runes := []rune(text)

	// PHASE 1: Mark all nested structures
	regions := markNestedRegions(runes)

	// PHASE 2: Mark sentence boundaries
	boundaries := markBoundaries(runes, regions)

	// PHASE 3: Split at boundaries
	return splitAtBoundaries(runes, boundaries)
}

// markNestedRegions finds all nested structures in the text (1 level only)
func markNestedRegions(runes []rune) []nestedRegion {
	var regions []nestedRegion

	// Find all types of nested structures
	regions = append(regions, findQuotes(runes)...)
	regions = append(regions, findParentheses(runes)...)
	regions = append(regions, findBrackets(runes)...)
	regions = append(regions, findItalics(runes)...)

	return regions
}

// findQuotes finds all quoted text (both straight and curly quotes)
func findQuotes(runes []rune) []nestedRegion {
	var regions []nestedRegion
	var start int = -1

	for i, r := range runes {
		// Handle curly quotes specifically
		if r == '\u201C' { // Left curly quote - always opens
			if start == -1 {
				start = i
			}
		} else if r == '\u201D' { // Right curly quote - always closes
			if start != -1 {
				regions = append(regions, nestedRegion{start: start, end: i, typ: '"'})
				start = -1
			}
		} else if r == '"' { // Straight quote - toggle
			if start == -1 {
				start = i // Open quote
			} else {
				regions = append(regions, nestedRegion{start: start, end: i, typ: '"'})
				start = -1 // Close quote
			}
		}
	}

	// Handle unclosed quote at end
	if start != -1 {
		regions = append(regions, nestedRegion{start: start, end: len(runes) - 1, typ: '"'})
	}

	return regions
}

// findParentheses finds all parenthetical text
func findParentheses(runes []rune) []nestedRegion {
	var regions []nestedRegion
	var start int = -1

	for i, r := range runes {
		if r == '(' && start == -1 {
			start = i
		} else if r == ')' && start != -1 {
			regions = append(regions, nestedRegion{start: start, end: i, typ: '('})
			start = -1
		}
	}

	return regions
}

// findBrackets finds all editorial brackets
func findBrackets(runes []rune) []nestedRegion {
	var regions []nestedRegion
	var start int = -1

	for i, r := range runes {
		if r == '[' && start == -1 {
			start = i
		} else if r == ']' && start != -1 {
			regions = append(regions, nestedRegion{start: start, end: i, typ: '['})
			start = -1
		}
	}

	return regions
}

// findItalics finds all italicized text (marked with asterisks)
func findItalics(runes []rune) []nestedRegion {
	var regions []nestedRegion
	var start int = -1

	for i, r := range runes {
		if r == '*' {
			if start == -1 {
				start = i
			} else {
				regions = append(regions, nestedRegion{start: start, end: i, typ: '*'})
				start = -1
			}
		}
	}

	return regions
}

// markBoundaries identifies all positions where sentences should split
func markBoundaries(runes []rune, regions []nestedRegion) []boundaryMark {
	var boundaries []boundaryMark

	// Helper: check if position is inside a nested region
	insideNested := func(pos int) bool {
		for _, r := range regions {
			// Include both opening and closing delimiters in the protected region
			if pos >= r.start && pos <= r.end {
				return true
			}
		}
		return false
	}

	// Helper: check if position is inside a quote, paren, or italic region (not brackets)
	insideQuoteOrOther := func(pos int) bool {
		for _, r := range regions {
			if r.typ != '[' { // Exclude bracket regions
				// Include both opening and closing delimiters in the protected region
				if pos >= r.start && pos <= r.end {
					return true
				}
			}
		}
		return false
	}

	// RULE 1: Editorial brackets create boundaries (unless the boundary would be inside quotes/parens/italics)
	for _, region := range regions {
		if region.typ == '[' {
			// Boundary before bracket (only if not inside quotes/parens/italics)
			if region.start > 0 && !insideQuoteOrOther(region.start) {
				boundaries = append(boundaries, boundaryMark{pos: region.start, reason: "before bracket"})
			}
			// Boundary after bracket (only if not inside quotes/parens/italics)
			if region.end < len(runes)-1 && !insideQuoteOrOther(region.end+1) {
				boundaries = append(boundaries, boundaryMark{pos: region.end + 1, reason: "after bracket"})
			}
		}
	}

	// RULE 2: Standalone parentheticals with sentence-ending punctuation
	for _, region := range regions {
		if region.typ == '(' {
			// Check if preceded by sentence-ending punctuation (skip whitespace)
			hasPrecedingPunct := false
			for i := region.start - 1; i >= 0; i-- {
				if runes[i] == ' ' || runes[i] == '\t' || runes[i] == '\n' {
					continue // Skip whitespace
				}
				if runes[i] == '.' || runes[i] == '!' || runes[i] == '?' {
					hasPrecedingPunct = true
				}
				break // Stop at first non-whitespace
			}

			// Check if contains sentence-ending punctuation
			hasInternalPunct := false
			for i := region.start + 1; i < region.end; i++ {
				if runes[i] == '.' || runes[i] == '!' || runes[i] == '?' {
					hasInternalPunct = true
					break
				}
			}

			// If both conditions met, it's a standalone parenthetical
			if hasPrecedingPunct && hasInternalPunct {
				boundaries = append(boundaries, boundaryMark{pos: region.start, reason: "standalone paren"})
				if region.end < len(runes)-1 {
					boundaries = append(boundaries, boundaryMark{pos: region.end + 1, reason: "after standalone paren"})
				}
			}
		}
	}

	// RULE 3: Standalone dialogue (newline + tab + quote)
	for _, region := range regions {
		if region.typ == '"' {
			// Check if quote starts after \n\t or \n
			if region.start >= 2 && runes[region.start-2] == '\n' && runes[region.start-1] == '\t' {
				// Always create boundary before standalone dialogue
				boundaries = append(boundaries, boundaryMark{pos: region.start - 2, reason: "before standalone dialogue"})

				// Check if there's lowercase word after quote (attribution after)
				if region.end+1 < len(runes) {
					j := region.end + 1
					for j < len(runes) && (runes[j] == ' ' || runes[j] == '\t') {
						j++
					}

					// Check for attribution (lowercase word, "I <lowercase>", or period on same line)
					hasAttribution := false
					if j < len(runes) {
						if unicode.IsLower(runes[j]) {
							hasAttribution = true
						} else if runes[j] == 'I' {
							// Check for "I <lowercase>" pattern (e.g., "I said")
							k := j + 1
							for k < len(runes) && (runes[k] == ' ' || runes[k] == '\t') {
								k++
							}
							if k < len(runes) && unicode.IsLower(runes[k]) {
								hasAttribution = true
							}
						} else if unicode.IsUpper(runes[j]) {
							// Check if there's a period on the same line (before newline)
							// This catches proper noun attributions like "Jaime said," or "Dave asked,"
							k := j
							for k < len(runes) && runes[k] != '\n' && runes[k] != '"' && runes[k] != '\u201C' {
								if runes[k] == '.' {
									hasAttribution = true
									break
								}
								k++
							}
						}
					}

					if hasAttribution {
						// Find end of sentence (period after attribution)
						// Stop if we hit a quote (continuation of split quote) or newline
						for j < len(runes) && runes[j] != '.' && runes[j] != '\n' && runes[j] != '"' && runes[j] != '\u201C' {
							j++
						}
						if j < len(runes) && runes[j] == '.' {
							boundaries = append(boundaries, boundaryMark{pos: j + 1, reason: "after dialogue+attribution"})
						}
					} else if region.end < len(runes)-1 {
						boundaries = append(boundaries, boundaryMark{pos: region.end + 1, reason: "after standalone dialogue"})
					}
				}
			} else if region.start >= 1 && runes[region.start-1] == '\n' {
				boundaries = append(boundaries, boundaryMark{pos: region.start - 1, reason: "before standalone dialogue"})

				// Check for attribution after
				if region.end+1 < len(runes) {
					j := region.end + 1
					for j < len(runes) && (runes[j] == ' ' || runes[j] == '\t') {
						j++
					}

					// Check for attribution (lowercase word, "I <lowercase>", or period on same line)
					hasAttribution := false
					if j < len(runes) {
						if unicode.IsLower(runes[j]) {
							hasAttribution = true
						} else if runes[j] == 'I' {
							// Check for "I <lowercase>" pattern (e.g., "I said")
							k := j + 1
							for k < len(runes) && (runes[k] == ' ' || runes[k] == '\t') {
								k++
							}
							if k < len(runes) && unicode.IsLower(runes[k]) {
								hasAttribution = true
							}
						} else if unicode.IsUpper(runes[j]) {
							// Check if there's a period on the same line (before newline)
							// This catches proper noun attributions like "Jaime said," or "Dave asked,"
							k := j
							for k < len(runes) && runes[k] != '\n' && runes[k] != '"' && runes[k] != '\u201C' {
								if runes[k] == '.' {
									hasAttribution = true
									break
								}
								k++
							}
						}
					}

					if hasAttribution {
						// Find end of sentence (period after attribution)
						// Stop if we hit a quote (continuation of split quote) or newline
						for j < len(runes) && runes[j] != '.' && runes[j] != '\n' && runes[j] != '"' && runes[j] != '\u201C' {
							j++
						}
						if j < len(runes) && runes[j] == '.' {
							boundaries = append(boundaries, boundaryMark{pos: j + 1, reason: "after dialogue+attribution"})
						}
					} else if region.end < len(runes)-1 {
						boundaries = append(boundaries, boundaryMark{pos: region.end + 1, reason: "after standalone dialogue"})
					}
				}
			}
		}
	}

	// RULE 4: Quote and italics endings, quote-to-quote transitions
	for i, region := range regions {
		if region.typ == '"' || region.typ == '*' {
			// Check if region ends with sentence-ending punctuation
			if region.end > region.start {
				charBeforeClosing := runes[region.end-1]
				if charBeforeClosing == '.' || charBeforeClosing == '!' || charBeforeClosing == '?' {
					// Region ends with punctuation - check what follows
					if region.end+1 < len(runes) {
						// Skip whitespace after region
						j := region.end + 1
						for j < len(runes) && (runes[j] == ' ' || runes[j] == '\t') {
							j++
						}

						// Check if followed by lowercase letter (indicates attribution continuation)
						hasAttribution := false
						if region.typ == '"' && j < len(runes) && unicode.IsLower(runes[j]) {
							hasAttribution = true
						}

						// Special handling for "I": check if quote appears after sentence boundary
						// If quote comes after ". ", treat "I" as new sentence
						// Otherwise, check if it's "I <lowercase>" (likely attribution like "I said")
						if region.typ == '"' && j < len(runes) && runes[j] == 'I' {
							// Check if quote started after a period (sentence boundary)
							quoteAfterPeriod := false
							if region.start >= 2 {
								// Look back to see if there's a period before the quote
								i := region.start - 1
								for i >= 0 && (runes[i] == ' ' || runes[i] == '\t' || runes[i] == '"' || runes[i] == '\u201C') {
									i--
								}
								if i >= 0 && runes[i] == '.' {
									quoteAfterPeriod = true
								}
							}

							// If NOT after period, check for "I <lowercase>" attribution pattern
							if !quoteAfterPeriod {
								k := j + 1
								for k < len(runes) && (runes[k] == ' ' || runes[k] == '\t') {
									k++
								}
								if k < len(runes) && unicode.IsLower(runes[k]) {
									hasAttribution = true
								}
							}
						}

						// If followed by capital letter or newline (and no attribution), create boundary
						if !hasAttribution && j < len(runes) && (unicode.IsUpper(runes[j]) || runes[j] == '\n') {
							var reason string
							if region.typ == '"' {
								reason = "after quote with punct"
							} else {
								reason = "after italics with punct"
							}
							boundaries = append(boundaries, boundaryMark{pos: region.end + 1, reason: reason})
						}
					}
				}
			}

			// Check for quote-to-quote transitions
			if region.typ == '"' && i < len(regions)-1 && regions[i+1].typ == '"' {
				// Check if there's only whitespace/newlines between quotes
				onlyWhitespace := true
				for j := region.end + 1; j < regions[i+1].start; j++ {
					if runes[j] != ' ' && runes[j] != '\n' && runes[j] != '\t' {
						onlyWhitespace = false
						break
					}
				}
				if onlyWhitespace {
					boundaries = append(boundaries, boundaryMark{pos: region.end + 1, reason: "quote-to-quote"})
				}
			}
		}
	}

	// RULE 5: Standard sentence-ending punctuation (. ! ?)
	for i := 0; i < len(runes); i++ {
		r := runes[i]

		// Skip if inside nested region
		if insideNested(i) {
			continue
		}

		// Check for sentence-ending punctuation
		if r == '.' || r == '!' || r == '?' {
			// Look ahead to see if this is a real boundary
			if i+1 < len(runes) {
				next := runes[i+1]

				// Space or newline after punctuation
				if next == ' ' || next == '\n' {
					// For periods only: check for abbreviations
					if r == '.' {
						// Extract word before period
						k := i - 1
						for k >= 0 && (unicode.IsLetter(runes[k]) || unicode.IsDigit(runes[k])) {
							k--
						}
						wordStart := k + 1
						if wordStart <= i {
							word := string(runes[wordStart:i])
							if isCommonAbbreviation(word) {
								continue // Skip this period, it's an abbreviation
							}

							// Check for initial pattern: single letter followed by another initial
							// e.g., "A. J. Smith" - don't split after "A."
							if len(word) == 1 && unicode.IsLetter(rune(word[0])) {
								// Check if followed by space + single letter + period
								if i+3 < len(runes) && runes[i+1] == ' ' && unicode.IsLetter(runes[i+2]) && runes[i+3] == '.' {
									continue // This is an initial followed by another initial
								}
							}
						}

						// Check if followed by lowercase word (general heuristic for abbreviations)
						// Skip same special chars as capital letter check
						j := i + 1
						for j < len(runes) && (runes[j] == ' ' || runes[j] == '\t' || runes[j] == '\n' ||
							runes[j] == '*' || runes[j] == '"' || runes[j] == '\u201C' || runes[j] == '[') {
							j++
						}
						if j < len(runes) && unicode.IsLower(runes[j]) {
							continue // Followed by lowercase, likely abbreviation
						}
					}

					// Check if followed by capital letter (skip asterisks, quotes, brackets)
					j := i + 1
					for j < len(runes) && (runes[j] == ' ' || runes[j] == '\t' || runes[j] == '\n' ||
						runes[j] == '*' || runes[j] == '"' || runes[j] == '\u201C' || runes[j] == '[') {
						j++
					}

					if j < len(runes) && unicode.IsUpper(runes[j]) {
						boundaries = append(boundaries, boundaryMark{pos: i + 1, reason: "standard punct"})
					}
				}
			} else {
				// End of text
				boundaries = append(boundaries, boundaryMark{pos: i + 1, reason: "end of text"})
			}
		}
	}

	// RULE 6: Ellipsis followed by capital letter
	for i := 0; i < len(runes)-3; i++ {
		if insideNested(i) {
			continue
		}

		// Check for "... " or "..." at end
		if runes[i] == '.' && runes[i+1] == '.' && runes[i+2] == '.' {
			var nextCharPos int
			if i+3 < len(runes) && runes[i+3] == ' ' {
				nextCharPos = i + 4
			} else if i+3 >= len(runes) {
				// Ellipsis at end of text
				boundaries = append(boundaries, boundaryMark{pos: i + 3, reason: "ellipsis at end"})
				continue
			} else {
				continue
			}

			// Skip asterisks, quotes, brackets
			for nextCharPos < len(runes) && (runes[nextCharPos] == ' ' || runes[nextCharPos] == '*' ||
				runes[nextCharPos] == '"' || runes[nextCharPos] == '\u201C') {
				nextCharPos++
			}

			// Check if followed by capital letter
			if nextCharPos < len(runes) && unicode.IsUpper(runes[nextCharPos]) {
				boundaries = append(boundaries, boundaryMark{pos: i + 4, reason: "ellipsis+capital"})
			}
		}
	}

	// RULE 7: Paragraph breaks (double newlines or newline+tab)
	for i := 0; i < len(runes)-1; i++ {
		if runes[i] == '\n' && runes[i+1] == '\n' {
			boundaries = append(boundaries, boundaryMark{pos: i + 1, reason: "paragraph break"})
		} else if runes[i] == '\n' && runes[i+1] == '\t' {
			// Check if this is not the start of standalone dialogue (tab+quote)
			isDialogue := false
			if i+2 < len(runes) && (runes[i+2] == '"' || runes[i+2] == '\u201C') {
				isDialogue = true
			}
			if !isDialogue {
				boundaries = append(boundaries, boundaryMark{pos: i + 1, reason: "paragraph break"})
			}
		}
	}

	// RULE 8: Markdown headers (lines starting with #)
	for i := 0; i < len(runes); i++ {
		if runes[i] == '#' {
			// Check if this # is at the start of a line (after newline or at position 0)
			atLineStart := i == 0 || runes[i-1] == '\n'

			if atLineStart {
				// Create boundary before the header (unless at start of text)
				if i > 0 {
					boundaries = append(boundaries, boundaryMark{pos: i, reason: "before markdown header"})
				}

				// Find the end of the header line
				j := i
				for j < len(runes) && runes[j] != '\n' {
					j++
				}

				// Create boundary after the header (at the newline)
				if j < len(runes) {
					boundaries = append(boundaries, boundaryMark{pos: j, reason: "after markdown header"})
				}
			}
		}
	}

	return boundaries
}

// splitAtBoundaries splits the text at marked boundaries
func splitAtBoundaries(runes []rune, boundaries []boundaryMark) []string {
	if len(boundaries) == 0 {
		return []string{strings.TrimSpace(string(runes))}
	}

	// Sort boundaries by position
	for i := 0; i < len(boundaries)-1; i++ {
		for j := i + 1; j < len(boundaries); j++ {
			if boundaries[j].pos < boundaries[i].pos {
				boundaries[i], boundaries[j] = boundaries[j], boundaries[i]
			}
		}
	}

	// Remove duplicates
	uniqueBoundaries := []boundaryMark{boundaries[0]}
	for i := 1; i < len(boundaries); i++ {
		if boundaries[i].pos != uniqueBoundaries[len(uniqueBoundaries)-1].pos {
			uniqueBoundaries = append(uniqueBoundaries, boundaries[i])
		}
	}

	// Split at boundaries
	var sentences []string
	start := 0

	// Helper to normalize whitespace in a sentence
	normalizeWhitespace := func(s string) string {
		// Replace newlines and tabs with spaces
		s = strings.ReplaceAll(s, "\n", " ")
		s = strings.ReplaceAll(s, "\t", " ")
		// Collapse multiple spaces into one
		for strings.Contains(s, "  ") {
			s = strings.ReplaceAll(s, "  ", " ")
		}
		return strings.TrimSpace(s)
	}

	for _, boundary := range uniqueBoundaries {
		if boundary.pos > start && boundary.pos <= len(runes) {
			sentence := string(runes[start:boundary.pos])
			sentence = normalizeWhitespace(sentence)
			if sentence != "" {
				sentences = append(sentences, sentence)
			}
			start = boundary.pos
		}
	}

	// Add remaining text
	if start < len(runes) {
		sentence := string(runes[start:])
		sentence = normalizeWhitespace(sentence)
		if sentence != "" {
			sentences = append(sentences, sentence)
		}
	}

	return sentences
}
// Test comment
