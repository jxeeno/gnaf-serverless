import { SYNONYMS, FLAT_LEVEL_KEYWORDS } from "./synonyms.js";
import type { StreetAddressEntry } from "./types.js";

export interface ParsedQuery {
  /** Original numeric tokens (pure digit strings or digit+alpha like "2A") */
  numTokens: string[];
  /** Text tokens for FTS5 search (flat/level keywords stripped) */
  textTokens: string[];
  /** Whether a flat/level keyword was present in the query */
  hasUnitKeyword: boolean;
  /** Inferred flat/unit number hint (null if not detected) */
  flatHint: number | null;
  /** Inferred street number hint (null if not detected) */
  streetHint: number | null;
  /** Suffix on the street number hint (e.g., "A" from "2A"), or null */
  streetSuffix: string | null;
  /** FTS5 query string with synonym expansion */
  ftsQuery: string;
}

/**
 * Parse a search query into structured components for FTS5 search and address scoring.
 *
 * Handles:
 * - Slash notation: "3/5 murray" → flat=3, street=5
 * - Unit keywords: "unit 3 5 murray" → flat=3, street=5
 * - Two bare numbers: "3 5 murray" → flat=3, street=5 (Australian convention)
 * - Single number: "5 murray" → street=5
 * - Unit keyword + single number: "unit 3 murray" → flat=3
 * - Synonym expansion: "road" → (ROAD* OR RD*)
 */
export function parseSearchQuery(q: string): ParsedQuery | null {
  // Tokenize: uppercase, split on whitespace/commas/slashes, clean non-alphanumeric
  const allTokens = q
    .toUpperCase()
    .split(/[\s,/]+/)
    .map((t) => t.replace(/[^\w]/g, ""))
    .filter(Boolean);

  // Separate numeric and text tokens
  // Numeric: pure digits ("28") or digits+alpha suffix ("2A", "15B")
  const numTokens = allTokens.filter((t) => /^\d+[A-Z]?$/.test(t));
  const rawTextTokens = allTokens.filter((t) => !/^\d+[A-Z]?$/.test(t));

  // Strip flat/level type keywords from text tokens for FTS5
  const hasUnitKeyword = rawTextTokens.some((t) => FLAT_LEVEL_KEYWORDS.has(t));
  const textTokens = rawTextTokens.filter(
    (t) => !FLAT_LEVEL_KEYWORDS.has(t)
  );

  if (textTokens.length === 0) {
    return null;
  }

  // Extract integer part from a numeric token (e.g., "2A" → 2, "28" → 28)
  function parseNum(token: string): number {
    return parseInt(token, 10);
  }
  // Extract alpha suffix from a numeric token (e.g., "2A" → "A", "28" → null)
  function parseSuffix(token: string): string | null {
    const m = token.match(/\d+([A-Z])$/);
    return m ? m[1] : null;
  }

  // Determine flat vs street number hints
  let flatHint: number | null = null;
  let streetHint: number | null = null;
  let streetSuffix: string | null = null;

  if (numTokens.length >= 2) {
    // Two or more numbers: first is flat, last is street number
    flatHint = parseNum(numTokens[0]);
    streetHint = parseNum(numTokens[numTokens.length - 1]);
    streetSuffix = parseSuffix(numTokens[numTokens.length - 1]);
  } else if (numTokens.length === 1) {
    const n = parseNum(numTokens[0]);
    if (hasUnitKeyword) {
      flatHint = n;
    } else {
      streetHint = n;
      streetSuffix = parseSuffix(numTokens[0]);
    }
  }

  // Expand text tokens with synonyms and build FTS5 query
  const ftsTokens = textTokens.map((t, i) => {
    const syns = SYNONYMS[t] ?? [t];
    const isLast = i === textTokens.length - 1;
    // FTS5: prefix queries use token* (no quotes), exact terms use "token"
    const parts = syns.map((s) => (isLast ? `${s}*` : `"${s}"`));
    return parts.length > 1 ? `(${parts.join(" OR ")})` : parts[0];
  });
  const ftsQuery = ftsTokens.join(" AND ");

  return {
    numTokens,
    textTokens,
    hasUnitKeyword,
    flatHint,
    streetHint,
    streetSuffix,
    ftsQuery,
  };
}

/**
 * Score an address entry against parsed query hints.
 * Returns 0 if the entry does not match (should be excluded).
 */
export function scoreAddress(
  entry: StreetAddressEntry,
  parsed: ParsedQuery
): number {
  if (parsed.numTokens.length === 0) {
    // No numbers: representative address
    return 1;
  }

  const { flatHint, streetHint, streetSuffix, numTokens } = parsed;

  // Check if the display prefix contains the full numeric token (e.g., "2A" in "2A" or "UNIT 3, 2A")
  function displayStartsWith(token: string): boolean {
    if (!entry.d) return false;
    // Match token at start of display or after ", " separator
    return entry.d === token || entry.d.startsWith(token + ",") || entry.d.includes(", " + token);
  }

  if (flatHint != null && streetHint != null) {
    // Both flat and street number known
    if (entry.f === flatHint && entry.n === streetHint) {
      return 200; // Perfect: flat + street match
    }
    if (entry.n === streetHint && entry.f == null) {
      return 100; // Street number match, no flat on entry
    }
    if (entry.n === streetHint) {
      return 90; // Street number match, different flat
    }
    if (entry.f === flatHint) {
      return 70; // Flat match, different street number
    }
  } else if (streetHint != null) {
    // Street number only
    if (entry.n != null && entry.n === streetHint) {
      if (streetSuffix != null) {
        // Has suffix (e.g., "2A") — boost exact suffix match in display
        const fullNum = `${streetHint}${streetSuffix}`;
        if (displayStartsWith(fullNum)) {
          return 110; // Exact number+suffix match
        }
        return 90; // Number matches but suffix differs (e.g., "2B" vs "2A")
      }
      return 100; // Exact street number match
    }
    if (entry.f != null && entry.f === streetHint) {
      return 80; // Matched as flat number
    }
  } else if (flatHint != null) {
    // Flat number only (e.g., "unit 3 murray")
    if (entry.f != null && entry.f === flatHint) {
      return 80; // Flat match
    }
    if (entry.n != null && entry.n === flatHint) {
      return 50; // Could be a street number too
    }
  }

  // Partial: any queried number appears as substring in display prefix
  for (const num of numTokens) {
    if (entry.d?.includes(num)) {
      return 30;
    }
  }

  return 0;
}
