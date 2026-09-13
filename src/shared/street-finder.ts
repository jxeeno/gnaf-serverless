import type { ParsedQuery } from "./search-query.js";
import type { StreetRow } from "./types.js";

/** Where street candidates for a search come from */
export type SearchBackend = "d1" | "r2";

/** A query token that had no match, and the index words it was corrected to */
export interface QueryCorrection {
  token: string;
  replacements: string[];
}

export interface StreetFinderResult {
  /** Ranked streets, best first */
  rows: StreetRow[];
  /** D1 rows read, or index rows scored for the R2 index */
  rowsRead: number;
  durationMs: number;
  /** Index files requested (R2 index only) */
  fetches: number;
  /** Set when results come from fuzzy-corrected tokens */
  corrections?: QueryCorrection[];
}

/**
 * Finds and ranks streets for a search. Address scoring and result building in
 * `executeSearch` are shared; only street lookup differs between backends.
 */
export interface StreetFinder {
  readonly backend: SearchBackend;
  findByQuery(parsed: ParsedQuery, streetLimit: number): Promise<StreetFinderResult>;
  /** Streets whose address range includes `num`, most addresses first */
  findByNumber(num: number, streetLimit: number): Promise<StreetFinderResult>;
  findById(id: number): Promise<StreetRow | null>;
}
