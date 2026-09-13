import type { ParsedQuery } from "./search-query.js";
import type { StreetFinder, StreetFinderResult } from "./street-finder.js";
import type { StreetRow } from "./types.js";

/** The subset of the D1 session API used here (also implemented over node:sqlite for comparisons) */
export interface SqlStatement {
  bind(...values: unknown[]): SqlStatement;
  all<T = unknown>(): Promise<{
    results: T[];
    meta?: { rows_read?: number; duration?: number };
  }>;
  first<T = unknown>(): Promise<T | null>;
}

export interface SqlSession {
  prepare(query: string): SqlStatement;
}

const STREET_COLUMNS = `s.id, s.display, s.display_search, s.street_key, s.shard_prefix,
                s.street_name, s.street_type, s.street_suffix, s.locality_name,
                s.state, s.postcode, s.address_count, s.digit_shards,
                s.num_min, s.num_max, s.flat_min, s.flat_max`;

const RANKING_EXPR = `
         (
           CASE WHEN s.street_name = ?4 THEN
                  CASE WHEN LENGTH(?4) >= 4 THEN 100 ELSE 15 END
                WHEN s.street_name LIKE ?4 || '%' THEN 10
           ELSE 0 END
         )
         + (
           CASE WHEN ?2 IS NOT NULL AND s.num_min IS NOT NULL AND s.num_max IS NOT NULL THEN
             CASE WHEN ?2 BETWEEN s.num_min AND s.num_max THEN 200 ELSE -50 END
           ELSE 0 END
         )
         + (
           CASE WHEN ?3 IS NOT NULL AND s.flat_min IS NOT NULL AND s.flat_max IS NOT NULL THEN
             CASE WHEN ?3 BETWEEN s.flat_min AND s.flat_max THEN 50 ELSE 0 END
           ELSE 0 END
         )
         + (
           CASE WHEN s.address_count >= 2000 THEN 20
                WHEN s.address_count >= 500 THEN 15
                WHEN s.address_count >= 100 THEN 10
                WHEN s.address_count >= 20 THEN 5
           ELSE 0 END
         )`;

/** Single short text token (e.g. "20 W"): direct LIKE query instead of an FTS5 prefix scan */
export function usesDirectNameQuery(parsed: ParsedQuery): boolean {
  return parsed.textTokens.length === 1 && parsed.textTokens[0].length < 2;
}

/** Truncate hints to the first 3 digits for the direct query filter (e.g. 8012 → 801) */
export function capHintTo3Digits(n: number | null): number | null {
  return n != null && n > 999 ? parseInt(String(n).substring(0, 3), 10) : n;
}

function toResult(
  results: StreetRow[],
  meta: { rows_read?: number; duration?: number } | undefined
): StreetFinderResult {
  return {
    rows: results,
    rowsRead: meta?.rows_read ?? 0,
    durationMs: meta?.duration ?? 0,
    fetches: 0,
  };
}

/** Street finder backed by the D1 `streets` table and `streets_fts` FTS5 index */
export function createSqlStreetFinder(db: SqlSession): StreetFinder {
  return {
    backend: "d1",

    async findByQuery(parsed, streetLimit) {
      const { ftsQuery, streetHint, flatHint, levelHint } = parsed;
      // First text token is typically the street name — used for exact vs prefix matching
      const firstTextToken = parsed.textTokens[0];

      // FTS5 prefix scans like W* read hundreds of thousands of rows; a LIKE query
      // on street_name with num_min/num_max filters is much cheaper.
      if (usesDirectNameQuery(parsed)) {
        const { results, meta } = await db
          .prepare(
            `SELECT ${STREET_COLUMNS}
         FROM streets AS s
         WHERE s.street_name LIKE ?1 || '%'
           AND (?2 IS NULL OR (s.num_min IS NOT NULL AND s.num_max IS NOT NULL AND ?2 BETWEEN s.num_min AND s.num_max))
           AND (?3 IS NULL OR (s.flat_min IS NOT NULL AND s.flat_max IS NOT NULL AND ?3 BETWEEN s.flat_min AND s.flat_max))
         -- No ORDER BY here: this direct-query path is used for single-char street names
         -- (e.g., "20 W") where FTS5 is too expensive. Adding ORDER BY would force a full
         -- table scan defeating the purpose. The FTS path below handles ranking instead.
         LIMIT ?5`
          )
          .bind(firstTextToken, capHintTo3Digits(streetHint), capHintTo3Digits(flatHint ?? levelHint), firstTextToken, streetLimit)
          .all<StreetRow>();
        return toResult(results, meta);
      }

      // The ORDER BY combines FTS5 rank (negative, lower = better) with bonuses for:
      // 1. Street name exact match vs prefix-only match (e.g., "KENT" over "KENTUCKY")
      // 2. Street number within the street's address range
      // 3. Flat number within the street's flat range
      // This ensures relevant streets aren't cut off by the LIMIT.
      const { results, meta } = await db
        .prepare(
          `SELECT ${STREET_COLUMNS}
         FROM streets_fts AS fts
         JOIN streets AS s ON s.id = fts.rowid
         WHERE streets_fts MATCH ?1
         ORDER BY rank - (${RANKING_EXPR})
         LIMIT ?5`
        )
        .bind(ftsQuery, streetHint, flatHint ?? levelHint, firstTextToken, streetLimit)
        .all<StreetRow>();
      return toResult(results, meta);
    },

    async findByNumber(num, streetLimit) {
      const { results, meta } = await db
        .prepare(
          `SELECT ${STREET_COLUMNS}
       FROM streets AS s
       WHERE s.num_min IS NOT NULL AND s.num_max IS NOT NULL
         AND ?1 BETWEEN s.num_min AND s.num_max
       ORDER BY s.address_count DESC
       LIMIT ?2`
        )
        .bind(num, streetLimit)
        .all<StreetRow>();
      return toResult(results, meta);
    },

    async findById(id) {
      return db
        .prepare(`SELECT ${STREET_COLUMNS} FROM streets AS s WHERE s.id = ?1`)
        .bind(id)
        .first<StreetRow>();
    },
  };
}
