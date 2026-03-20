import {
  SYNONYMS,
  ABBREVIATION_TO_FULL,
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
  // Resolve abbreviations to full forms since the FTS index stores full-form street types
  const ftsTokens = textTokens.map((t, i) => {
    const syns = SYNONYMS[t] ?? [t];
    const isLast = i === textTokens.length - 1;
    // Resolve abbreviations to full forms, then deduplicate
    const resolved = [...new Set(syns.map((s) => ABBREVIATION_TO_FULL[s] ?? s))];
    if (isLast) {
      // Resolved full forms get exact match (abbreviation definitively resolved).
      // Original token gets prefix search (could be start of any word, e.g. "AV" → AVALON).
      const parts: string[] = [];
      const seen = new Set<string>();
      for (const s of syns) {
        const full = ABBREVIATION_TO_FULL[s];
        if (full && !seen.has(full)) {
          seen.add(full);
          parts.push(full); // exact — resolved abbreviation
        }
      }
      if (!seen.has(t)) {
        parts.push(`${t}*`); // prefix — original token
      }
      return parts.length > 1 ? `(${parts.join(" OR ")})` : parts[0];
    } else {
      // Exact match: only use resolved full forms
      const parts = resolved.map((s) => `"${s}"`);
      return parts.length > 1 ? `(${parts.join(" OR ")})` : parts[0];
    }
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
    // No numbers: prefer bare street addresses over unit/level sub-addresses
    if (entry.f == null && entry.l == null) return 2;
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

export interface HighlightComponents {
  streetName: string;
  streetType?: string | null;
  streetSuffix?: string | null;
  localityName: string;
  state: string;
  postcode?: string | null;
  displayPrefix?: string | null;
}

/**
 * Check if a query token matches a component, considering abbreviation synonyms.
 * Returns true if the token is a prefix match, synonym match, or abbreviation-aware match.
 */
function tokenMatchesComponent(
  token: string,
  component: string,
  isStreetType: boolean
): boolean {
  const upperToken = token.toUpperCase();
  const upperComp = component.toUpperCase().replace(/'/g, "");

  // Direct prefix match (strip apostrophes for comparison)
  if (upperComp.startsWith(upperToken)) return true;

  if (!isStreetType) return false;

  // Street type synonym-aware matching:
  // Check if the token and street_type share a synonym group
  const tokenSyns = SYNONYMS[upperToken];
  if (tokenSyns && tokenSyns.includes(upperComp)) return true;

  // Check if token prefix-matches the full form of the street type
  // e.g., "ROA" prefix-matches "ROAD", and "ROAD" is synonym of "RD"
  const compSyns = SYNONYMS[upperComp];
  if (compSyns) {
    for (const syn of compSyns) {
      if (syn.startsWith(upperToken)) return true;
    }
  }

  return false;
}

/**
 * Compute highlight ranges for a display/SLA string based on query matching.
 * Returns sorted, non-overlapping [start, end) ranges.
 */
export function computeHighlightRanges(
  text: string,
  components: HighlightComponents,
  originalQuery: string
): [number, number][] {
  // Tokenize the original query (same logic as parseSearchQuery but keep all tokens)
  const allTokens = originalQuery
    .toUpperCase()
    .split(/[-\s,/]+/)
    .map((t) => t.replace(/[^\w']/g, ""))
    .filter(Boolean);

  if (allTokens.length === 0) return [];

  const numTokens = allTokens.filter((t) => /^\d+[A-Z]?$/.test(t));
  const textTokens = allTokens.filter((t) => !/^\d+[A-Z]?$/.test(t));

  // Build a map of component → [start, end) position in the text
  const upperText = text.toUpperCase();
  const componentPositions: {
    value: string;
    start: number;
    end: number;
    isStreetType: boolean;
  }[] = [];

  // Find each component's position in the text by scanning known structure
  // Display format: "STREET_NAME [STREET_TYPE] [STREET_SUFFIX], LOCALITY, STATE[, POSTCODE]"
  // SLA format: "[PREFIX ]STREET_NAME [STREET_TYPE] [STREET_SUFFIX], LOCALITY STATE [POSTCODE]"

  const prefixStr = components.displayPrefix || "";
  let offset = 0;

  // Display prefix (for SLA)
  if (prefixStr) {
    // Prefix tokens like "UNIT 3, 28" — highlight number matches within
    offset = prefixStr.length + 1; // +1 for the space after prefix
  }

  // Street name
  const snStart = upperText.indexOf(components.streetName.toUpperCase(), offset);
  if (snStart !== -1) {
    componentPositions.push({
      value: components.streetName,
      start: snStart,
      end: snStart + components.streetName.length,
      isStreetType: false,
    });
    offset = snStart + components.streetName.length;
  }

  // Street type
  if (components.streetType) {
    const stStart = upperText.indexOf(components.streetType.toUpperCase(), offset);
    if (stStart !== -1) {
      componentPositions.push({
        value: components.streetType,
        start: stStart,
        end: stStart + components.streetType.length,
        isStreetType: true,
      });
      offset = stStart + components.streetType.length;
    }
  }

  // Street suffix
  if (components.streetSuffix) {
    const ssStart = upperText.indexOf(components.streetSuffix.toUpperCase(), offset);
    if (ssStart !== -1) {
      componentPositions.push({
        value: components.streetSuffix,
        start: ssStart,
        end: ssStart + components.streetSuffix.length,
        isStreetType: false,
      });
      offset = ssStart + components.streetSuffix.length;
    }
  }

  // Locality
  const locStart = upperText.indexOf(components.localityName.toUpperCase(), offset);
  if (locStart !== -1) {
    componentPositions.push({
      value: components.localityName,
      start: locStart,
      end: locStart + components.localityName.length,
      isStreetType: false,
    });
  }

  // State
  const stateStart = upperText.indexOf(components.state.toUpperCase(), offset);
  if (stateStart !== -1) {
    componentPositions.push({
      value: components.state,
      start: stateStart,
      end: stateStart + components.state.length,
      isStreetType: false,
    });
  }

  // Postcode
  if (components.postcode) {
    const pcStart = upperText.indexOf(components.postcode, offset);
    if (pcStart !== -1) {
      componentPositions.push({
        value: components.postcode,
        start: pcStart,
        end: pcStart + components.postcode.length,
        isStreetType: false,
      });
    }
  }

  const ranges: [number, number][] = [];

  // Match text tokens against components
  for (const token of textTokens) {
    const cleanToken = token.replace(/'/g, "");
    for (const comp of componentPositions) {
      if (tokenMatchesComponent(cleanToken, comp.value, comp.isStreetType)) {
        // For synonym/abbreviation matches, highlight the whole component
        // For prefix matches, highlight just the matched portion
        const cleanComp = comp.value.toUpperCase().replace(/'/g, "");
        if (cleanComp.startsWith(cleanToken)) {
          // Prefix match: compute how many chars of the actual text to highlight
          // Account for apostrophes in the text that aren't in the token
          let textIdx = comp.start;
          let matched = 0;
          while (textIdx < comp.end && matched < cleanToken.length) {
            if (text[textIdx] === "'") {
              textIdx++;
              continue;
            }
            matched++;
            textIdx++;
          }
          // Include any trailing apostrophes
          while (textIdx < comp.end && text[textIdx] === "'") textIdx++;
          ranges.push([comp.start, textIdx]);
        } else {
          // Synonym/abbreviation match: highlight entire component
          ranges.push([comp.start, comp.end]);
        }
        break; // Each token matches at most one component
      }
    }
  }

  // Match numeric tokens in display prefix
  if (prefixStr) {
    const prefixEnd = prefixStr.length;
    for (const num of numTokens) {
      let idx = 0;
      while (idx < prefixEnd) {
        const found = upperText.indexOf(num, idx);
        if (found === -1 || found >= prefixEnd) break;
        ranges.push([found, found + num.length]);
        idx = found + num.length;
      }
    }
  }

  if (ranges.length === 0) return [];

  // Sort and merge overlapping ranges
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [ranges[0]];
  for (let i = 1; i < ranges.length; i++) {
    const last = merged[merged.length - 1];
    if (ranges[i][0] <= last[1]) {
      last[1] = Math.max(last[1], ranges[i][1]);
    } else {
      merged.push(ranges[i]);
    }
  }

  return merged;
}
