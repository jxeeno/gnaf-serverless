/**
 * Shared definitions for pre-computed short query patterns.
 * Used by both the Worker (warmup.ts) and the build pipeline (precompute.ts).
 */

/**
 * Generate all pre-computable short queries:
 * - 1-char: [a-z0-9] = 36
 * - 2-char letters: [a-z]{2} = 676
 * - 2-char digits: [0-9]{2} = 100
 * - 1 digit + space + letter: [0-9] [a-z] = 260
 * - 2 digits + space + letter: [0-9]{2} [a-z] = 2,600
 * Total: 3,672
 */
export function generateShortQueries(): string[] {
  const alpha = "abcdefghijklmnopqrstuvwxyz";
  const digits = "0123456789";
  const queries: string[] = [];

  // 1-char: all letters and digits (36)
  for (const c of alpha) queries.push(c);
  for (const d of digits) queries.push(d);

  // 2-char: all letter pairs (676)
  for (const a of alpha) {
    for (const b of alpha) queries.push(a + b);
  }

  // 2-char: all digit pairs (100)
  for (const a of digits) {
    for (const b of digits) queries.push(a + b);
  }

  // 1 digit + space + letter (260)
  for (const d of digits) {
    for (const c of alpha) queries.push(d + " " + c);
  }

  // 2 digits + space + letter (2,600)
  for (const d1 of digits) {
    for (const d2 of digits) {
      for (const c of alpha) queries.push(d1 + d2 + " " + c);
    }
  }

  return queries;
}

/** Check if a normalized query has a pre-computed result */
export function isPrecomputedQuery(normalized: string): boolean {
  if (/^[a-z0-9]$/.test(normalized)) return true;          // 1-char
  if (/^[a-z]{2}$/.test(normalized)) return true;           // 2 letters
  if (/^[0-9]{2}$/.test(normalized)) return true;           // 2 digits
  if (/^[0-9]{1,2} [a-z]$/.test(normalized)) return true;   // N(N) + space + letter
  return false;
}

/** Normalize a query string: trim, collapse whitespace, strip non-alphanumeric (except spaces), lowercase */
export function normalizeQuery(q: string): string {
  return q.trim().replace(/[^a-zA-Z0-9\s]/g, "").replace(/\s+/g, " ").toLowerCase();
}
