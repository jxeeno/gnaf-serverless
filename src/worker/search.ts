import {
  parseSearchQuery,
  scoreAddress,
  computeHighlightRanges,
} from "../shared/search-query.js";
import { reconstructSla } from "../shared/address-format.js";
import type {
  IndexCacheStats,
  QueryCorrection,
  SearchBackend,
  StreetFinder,
  StreetFinderResult,
} from "../shared/street-finder.js";
import type { StreetAddressEntry, StreetRow } from "../shared/types.js";
import { fetchStreetShard } from "./r2.js";

export type { StreetRow };

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
  /** Principal address PID, when this address is a synonym alias */
  aliasOf?: string;
}

/** When scores tie, list principal addresses before aliases */
function principalFirst(a: { aliasOf?: string }, b: { aliasOf?: string }): number {
  return (a.aliasOf ? 1 : 0) - (b.aliasOf ? 1 : 0);
}

export interface SearchMeta {
  backend: SearchBackend;
  /** Street lookup: D1 rows read, or index rows scored */
  streetRowsRead: number;
  streetDuration: number;
  /** Index files requested for street lookup (R2 index only) */
  streetFetches: number;
  /** Wall-clock time for street lookup, including network time to D1 or R2 */
  streetLookupMs: number;
  indexCache?: IndexCacheStats;
  /** Street address shard fetches */
  r2Fetches: number;
  r2Duration: number;
}

export interface SearchResponse {
  body: {
    streets: StreetResult[];
    addresses: AddressResult[];
    /** Present when results come from fuzzy-corrected words */
    corrections?: QueryCorrection[];
  };
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

function searchMeta(
  found: StreetFinderResult,
  backend: SearchBackend,
  streetLookupMs: number,
  r2Fetches: number,
  r2Duration: number
): SearchMeta {
  return {
    backend,
    streetRowsRead: found.rowsRead,
    streetDuration: found.durationMs,
    streetFetches: found.fetches,
    streetLookupMs,
    ...(found.indexCache ? { indexCache: found.indexCache } : {}),
    r2Fetches,
    r2Duration,
  };
}

/** Apply a street's fuzzy word replacements to the query so highlights line up */
function highlightQuery(q: string, street: StreetRow): string {
  if (!street.query_replacements) return q;
  let result = q;
  for (const [token, word] of Object.entries(street.query_replacements)) {
    result = result.replace(new RegExp(`\\b${token}\\b`, "i"), word);
  }
  return result;
}

/**
 * Handle number-only queries (e.g., "5", "12") by finding popular streets
 * whose address range includes the number, then fetching sample addresses.
 */
async function executeNumberOnlySearch(
  num: number,
  limit: number,
  finder: StreetFinder,
  bucket: R2Bucket,
  version: string,
  ctx: ExecutionContext
): Promise<SearchResponse> {
  const streetLimit = Math.max(30, limit * 3);
  const lookupStart = Date.now();
  const found = await finder.findByNumber(num, streetLimit);
  const lookupMs = Date.now() - lookupStart;

  if (!found.rows.length) {
    return {
      body: { streets: [], addresses: [] },
      meta: searchMeta(found, finder.backend, lookupMs, 0, 0),
    };
  }

  const matchedStreets = found.rows;
  const numStr = String(num);

  const streets: StreetResult[] = matchedStreets.slice(0, limit).map((r) => ({
    streetId: r.id,
    display: r.display,
    highlight: [],
    streetName: r.street_name,
    locality: r.locality_name,
    state: r.state,
    postcode: r.postcode,
    addressCount: r.address_count,
  }));

  // Fetch the relevant digit sub-shard (or base shard) for each street
  const shardFetches = new Map<string, string[]>();
  function addFetch(prefix: string, key: string) {
    if (!shardFetches.has(prefix)) shardFetches.set(prefix, []);
    shardFetches.get(prefix)!.push(key);
  }

  const digit = numStr.charAt(0);
  for (const street of matchedStreets) {
    if (street.digit_shards) {
      const digitMap: Record<string, string> = JSON.parse(street.digit_shards);
      const subPrefix = digitMap[digit];
      if (subPrefix) {
        addFetch(subPrefix, `${street.street_key}|${digit}`);
      }
    } else {
      addFetch(street.shard_prefix, street.street_key);
    }
  }

  const fetchEntries = Array.from(shardFetches.entries());
  const s3Start = Date.now();
  const shardResults = await Promise.all(
    fetchEntries.map(([prefix]) => fetchStreetShard(bucket, version, prefix, ctx))
  );
  const s3Duration = Date.now() - s3Start;

  const streetByKey = new Map(matchedStreets.map((s) => [s.street_key, s]));

  interface ScoredAddr {
    pid: string;
    sla: string;
    streetId: number;
    aliasOf?: string;
    score: number;
  }

  const scored: ScoredAddr[] = [];
  for (let i = 0; i < fetchEntries.length; i++) {
    const [, shardKeys] = fetchEntries[i];
    const shardData = shardResults[i];
    for (const shardKey of shardKeys) {
      const entries = shardData[shardKey];
      if (!entries) continue;
      const pipeIdx = shardKey.lastIndexOf("|");
      const baseKey = pipeIdx > 0 && shardKey.length - pipeIdx <= 2
        ? shardKey.substring(0, pipeIdx) : shardKey;
      const street = streetByKey.get(baseKey);
      if (!street) continue;
      for (const entry of entries) {
        // Match: street number equals the queried number (or within range)
        if (entry.n == null) continue;
        const exactMatch = entry.n === num;
        const rangeMatch = entry.n2 != null && num >= entry.n && num <= entry.n2;
        if (!exactMatch && !rangeMatch) continue;
        // Prefer bare addresses (no flat/level)
        const score = exactMatch
          ? (entry.f == null && entry.l == null ? 100 : 90)
          : 50;
        scored.push({
          pid: entry.p,
          sla: entryToSla(entry, street),
          streetId: street.id,
          aliasOf: entry.pp,
          score,
        });
      }
    }
  }

  scored.sort((a, b) => b.score - a.score || principalFirst(a, b));

  // Diversify: 1 per street first, then backfill
  const seenStreets = new Set<number>();
  const firstPass: ScoredAddr[] = [];
  const remainder: ScoredAddr[] = [];
  for (const addr of scored) {
    if (!seenStreets.has(addr.streetId)) {
      seenStreets.add(addr.streetId);
      firstPass.push(addr);
    } else {
      remainder.push(addr);
    }
  }
  const results = firstPass.slice(0, limit);
  if (results.length < limit) {
    results.push(...remainder.slice(0, limit - results.length));
  }

  const addresses: AddressResult[] = results.map((a) => ({
    pid: a.pid,
    sla: a.sla,
    ...(a.aliasOf ? { aliasOf: a.aliasOf } : {}),
    highlight: computeHighlightRanges(a.sla, {
      streetName: "",
      localityName: "",
      state: "",
      displayPrefix: a.sla.split(",")[0] ?? "",
    }, String(num)),
    streetId: a.streetId,
  }));

  return {
    body: { streets, addresses },
    meta: searchMeta(found, finder.backend, lookupMs, fetchEntries.length, s3Duration),
  };
}

/**
 * Execute a search query: find ranked streets with the given finder (D1 or the
 * R2 index), then score addresses from R2 street shards.
 * Returns null if the query doesn't parse (no text tokens).
 */
export async function executeSearch(
  q: string,
  limit: number,
  finder: StreetFinder,
  bucket: R2Bucket,
  version: string,
  ctx: ExecutionContext
): Promise<SearchResponse | null> {
  const parsed = parseSearchQuery(q);

  // Number-only queries (e.g., "5", "12") have no text tokens so parseSearchQuery
  // returns null. Handle them by finding streets whose address range includes the
  // number, ordered by popularity (address_count), to show representative results.
  if (!parsed) {
    const numMatch = q.trim().match(/^(\d+)$/);
    if (!numMatch) return null;
    return executeNumberOnlySearch(parseInt(numMatch[1], 10), limit, finder, bucket, version, ctx);
  }

  const { numTokens, streetHint, flatHint } = parsed;

  // Ranking favours exact street name matches and streets whose number/flat
  // ranges include the queried numbers, so fetch extra streets when numbers are present.
  const streetLimit = numTokens.length > 0 ? Math.max(30, limit * 3) : limit;
  const lookupStart = Date.now();
  const found = await finder.findByQuery(parsed, streetLimit);
  const lookupMs = Date.now() - lookupStart;

  if (!found.rows.length) {
    return {
      body: { streets: [], addresses: [] },
      meta: searchMeta(found, finder.backend, lookupMs, 0, 0),
    };
  }

  const matchedStreets = found.rows;

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
    }, highlightQuery(q, r)),
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
    highlightQuery: string;
    aliasOf?: string;
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
          highlightQuery: highlightQuery(q, street),
          aliasOf: entry.pp,
          score,
        });
      }
    }
  }

  // Sort by score descending, take top results
  scoredAddresses.sort((a, b) => b.score - a.score || principalFirst(a, b));

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
    ...(a.aliasOf ? { aliasOf: a.aliasOf } : {}),
    highlight: computeHighlightRanges(a.sla, {
      streetName: a.streetName,
      streetType: a.streetType,
      streetSuffix: a.streetSuffix,
      localityName: a.localityName,
      state: a.state,
      postcode: a.postcode,
      displayPrefix: a.displayPrefix,
    }, a.highlightQuery),
    streetId: a.streetId,
  }));

  return {
    body: {
      streets,
      addresses,
      ...(found.corrections ? { corrections: found.corrections } : {}),
    },
    meta: searchMeta(found, finder.backend, lookupMs, fetchEntries.length, s3Duration),
  };
}
