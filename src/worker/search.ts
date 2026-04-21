import {
  parseSearchQuery,
  scoreAddress,
  computeHighlightRanges,
} from "../shared/search-query.js";
import { reconstructSla } from "../shared/address-format.js";
import type { StreetAddressEntry } from "../shared/types.js";
import { fetchStreetShard } from "./r2.js";

export interface StreetRow {
  id: number;
  display: string;
  display_search: string;
  street_key: string;
  shard_prefix: string;
  street_name: string;
  street_type: string | null;
  street_suffix: string | null;
  locality_name: string;
  state: string;
  postcode: string | null;
  address_count: number;
  digit_shards: string | null;
  num_min: number | null;
  num_max: number | null;
  flat_min: number | null;
  flat_max: number | null;
}

export interface StreetResult {
  streetId: number;
  display: string;
  highlight: [number, number][];
  streetName: string;
  locality: string;
  state: string;
  postcode: string | null;
  addressCount: number;
}

export interface AddressResult {
  pid: string;
  sla: string;
  highlight: [number, number][];
  streetId: number;
}

export interface SearchMeta {
  d1RowsRead: number;
  d1Duration: number;
  r2Fetches: number;
  r2Duration: number;
}

export interface SearchResponse {
  body: { streets: StreetResult[]; addresses: AddressResult[] };
  meta: SearchMeta;
}

/** Reconstruct SLA from a compact street shard entry and street metadata */
export function entryToSla(entry: StreetAddressEntry, street: StreetRow): string {
  return reconstructSla(
    entry.d,
    street.street_name,
    street.street_type,
    street.street_suffix,
    street.locality_name,
    street.state,
    street.postcode
  );
}

/**
 * Execute a search query against D1 + R2 and return structured results.
 * Returns null if the query doesn't parse (no text tokens).
 */
export async function executeSearch(
  q: string,
  limit: number,
  db: D1Database,
  bucket: R2Bucket,
  version: string,
  ctx: ExecutionContext
): Promise<SearchResponse | null> {
  const parsed = parseSearchQuery(q);
  if (!parsed) return null;

  const { numTokens, ftsQuery, streetHint, flatHint, levelHint } = parsed;

  const dbSession = db.withSession();

  // Search FTS5 index with combined ranking in SQL.
  // The ORDER BY combines FTS5 rank (negative, lower = better) with bonuses for:
  // 1. Street name exact match vs prefix-only match (e.g., "KENT" over "KENTUCKY")
  // 2. Street number within the street's address range
  // 3. Flat number within the street's flat range
  // This ensures relevant streets aren't cut off by the LIMIT.
  const streetLimit = numTokens.length > 0 ? Math.max(30, limit * 3) : limit;
  // First text token is typically the street name — used for exact vs prefix matching
  const firstTextToken = parsed.textTokens[0];

  // Optimization: when there's only 1 short text token (e.g., "20 W"), skip FTS5 and
  // use a direct street_name LIKE query with num_min/num_max WHERE filters. FTS5
  // prefix scans like W* read hundreds of thousands of rows; a LIKE query on an
  // indexed column is much cheaper. Number hints > 999 are truncated to the first
  // 3 digits (e.g., 8012 → 801) to provide a rough range filter without being too
  // restrictive for large numbers.
  const useDirectQuery =
    parsed.textTokens.length === 1 && firstTextToken.length < 2;

  const rankingExpr = `
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

  let searchResults: D1Result<StreetRow>;

  if (useDirectQuery) {
    // Truncate hints to first 3 digits for WHERE filter (e.g., 8012 → 801)
    // This provides a rough range filter without being too restrictive for large numbers
    const capTo3 = (n: number | null) =>
      n != null && n > 999 ? parseInt(String(n).substring(0, 3), 10) : n;
    searchResults = await dbSession
      .prepare(
        `SELECT s.id, s.display, s.display_search, s.street_key, s.shard_prefix,
                s.street_name, s.street_type, s.street_suffix, s.locality_name,
                s.state, s.postcode, s.address_count, s.digit_shards,
                s.num_min, s.num_max, s.flat_min, s.flat_max
         FROM streets AS s
         WHERE s.street_name LIKE ?1 || '%'
           AND (?2 IS NULL OR (s.num_min IS NOT NULL AND s.num_max IS NOT NULL AND ?2 BETWEEN s.num_min AND s.num_max))
           AND (?3 IS NULL OR (s.flat_min IS NOT NULL AND s.flat_max IS NOT NULL AND ?3 BETWEEN s.flat_min AND s.flat_max))
         -- No ORDER BY here: this direct-query path is used for single-char street names
         -- (e.g., "20 W") where FTS5 is too expensive. Adding ORDER BY would force a full
         -- table scan defeating the purpose. The FTS path below handles ranking instead.
         LIMIT ?5`
      )
      .bind(firstTextToken, capTo3(streetHint), capTo3(flatHint ?? levelHint), firstTextToken, streetLimit)
      .all<StreetRow>();
  } else {
    searchResults = await dbSession
      .prepare(
        `SELECT s.id, s.display, s.display_search, s.street_key, s.shard_prefix,
                s.street_name, s.street_type, s.street_suffix, s.locality_name,
                s.state, s.postcode, s.address_count, s.digit_shards,
                s.num_min, s.num_max, s.flat_min, s.flat_max
         FROM streets_fts AS fts
         JOIN streets AS s ON s.id = fts.rowid
         WHERE streets_fts MATCH ?1
         ORDER BY rank - (${rankingExpr})
         LIMIT ?5`
      )
      .bind(ftsQuery, streetHint, flatHint ?? levelHint, firstTextToken, streetLimit)
      .all<StreetRow>();
  }

  if (!searchResults.results.length) {
    return {
      body: { streets: [], addresses: [] },
      meta: {
        d1RowsRead: searchResults.meta?.rows_read ?? 0,
        d1Duration: searchResults.meta?.duration ?? 0,
        r2Fetches: 0,
        r2Duration: 0,
      },
    };
  }

  // Streets are already ranked by SQL (FTS rank + number range + exact match bonuses)
  const matchedStreets = searchResults.results;

  // Build street results
  const streets: StreetResult[] = matchedStreets.slice(0, limit).map((r) => ({
    streetId: r.id,
    display: r.display,
    highlight: computeHighlightRanges(r.display, {
      streetName: r.street_name,
      streetType: r.street_type,
      streetSuffix: r.street_suffix,
      localityName: r.locality_name,
      state: r.state,
      postcode: r.postcode,
    }, q),
    streetName: r.street_name,
    locality: r.locality_name,
    state: r.state,
    postcode: r.postcode,
    addressCount: r.address_count,
  }));

  // Determine which shard prefixes to fetch
  const shardFetches = new Map<string, string[]>(); // shardPrefix → [shardKey, ...]

  function addShardFetch(prefix: string, key: string) {
    if (!shardFetches.has(prefix)) shardFetches.set(prefix, []);
    shardFetches.get(prefix)!.push(key);
  }

  for (const street of matchedStreets) {
    if (street.digit_shards) {
      const digitMap: Record<string, string> = JSON.parse(
        street.digit_shards
      );

      if (streetHint != null) {
        // Known street number — fetch only the relevant digit sub-shard
        const digit = String(streetHint).charAt(0);
        const subShardPrefix = digitMap[digit];
        if (subShardPrefix) {
          addShardFetch(subShardPrefix, `${street.street_key}|${digit}`);
        }
      } else if (flatHint != null) {
        // Flat number only (e.g., "unit 3 murray") — need all sub-shards
        addShardFetch(street.shard_prefix, street.street_key);
        for (const [d, prefix] of Object.entries(digitMap)) {
          addShardFetch(prefix, `${street.street_key}|${d}`);
        }
      } else {
        // No numbers: fetch base shard + first digit sub-shard for representative addresses.
        // Large streets have all numbered addresses in digit sub-shards, so the base shard
        // alone may be empty.
        addShardFetch(street.shard_prefix, street.street_key);
        const firstDigit = Object.keys(digitMap).sort()[0];
        if (firstDigit != null) {
          addShardFetch(digitMap[firstDigit], `${street.street_key}|${firstDigit}`);
        }
      }
    } else {
      // No digit sub-sharding: fetch base shard
      addShardFetch(street.shard_prefix, street.street_key);
    }
  }

  // Fetch all needed shard files in parallel
  const fetchEntries = Array.from(shardFetches.entries());
  const s3Start = Date.now();
  const shardResults = await Promise.all(
    fetchEntries.map(([prefix]) =>
      fetchStreetShard(bucket, version, prefix, ctx)
    )
  );
  const s3Duration = Date.now() - s3Start;

  // Collect all address entries with their street metadata
  interface ScoredAddress {
    pid: string;
    sla: string;
    displayPrefix: string;
    streetId: number;
    streetName: string;
    streetType: string | null;
    streetSuffix: string | null;
    localityName: string;
    state: string;
    postcode: string | null;
    score: number;
  }

  const scoredAddresses: ScoredAddress[] = [];

  // Build a lookup from street_key to street
  const streetByKey = new Map(
    matchedStreets.map((s) => [s.street_key, s])
  );

  for (let i = 0; i < fetchEntries.length; i++) {
    const [, shardKeys] = fetchEntries[i];
    const shardData = shardResults[i];

    for (const shardKey of shardKeys) {
      const entries = shardData[shardKey];
      if (!entries) continue;

      // Determine the base street key (strip |digit suffix if present)
      const pipeIdx = shardKey.lastIndexOf("|");
      const baseKey =
        pipeIdx > 0 && shardKey.length - pipeIdx <= 2
          ? shardKey.substring(0, pipeIdx)
          : shardKey;
      const street = streetByKey.get(baseKey);
      if (!street) continue;

      for (const entry of entries) {
        const score = scoreAddress(entry, parsed);
        if (score === 0) continue;

        scoredAddresses.push({
          pid: entry.p,
          sla: entryToSla(entry, street),
          displayPrefix: entry.d,
          streetId: street.id,
          streetName: street.street_name,
          streetType: street.street_type,
          streetSuffix: street.street_suffix,
          localityName: street.locality_name,
          state: street.state,
          postcode: street.postcode,
          score,
        });
      }
    }
  }

  // Sort by score descending, take top results
  scoredAddresses.sort((a, b) => b.score - a.score);

  // When no numbers, first pick 1 per street for variety, then backfill remaining
  // slots with additional addresses from the same streets (highest scored first).
  // This means "example street villawood" (1 matching street) returns up to `limit`
  // addresses, while "kent" (many streets) shows variety first then backfills.
  let addressResults: ScoredAddress[];
  if (numTokens.length === 0) {
    const seenStreets = new Set<number>();
    const firstPass: ScoredAddress[] = [];
    const remainder: ScoredAddress[] = [];
    for (const addr of scoredAddresses) {
      if (!seenStreets.has(addr.streetId)) {
        seenStreets.add(addr.streetId);
        firstPass.push(addr);
      } else {
        remainder.push(addr);
      }
    }
    addressResults = firstPass.slice(0, limit);
    if (addressResults.length < limit) {
      addressResults.push(...remainder.slice(0, limit - addressResults.length));
    }
  } else {
    addressResults = scoredAddresses.slice(0, limit);
  }

  const addresses: AddressResult[] = addressResults.map((a) => ({
    pid: a.pid,
    sla: a.sla,
    highlight: computeHighlightRanges(a.sla, {
      streetName: a.streetName,
      streetType: a.streetType,
      streetSuffix: a.streetSuffix,
      localityName: a.localityName,
      state: a.state,
      postcode: a.postcode,
      displayPrefix: a.displayPrefix,
    }, q),
    streetId: a.streetId,
  }));

  return {
    body: { streets, addresses },
    meta: {
      d1RowsRead: searchResults.meta?.rows_read ?? 0,
      d1Duration: searchResults.meta?.duration ?? 0,
      r2Fetches: fetchEntries.length,
      r2Duration: s3Duration,
    },
  };
}
