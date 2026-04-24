/**
 * Sentence Segmenter - JavaScript Implementation
 *
 * 3-Phase Architecture:
 * 1. Mark all nested structures (quotes, parens, brackets, italics)
 * 2. Mark sentence boundaries (respecting nested regions)
 * 3. Split at boundaries and return sentences
 */

/**
 * Segment splits text into sentences
 * @param {string} text - The text to segment
 * @returns {string[]} - Array of sentences
 */
function segment(text) {
    text = text.trim();
    if (text === '') {
        return [];
    }

    // Convert to array of characters (handles Unicode properly)
    const chars = Array.from(text);

    // PHASE 1: Mark all nested structures
    const regions = markNestedRegions(chars);

    // PHASE 2: Mark sentence boundaries
    const boundaries = markBoundaries(chars, regions);

    // PHASE 3: Split at boundaries
    return splitAtBoundaries(chars, boundaries);
}

/**
 * markNestedRegions finds all nested structures in the text (1 level only)
 */
function markNestedRegions(chars) {
    const regions = [];

    // Find all types of nested structures
    regions.push(...findQuotes(chars));
    regions.push(...findParentheses(chars));
    regions.push(...findBrackets(chars));
    regions.push(...findItalics(chars));

    return regions;
}

/**
 * findQuotes finds all quoted text (both straight and curly quotes)
 */
function findQuotes(chars) {
    const regions = [];
    let start = -1;

    for (let i = 0; i < chars.length; i++) {
        const ch = chars[i];
        // Handle curly quotes specifically
        if (ch === '\u201C') { // Left curly quote - always opens
            if (start === -1) {
                start = i;
            }
        } else if (ch === '\u201D') { // Right curly quote - always closes
            if (start !== -1) {
                regions.push({ start, end: i, typ: '"' });
                start = -1;
            }
        } else if (ch === '"') { // Straight quote - toggle
            if (start === -1) {
                start = i; // Open quote
            } else {
                regions.push({ start, end: i, typ: '"' });
                start = -1; // Close quote
            }
        }
    }

    // Handle unclosed quote at end
    if (start !== -1) {
        regions.push({ start, end: chars.length - 1, typ: '"' });
    }

    return regions;
}

/**
 * findParentheses finds all parenthetical text
 */
function findParentheses(chars) {
    const regions = [];
    let start = -1;

    for (let i = 0; i < chars.length; i++) {
        const ch = chars[i];
        if (ch === '(' && start === -1) {
            start = i;
        } else if (ch === ')' && start !== -1) {
            regions.push({ start, end: i, typ: '(' });
            start = -1;
        }
    }

    return regions;
}

/**
 * findBrackets finds all editorial brackets
 */
function findBrackets(chars) {
    const regions = [];
    let start = -1;

    for (let i = 0; i < chars.length; i++) {
        const ch = chars[i];
        if (ch === '[' && start === -1) {
            start = i;
        } else if (ch === ']' && start !== -1) {
            regions.push({ start, end: i, typ: '[' });
            start = -1;
        }
    }

    return regions;
}

/**
 * findItalics finds all italicized text (marked with asterisks)
 */
function findItalics(chars) {
    const regions = [];
    let start = -1;

    for (let i = 0; i < chars.length; i++) {
        const ch = chars[i];
        if (ch === '*') {
            if (start === -1) {
                start = i;
            } else {
                regions.push({ start, end: i, typ: '*' });
                start = -1;
            }
        }
    }

    return regions;
}

/**
 * markBoundaries identifies all positions where sentences should split
 */
function markBoundaries(chars, regions) {
    const boundaries = [];

    // Helper: check if position is inside a nested region
    const insideNested = (pos) => {
        for (const r of regions) {
            // Include both opening and closing delimiters in the protected region
            if (pos >= r.start && pos <= r.end) {
                return true;
            }
        }
        return false;
    };

    // Helper: check if position is inside a quote, paren, or italic region (not brackets)
    const insideQuoteOrOther = (pos) => {
        for (const r of regions) {
            if (r.typ !== '[') { // Exclude bracket regions
                // Include both opening and closing delimiters in the protected region
                if (pos >= r.start && pos <= r.end) {
                    return true;
                }
            }
        }
        return false;
    };

    // Helper: check if character is lowercase
    const isLower = (ch) => ch && ch.toLowerCase() === ch && ch.toUpperCase() !== ch;

    // Helper: check if character is uppercase
    const isUpper = (ch) => ch && ch.toUpperCase() === ch && ch.toLowerCase() !== ch;

    // Helper: check if word is a common abbreviation
    const isCommonAbbreviation = (word) => {
        const lower = word.toLowerCase();

        // Common abbreviations
        const abbreviations = [
            'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr',
            'st', 'ave', 'blvd', 'rd', 'ln', 'ct',
            'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
            'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun',
            'etc', 'vs', 'vol', 'no', 'pp', 'ed', 'eds',
            'co', 'corp', 'inc', 'ltd'
        ];

        if (abbreviations.includes(lower)) {
            return true;
        }

        // Check for a.m. and p.m. patterns (already has a period before)
        if (lower === 'm') {
            return true; // handles "a.m." and "p.m."
        }

        // Check for common Latin abbreviations
        if (lower === 'e' || lower === 'i') {
            return true; // handles "e.g.", "i.e."
        }

        return false;
    };

    // RULE 1: Editorial brackets create boundaries (unless the boundary would be inside quotes/parens/italics)
    for (const region of regions) {
        if (region.typ === '[') {
            // Boundary before bracket (only if not inside quotes/parens/italics)
            if (region.start > 0 && !insideQuoteOrOther(region.start)) {
                boundaries.push({ pos: region.start, reason: 'before bracket' });
            }
            // Boundary after bracket (only if not inside quotes/parens/italics)
            if (region.end < chars.length - 1 && !insideQuoteOrOther(region.end + 1)) {
                boundaries.push({ pos: region.end + 1, reason: 'after bracket' });
            }
        }
    }

    // RULE 2: Standalone parentheticals with sentence-ending punctuation
    for (const region of regions) {
        if (region.typ === '(') {
            // Check if preceded by sentence-ending punctuation (skip whitespace)
            let hasPrecedingPunct = false;
            for (let i = region.start - 1; i >= 0; i--) {
                if (chars[i] === ' ' || chars[i] === '\t' || chars[i] === '\n') {
                    continue; // Skip whitespace
                }
                if (chars[i] === '.' || chars[i] === '!' || chars[i] === '?') {
                    hasPrecedingPunct = true;
                }
                break; // Stop at first non-whitespace
            }

            // Check if contains sentence-ending punctuation
            let hasInternalPunct = false;
            for (let i = region.start + 1; i < region.end; i++) {
                if (chars[i] === '.' || chars[i] === '!' || chars[i] === '?') {
                    hasInternalPunct = true;
                    break;
                }
            }

            // If both conditions met, it's a standalone parenthetical
            if (hasPrecedingPunct && hasInternalPunct) {
                boundaries.push({ pos: region.start, reason: 'standalone paren' });
                if (region.end < chars.length - 1) {
                    boundaries.push({ pos: region.end + 1, reason: 'after standalone paren' });
                }
            }
        }
    }

    // RULE 3: Standalone dialogue (newline + tab + quote)
    for (const region of regions) {
        if (region.typ === '"') {
            // Check if quote starts after \n\t or \n
            if (region.start >= 2 && chars[region.start - 2] === '\n' && chars[region.start - 1] === '\t') {
                // Always create boundary before standalone dialogue
                boundaries.push({ pos: region.start - 2, reason: 'before standalone dialogue' });

                // Check if there's lowercase word after quote (attribution after)
                if (region.end + 1 < chars.length) {
                    let j = region.end + 1;
                    while (j < chars.length && (chars[j] === ' ' || chars[j] === '\t')) {
                        j++;
                    }

                    // Check for attribution (lowercase word, "I <lowercase>", or period on same line)
                    let hasAttribution = false;
                    if (j < chars.length) {
                        if (isLower(chars[j])) {
                            hasAttribution = true;
                        } else if (chars[j] === 'I') {
                            // Check for "I <lowercase>" pattern (e.g., "I said")
                            let k = j + 1;
                            while (k < chars.length && (chars[k] === ' ' || chars[k] === '\t')) {
                                k++;
                            }
                            if (k < chars.length && isLower(chars[k])) {
                                hasAttribution = true;
                            }
                        } else if (isUpper(chars[j])) {
                            // Check if there's a period on the same line (before newline)
                            // This catches proper noun attributions like "Jaime said," or "Dave asked,"
                            let k = j;
                            while (k < chars.length && chars[k] !== '\n' && chars[k] !== '"' && chars[k] !== '\u201C') {
                                if (chars[k] === '.') {
                                    hasAttribution = true;
                                    break;
                                }
                                k++;
                            }
                        }
                    }

                    if (hasAttribution) {
                        // Find end of sentence (period after attribution)
                        // Stop if we hit a quote (continuation of split quote) or newline
                        while (j < chars.length && chars[j] !== '.' && chars[j] !== '\n' && chars[j] !== '"' && chars[j] !== '\u201C') {
                            j++;
                        }
                        if (j < chars.length && chars[j] === '.') {
                            boundaries.push({ pos: j + 1, reason: 'after dialogue+attribution' });
                        }
                    } else if (region.end < chars.length - 1) {
                        boundaries.push({ pos: region.end + 1, reason: 'after standalone dialogue' });
                    }
                }
            } else if (region.start >= 1 && chars[region.start - 1] === '\n') {
                boundaries.push({ pos: region.start - 1, reason: 'before standalone dialogue' });

                // Check for attribution after
                if (region.end + 1 < chars.length) {
                    let j = region.end + 1;
                    while (j < chars.length && (chars[j] === ' ' || chars[j] === '\t')) {
                        j++;
                    }

                    // Check for attribution (lowercase word, "I <lowercase>", or period on same line)
                    let hasAttribution = false;
                    if (j < chars.length) {
                        if (isLower(chars[j])) {
                            hasAttribution = true;
                        } else if (chars[j] === 'I') {
                            // Check for "I <lowercase>" pattern (e.g., "I said")
                            let k = j + 1;
                            while (k < chars.length && (chars[k] === ' ' || chars[k] === '\t')) {
                                k++;
                            }
                            if (k < chars.length && isLower(chars[k])) {
                                hasAttribution = true;
                            }
                        } else if (isUpper(chars[j])) {
                            // Check if there's a period on the same line (before newline)
                            // This catches proper noun attributions like "Jaime said," or "Dave asked,"
                            let k = j;
                            while (k < chars.length && chars[k] !== '\n' && chars[k] !== '"' && chars[k] !== '\u201C') {
                                if (chars[k] === '.') {
                                    hasAttribution = true;
                                    break;
                                }
                                k++;
                            }
                        }
                    }

                    if (hasAttribution) {
                        // Find end of sentence (period after attribution)
                        // Stop if we hit a quote (continuation of split quote) or newline
                        while (j < chars.length && chars[j] !== '.' && chars[j] !== '\n' && chars[j] !== '"' && chars[j] !== '\u201C') {
                            j++;
                        }
                        if (j < chars.length && chars[j] === '.') {
                            boundaries.push({ pos: j + 1, reason: 'after dialogue+attribution' });
                        }
                    } else if (region.end < chars.length - 1) {
                        boundaries.push({ pos: region.end + 1, reason: 'after standalone dialogue' });
                    }
                }
            }
        }
    }

    // RULE 4: Quote and italics endings, quote-to-quote transitions
    for (let i = 0; i < regions.length; i++) {
        const region = regions[i];
        if (region.typ === '"' || region.typ === '*') {
            // Check if region ends with sentence-ending punctuation
            if (region.end > region.start) {
                const charBeforeClosing = chars[region.end - 1];
                if (charBeforeClosing === '.' || charBeforeClosing === '!' || charBeforeClosing === '?') {
                    // Region ends with punctuation - check what follows
                    if (region.end + 1 < chars.length) {
                        // Skip whitespace after region
                        let j = region.end + 1;
                        while (j < chars.length && (chars[j] === ' ' || chars[j] === '\t')) {
                            j++;
                        }

                        // Check if followed by lowercase letter (indicates attribution continuation)
                        let hasAttribution = false;
                        if (region.typ === '"' && j < chars.length && isLower(chars[j])) {
                            hasAttribution = true;
                        }

                        // Special handling for "I": check if quote appears after sentence boundary
                        // If quote comes after ". ", treat "I" as new sentence
                        // Otherwise, check if it's "I <lowercase>" (likely attribution like "I said")
                        if (region.typ === '"' && j < chars.length && chars[j] === 'I') {
                            // Check if quote started after a period (sentence boundary)
                            let quoteAfterPeriod = false;
                            if (region.start >= 2) {
                                // Look back to see if there's a period before the quote
                                let k = region.start - 1;
                                while (k >= 0 && (chars[k] === ' ' || chars[k] === '\t' || chars[k] === '"' || chars[k] === '\u201C')) {
                                    k--;
                                }
                                if (k >= 0 && chars[k] === '.') {
                                    quoteAfterPeriod = true;
                                }
                            }

                            // If NOT after period, check for "I <lowercase>" attribution pattern
                            if (!quoteAfterPeriod) {
                                let k = j + 1;
                                while (k < chars.length && (chars[k] === ' ' || chars[k] === '\t')) {
                                    k++;
                                }
                                if (k < chars.length && isLower(chars[k])) {
                                    hasAttribution = true;
                                }
                            }
                        }

                        // If followed by capital letter or newline (and no attribution), create boundary
                        if (!hasAttribution && j < chars.length && (isUpper(chars[j]) || chars[j] === '\n')) {
                            const reason = region.typ === '"' ? 'after quote with punct' : 'after italics with punct';
                            boundaries.push({ pos: region.end + 1, reason });
                        }
                    }
                }
            }

            // Check for quote-to-quote transitions
            if (region.typ === '"' && i < regions.length - 1 && regions[i + 1].typ === '"') {
                // Check if there's only whitespace/newlines between quotes
                let onlyWhitespace = true;
                for (let j = region.end + 1; j < regions[i + 1].start; j++) {
                    if (chars[j] !== ' ' && chars[j] !== '\n' && chars[j] !== '\t') {
                        onlyWhitespace = false;
                        break;
                    }
                }
                if (onlyWhitespace) {
                    boundaries.push({ pos: region.end + 1, reason: 'quote-to-quote' });
                }
            }
        }
    }

    // RULE 5: Standard sentence-ending punctuation (. ! ?)
    for (let i = 0; i < chars.length; i++) {
        const ch = chars[i];

        // Skip if inside nested region
        if (insideNested(i)) {
            continue;
        }

        // Check for sentence-ending punctuation
        if (ch === '.' || ch === '!' || ch === '?') {
            // Look ahead to see if this is a real boundary
            if (i + 1 < chars.length) {
                const next = chars[i + 1];

                // Space or newline after punctuation
                if (next === ' ' || next === '\n') {
                    // For periods only: check for abbreviations
                    if (ch === '.') {
                        // Extract word before period
                        let k = i - 1;
                        while (k >= 0 && /[a-zA-Z0-9]/.test(chars[k])) {
                            k--;
                        }
                        const wordStart = k + 1;
                        if (wordStart <= i) {
                            const word = chars.slice(wordStart, i).join('');
                            if (isCommonAbbreviation(word)) {
                                continue; // Skip this period, it's an abbreviation
                            }

                            // Check for initial pattern: single letter followed by another initial
                            // e.g., "A. J. Smith" - don't split after "A."
                            if (word.length === 1 && /[a-zA-Z]/.test(word[0])) {
                                // Check if followed by space + single letter + period
                                if (i + 3 < chars.length && chars[i + 1] === ' ' && /[a-zA-Z]/.test(chars[i + 2]) && chars[i + 3] === '.') {
                                    continue; // This is an initial followed by another initial
                                }
                            }
                        }

                        // Check if followed by lowercase word (general heuristic for abbreviations)
                        // Skip same special chars as capital letter check
                        let j = i + 1;
                        while (j < chars.length && (chars[j] === ' ' || chars[j] === '\t' || chars[j] === '\n' ||
                            chars[j] === '*' || chars[j] === '"' || chars[j] === '\u201C' || chars[j] === '[')) {
                            j++;
                        }
                        if (j < chars.length && isLower(chars[j])) {
                            continue; // Followed by lowercase, likely abbreviation
                        }
                    }

                    // Check if followed by capital letter (skip asterisks, quotes, brackets)
                    let j = i + 1;
                    while (j < chars.length && (chars[j] === ' ' || chars[j] === '\t' || chars[j] === '\n' ||
                        chars[j] === '*' || chars[j] === '"' || chars[j] === '\u201C' || chars[j] === '[')) {
                        j++;
                    }

                    if (j < chars.length && isUpper(chars[j])) {
                        boundaries.push({ pos: i + 1, reason: 'standard punct' });
                    }
                }
            } else {
                // End of text
                boundaries.push({ pos: i + 1, reason: 'end of text' });
            }
        }
    }

    // RULE 6: Ellipsis followed by capital letter
    for (let i = 0; i < chars.length - 3; i++) {
        if (insideNested(i)) {
            continue;
        }

        // Check for "... " or "..." at end
        if (chars[i] === '.' && chars[i + 1] === '.' && chars[i + 2] === '.') {
            let nextCharPos;
            if (i + 3 < chars.length && chars[i + 3] === ' ') {
                nextCharPos = i + 4;
            } else if (i + 3 >= chars.length) {
                // Ellipsis at end of text
                boundaries.push({ pos: i + 3, reason: 'ellipsis at end' });
                continue;
            } else {
                continue;
            }

            // Skip asterisks, quotes, brackets
            while (nextCharPos < chars.length && (chars[nextCharPos] === ' ' || chars[nextCharPos] === '*' ||
                chars[nextCharPos] === '"' || chars[nextCharPos] === '\u201C')) {
                nextCharPos++;
            }

            // Check if followed by capital letter
            if (nextCharPos < chars.length && isUpper(chars[nextCharPos])) {
                boundaries.push({ pos: i + 4, reason: 'ellipsis+capital' });
            }
        }
    }

    // RULE 7: Paragraph breaks (double newlines or newline+tab)
    for (let i = 0; i < chars.length - 1; i++) {
        if (chars[i] === '\n' && chars[i + 1] === '\n') {
            boundaries.push({ pos: i + 1, reason: 'paragraph break' });
        } else if (chars[i] === '\n' && chars[i + 1] === '\t') {
            // Check if this is not the start of standalone dialogue (tab+quote)
            let isDialogue = false;
            if (i + 2 < chars.length && (chars[i + 2] === '"' || chars[i + 2] === '\u201C')) {
                isDialogue = true;
            }
            if (!isDialogue) {
                boundaries.push({ pos: i + 1, reason: 'paragraph break' });
            }
        }
    }

    // RULE 8: Markdown headers (lines starting with #)
    for (let i = 0; i < chars.length; i++) {
        if (chars[i] === '#') {
            // Check if this # is at the start of a line (after newline or at position 0)
            const atLineStart = i === 0 || chars[i - 1] === '\n';

            if (atLineStart) {
                // Create boundary before the header (unless at start of text)
                if (i > 0) {
                    boundaries.push({ pos: i, reason: 'before markdown header' });
                }

                // Find the end of the header line
                let j = i;
                while (j < chars.length && chars[j] !== '\n') {
                    j++;
                }

                // Create boundary after the header (at the newline)
                if (j < chars.length) {
                    boundaries.push({ pos: j, reason: 'after markdown header' });
                }
            }
        }
    }

    return boundaries;
}

/**
 * splitAtBoundaries splits the text at marked boundaries
 */
function splitAtBoundaries(chars, boundaries) {
    if (boundaries.length === 0) {
        const text = chars.join('').trim();
        return text === '' ? [] : [text];
    }

    // Sort boundaries by position
    boundaries.sort((a, b) => a.pos - b.pos);

    // Remove duplicates
    const uniqueBoundaries = [boundaries[0]];
    for (let i = 1; i < boundaries.length; i++) {
        if (boundaries[i].pos !== uniqueBoundaries[uniqueBoundaries.length - 1].pos) {
            uniqueBoundaries.push(boundaries[i]);
        }
    }

    // Helper to normalize whitespace in a sentence
    const normalizeWhitespace = (s) => {
        // Replace newlines and tabs with spaces
        s = s.replace(/\n/g, ' ').replace(/\t/g, ' ');
        // Collapse multiple spaces into one
        while (s.includes('  ')) {
            s = s.replace(/  /g, ' ');
        }
        return s.trim();
    };

    // Split at boundaries
    const sentences = [];
    let start = 0;

    for (const boundary of uniqueBoundaries) {
        if (boundary.pos > start && boundary.pos <= chars.length) {
            const sentence = chars.slice(start, boundary.pos).join('');
            const normalized = normalizeWhitespace(sentence);
            if (normalized !== '') {
                sentences.push(normalized);
            }
            start = boundary.pos;
        }
    }

    // Add remaining text
    if (start < chars.length) {
        const sentence = chars.slice(start).join('');
        const normalized = normalizeWhitespace(sentence);
        if (normalized !== '') {
            sentences.push(normalized);
        }
    }

    return sentences;
}

/**
 * Get the current SEGMAN version from VERSION.json
 * @returns {string} - The version string
 */
let cachedVersion = null;
function getVersion() {
    if (cachedVersion) {
        return cachedVersion;
    }

    try {
        const fs = require('fs');
        const path = require('path');
        const versionFile = path.join(__dirname, '../../VERSION.json');
        const data = JSON.parse(fs.readFileSync(versionFile, 'utf-8'));
        cachedVersion = data.version;
        return cachedVersion;
    } catch (err) {
        return 'unknown';
    }
}

// Export for Node.js
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { segment, getVersion };
}
