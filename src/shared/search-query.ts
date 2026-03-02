import {
  SYNONYMS,
  FLAT_LEVEL_KEYWORDS,
  LEVEL_KEYWORDS,
} from "./synonyms.js";
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
  /** Inferred level number hint (null if not detected) */
  levelHint: number | null;
  /** Inferred street number hint (null if not detected) */
  streetHint: number | null;
  /** Suffix on the street number hint (e.g., "A" from "2A"), or null */
  streetSuffix: string | null;
  /** Raw alpha/alphanumeric flat identifier (e.g., "A", "A1", "LG3"), or null */
  flatDisplayHint: string | null;
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
  // Tokenize: uppercase, split on whitespace/commas/slashes/hyphens, clean non-alphanumeric
  const allTokens = q
    .toUpperCase()
    .split(/[-\s,/]+/)
    .map((t) => t.replace(/[^\w]/g, ""))
    .filter(Boolean);

  // Separate numeric and text tokens
  // Numeric: pure digits ("28") or digits+alpha suffix ("2A", "15B")
  const allNumTokens = allTokens.filter((t) => /^\d+[A-Z]?$/.test(t));
  const rawTextTokens = allTokens.filter((t) => !/^\d+[A-Z]?$/.test(t));

  // Filter out likely postcodes: a 4-digit pure number that appears after all text
  // tokens in the original query (e.g., "1 CANBERRA AV FORREST ACT 2603" → "2603" is postcode).
  // Australian postcodes are 4-digit numbers (0200–9999).
  const numTokens = allNumTokens.filter((t) => {
    if (!/^\d{4}$/.test(t)) return true; // keep non-4-digit tokens
    // Check if this 4-digit token appears after the last text token in the original query
    const tokenIdx = allTokens.lastIndexOf(t);
    const lastTextIdx = allTokens.reduce(
      (max, tok, i) => (!/^\d+[A-Z]?$/.test(tok) ? i : max),
      -1
    );
    // If it's the last or near-last token and appears after all text, treat as postcode
    return tokenIdx < lastTextIdx;
  });

  // Strip flat/level type keywords from text tokens for FTS5
  const hasUnitKeyword = rawTextTokens.some((t) => FLAT_LEVEL_KEYWORDS.has(t));
  let textTokens = rawTextTokens.filter(
    (t) => !FLAT_LEVEL_KEYWORDS.has(t)
  );

  // Detect alpha/alphanumeric flat identifier.
  // Triggers when:
  //   1. A unit keyword is present (e.g., "unit A1 173 monaro"), OR
  //   2. The query starts with alpha-flat slash/comma notation (e.g., "A1/173", "B, 5")
  // Strips tokens like "A", "A1", "LG3" from text tokens so they don't leak into FTS.
  let flatDisplayHint: string | null = null;
  const hasAlphaFlatNotation = /^\s*[A-Z]{1,3}\d*\s*[\/,]\s*\d/i.test(q);
  if (hasUnitKeyword || hasAlphaFlatNotation) {
    // Match: single letter (A, B) or 1-3 alpha prefix + digits (A1, LG3)
    const flatIdIdx = textTokens.findIndex(
      (t) => /^[A-Z]$|^[A-Z]{1,3}\d+$/.test(t)
    );
    if (flatIdIdx !== -1) {
      flatDisplayHint = textTokens[flatIdIdx];
      textTokens = textTokens.filter((_, i) => i !== flatIdIdx);
    }
  }

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

  // --- Position-aware keyword → number pairing ---
  // Walk through allTokens and pair flat/level keywords with the number that follows.
  // This allows us to distinguish "LEVEL 10, SUITE 6, 95 YORK" →
  //   levelHint=10, flatHint=6, streetHint=95
  const isNum = (t: string) => /^\d+[A-Z]?$/.test(t);
  let keywordFlatNum: string | null = null; // number paired with a flat keyword
  let keywordLevelNum: string | null = null; // number paired with a level keyword
  const pairedNumIndices = new Set<number>(); // allTokens indices of keyword-paired numbers

  for (let i = 0; i < allTokens.length; i++) {
    const tok = allTokens[i];
    if (!FLAT_LEVEL_KEYWORDS.has(tok)) continue;
    // Look ahead for a number token
    const next = i + 1 < allTokens.length ? allTokens[i + 1] : null;
    if (next && isNum(next)) {
      if (LEVEL_KEYWORDS.has(tok)) {
        keywordLevelNum = next;
      } else {
        keywordFlatNum = next;
      }
      pairedNumIndices.add(i + 1);
    }
  }

  // Unpaired numbers are street numbers (or fallback flat/street per existing logic)
  const unpairedNums = numTokens.filter((t) => {
    const idx = allTokens.indexOf(t);
    return !pairedNumIndices.has(idx);
  });

  // Determine flat vs street number hints
  let flatHint: number | null = null;
  let levelHint: number | null = null;
  let streetHint: number | null = null;
  let streetSuffix: string | null = null;

  // Apply keyword-paired values
  if (keywordFlatNum != null) {
    flatHint = parseNum(keywordFlatNum);
  }
  if (keywordLevelNum != null) {
    levelHint = parseNum(keywordLevelNum);
  }

  if (flatDisplayHint != null) {
    // Alpha flat identifier detected (e.g., "A", "A1", "LG3")
    // Extract digit part as flatHint (e.g., "A1" → 1, "LG3" → 3, "A" → null)
    const digitPart = flatDisplayHint.replace(/^[A-Z]+/, "");
    if (digitPart) {
      flatHint = parseInt(digitPart, 10);
    }
    // Remaining unpaired numeric tokens are street numbers
    if (unpairedNums.length >= 1) {
      streetHint = parseNum(unpairedNums[unpairedNums.length - 1]);
      streetSuffix = parseSuffix(unpairedNums[unpairedNums.length - 1]);
    }
  } else if (keywordFlatNum != null || keywordLevelNum != null) {
    // Keywords explicitly paired numbers — unpaired ones are street numbers
    if (unpairedNums.length >= 1) {
      // Use first unpaired number as street hint (closest to street context)
      streetHint = parseNum(unpairedNums[0]);
      streetSuffix = parseSuffix(unpairedNums[0]);
    }
  } else if (numTokens.length >= 2) {
    // Two or more numbers, no keywords: first is flat, last is street number
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
    levelHint,
    streetHint,
    streetSuffix,
    flatDisplayHint,
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

  const { flatHint, levelHint, streetHint, streetSuffix, flatDisplayHint, numTokens } = parsed;

  // Match flat hint against flat_number or level_number
  // When levelHint is separate, use entry.f for flatHint and entry.l for levelHint.
  // When only flatHint exists (no separate levelHint), fall back to entry.f ?? entry.l.
  const entryFlat = levelHint != null ? entry.f : (entry.f ?? entry.l);

  /** Check if streetHint matches this entry's street number (exact or within range) */
  function streetNumMatches(): boolean {
    if (entry.n == null || streetHint == null) return false;
    if (entry.n === streetHint) return true;
    // Range match: entry covers number_first to number_last (e.g., 95-99)
    if (entry.n2 != null && streetHint >= entry.n && streetHint <= entry.n2) return true;
    return false;
  }

  // Check if the display prefix contains the full numeric token (e.g., "2A" in "2A" or "UNIT 3, 2A")
  function displayStartsWith(token: string): boolean {
    if (!entry.d) return false;
    // Match token at start of display or after ", " separator
    return entry.d === token || entry.d.startsWith(token + ",") || entry.d.includes(", " + token);
  }

  /** Check if the unit part of the display matches an alpha flat hint */
  function displayHasFlat(hint: string): boolean {
    if (!entry.d) return false;
    const unitPart = entry.d.split(",")[0].trim();
    return unitPart === hint || unitPart.endsWith(" " + hint);
  }

  // Sub-address matching with three states per hint:
  //   "match"   — entry field matches hint
  //   "neutral" — entry field is missing (no data, not a mismatch)
  //   "mismatch" — entry field exists but differs from hint
  const hasSubAddrHint = flatHint != null || levelHint != null;

  type HintState = "match" | "neutral" | "mismatch";
  const flatState: HintState =
    flatHint == null ? "match" :
    entryFlat === flatHint ? "match" :
    entryFlat == null ? "neutral" : "mismatch";
  const levelState: HintState =
    levelHint == null ? "match" :
    entry.l === levelHint ? "match" :
    entry.l == null ? "neutral" : "mismatch";

  const hasMismatch = flatState === "mismatch" || levelState === "mismatch";
  const allMatch = flatState === "match" && levelState === "match";
  // Partial match: at least one hint matches, rest are neutral (entry missing data)
  const hasPositiveMatch = flatState === "match" && flatHint != null
    || levelState === "match" && levelHint != null;
  const hasPartialMatch = !hasMismatch && !allMatch && hasPositiveMatch;
  const entryHasSubAddr = entryFlat != null || entry.l != null;

  if (hasSubAddrHint && streetHint != null) {
    // Sub-address hint(s) + street number known
    if (streetNumMatches() && allMatch) {
      return 200; // Perfect: all specified hints match
    }
    if (streetNumMatches() && hasPartialMatch) {
      return 150; // Street match + partial sub-addr (some match, rest missing)
    }
    if (streetNumMatches() && !entryHasSubAddr) {
      return 100; // Street number match, no sub-address on entry
    }
    if (streetNumMatches()) {
      return 90; // Street number match, sub-address mismatch
    }
    if (allMatch) {
      return 70; // Sub-address match, different street number
    }
  } else if (streetHint != null) {
    // Street number only
    if (streetNumMatches()) {
      if (flatDisplayHint != null) {
        // Has alpha flat hint (e.g., "unit A 57") — boost if display matches
        if (displayHasFlat(flatDisplayHint)) {
          return 110; // Alpha flat display match + street match
        }
        return 90; // Street matches but flat doesn't match
      }
      if (streetSuffix != null) {
        // Has suffix (e.g., "2A") — boost exact suffix match in display
        const fullNum = `${streetHint}${streetSuffix}`;
        if (displayStartsWith(fullNum)) {
          return 110; // Exact number+suffix match
        }
        return 90; // Number matches but suffix differs (e.g., "2B" vs "2A")
      }
      // No unit context: prefer bare street address over unit addresses
      if (entryFlat != null) {
        return 90; // Entry has a flat/level — user didn't ask for one
      }
      return 100; // Bare street address
    }
    if (entryFlat != null && entryFlat === streetHint) {
      return 80; // Matched as flat/level number
    }
  } else if (flatHint != null) {
    // Flat number only (e.g., "unit 3 murray")
    if (entryFlat != null && entryFlat === flatHint) {
      return 80; // Flat/level match
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
