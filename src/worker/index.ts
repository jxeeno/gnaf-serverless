import { createHash } from "node:crypto";
import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  formatAddressResponse,
  reconstructSla,
} from "../shared/address-format.js";
import { parseSearchQuery, scoreAddress } from "../shared/search-query.js";
import type { StreetAddressEntry } from "../shared/types.js";
import {
  fetchAddressShard,
  fetchLotDpShard,
  fetchStreetShard,
  fetchLatestVersion,
} from "./r2.js";
import { queryOverlays } from "./pmtiles.js";

type Bindings = {
  GNAF_BUCKET: R2Bucket;
  GNAF_VERSION?: string;
  SHARD_PREFIX_LENGTH: string;
  SEARCH_DB: D1Database;
  PMTILES_BUCKET?: R2Bucket;
  PMTILES_LAYERS?: string;
};

interface StreetRow {
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

const app = new Hono<{ Bindings: Bindings }>();

app.use(
  "/api/*",
  cors({
    origin: "*",
    exposeHeaders: [
      "X-D1-Rows-Read",
      "X-D1-Duration-Ms",
      "X-R2-Fetches",
      "X-R2-Duration-Ms",
      "X-GNAF-Version",
    ],
  })
);

app.onError((err, c) => {
  console.error("Unhandled error:", err.message, err.stack);
  return c.json({ error: err.message }, 500);
});

function md5hex(input: string): string {
  return createHash("md5").update(input).digest("hex");
}

async function resolveGnafVersion(
  env: Bindings,
  ctx: ExecutionContext
): Promise<string> {
  return env.GNAF_VERSION || (await fetchLatestVersion(env.GNAF_BUCKET, ctx));
}

function getShardPrefixLength(env: Bindings): number {
  return parseInt(env.SHARD_PREFIX_LENGTH ?? "3", 10);
}

/** Reconstruct SLA from a compact street shard entry and street metadata */
function entryToSla(entry: StreetAddressEntry, street: StreetRow): string {
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

// Cache TTL for search responses (1 week — data only changes on GNAF version updates)
const CACHE_TTL = 604800;

// Health check
app.get("/api/health", (c) => c.json({ status: "ok" }));

// Search addresses by query string (autocomplete)
// Returns { streets: [...], addresses: [...] }
app.get("/api/addresses/search", async (c) => {
  const q = c.req.query("q")?.trim();
  if (!q || q.length < 2) {
    return c.json(
      { error: "Query must be at least 2 characters" },
      400
    );
  }

  // Check CF Cache API first
  const cache = caches.default;
  const cacheKey = new Request(c.req.url, { method: "GET" });
  const cachedResponse = await cache.match(cacheKey);
  if (cachedResponse) {
    return cachedResponse;
  }

  const limit = Math.min(parseInt(c.req.query("limit") ?? "10", 10), 50);

  const parsed = parseSearchQuery(q);
  if (!parsed) {
    return c.json(
      { streets: [], addresses: [] },
      200,
      { "Cache-Control": "public, max-age=604800" }
    );
  }

  const { numTokens, ftsQuery, streetHint, flatHint, levelHint } = parsed;

  const db = c.env.SEARCH_DB.withSession();

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
    searchResults = await db
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
    searchResults = await db
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
    return c.json(
      { streets: [], addresses: [] },
      200,
      { "Cache-Control": "public, max-age=604800" }
    );
  }

  // Streets are already ranked by SQL (FTS rank + number range + exact match bonuses)
  const matchedStreets = searchResults.results;

  // Build street results
  const streets = matchedStreets.slice(0, limit).map((r) => ({
    streetId: r.id,
    display: r.display,
    streetName: r.street_name,
    locality: r.locality_name,
    state: r.state,
    postcode: r.postcode,
    addressCount: r.address_count,
  }));

  // Fetch addresses from street shards
  const gnafVersion = await resolveGnafVersion(c.env, c.executionCtx);

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
      fetchStreetShard(c.env.GNAF_BUCKET, gnafVersion, prefix, c.executionCtx)
    )
  );
  const s3Duration = Date.now() - s3Start;

  // Collect all address entries with their street metadata
  interface ScoredAddress {
    pid: string;
    sla: string;
    streetId: number;
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
          streetId: street.id,
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

  const addresses = addressResults.map((a) => ({
    pid: a.pid,
    sla: a.sla,
    streetId: a.streetId,
  }));

  const d1RowsRead = searchResults.meta?.rows_read ?? 0;
  const d1Duration = searchResults.meta?.duration ?? 0;
  const s3Fetches = fetchEntries.length;

  const response = c.json(
    { streets, addresses },
    200,
    {
      "Cache-Control": `public, max-age=${CACHE_TTL}`,
      "X-GNAF-Version": gnafVersion,
      "X-D1-Rows-Read": String(d1RowsRead),
      "X-D1-Duration-Ms": String(d1Duration),
      "X-R2-Fetches": String(s3Fetches),
      "X-R2-Duration-Ms": String(s3Duration),
    }
  );

  // Store in CF Cache API (non-blocking)
  c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));

  return response;
});

// Get address by GNAF PID
app.get("/api/addresses/:pid", async (c) => {
  const cache = caches.default;
  const cacheKey = new Request(c.req.url, { method: "GET" });
  const cachedResponse = await cache.match(cacheKey);
  if (cachedResponse) return cachedResponse;

  const pid = c.req.param("pid").toUpperCase();
  const gnafVersion = await resolveGnafVersion(c.env, c.executionCtx);
  const prefixLen = getShardPrefixLength(c.env);
  const shardPrefix = md5hex(pid).substring(0, prefixLen);

  const shardData = await fetchAddressShard(
    c.env.GNAF_BUCKET,
    gnafVersion,
    shardPrefix,
    c.executionCtx
  );
  const record = shardData[pid];

  if (!record) {
    return c.json({ error: "Address not found", pid }, 404);
  }

  const body = formatAddressResponse(pid, record);

  // Query PMTiles overlays if configured
  console.log("PMTiles debug: PMTILES_BUCKET =", !!c.env.PMTILES_BUCKET, "PMTILES_LAYERS =", c.env.PMTILES_LAYERS);
  if (c.env.PMTILES_BUCKET && c.env.PMTILES_LAYERS) {
    const defaultGeocode = body.geocoding.geocodes.find((g) => g.default) ??
      body.geocoding.geocodes[0];
    console.log("PMTiles debug: defaultGeocode =", defaultGeocode?.latitude, defaultGeocode?.longitude);
    if (defaultGeocode) {
      try {
        const overlays = await queryOverlays(
          c.env.PMTILES_BUCKET,
          c.env.PMTILES_LAYERS,
          defaultGeocode.latitude,
          defaultGeocode.longitude
        );
        console.log("PMTiles debug: overlays =", JSON.stringify(overlays));
        if (Object.keys(overlays).length > 0) {
          body.overlays = overlays;
        }
      } catch (err) {
        console.error("PMTiles overlay query failed:", err);
      }
    }
  }

  const response = c.json(body, 200, {
    "Cache-Control": `public, max-age=${CACHE_TTL}`,
    "X-GNAF-Version": gnafVersion,
  });
  c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
});

// Lookup addresses by legal parcel ID (lpid). Also accepts "lotdp" for backwards compat.
app.get("/api/addresses", async (c) => {
  const lpid = c.req.query("lpid") ?? c.req.query("lotdp");
  if (!lpid) {
    return c.json(
      { error: "Missing required query parameter: lpid" },
      400
    );
  }

  const cache = caches.default;
  const cacheKey = new Request(c.req.url, { method: "GET" });
  const cachedResponse = await cache.match(cacheKey);
  if (cachedResponse) return cachedResponse;

  const gnafVersion = await resolveGnafVersion(c.env, c.executionCtx);
  const prefixLen = getShardPrefixLength(c.env);
  const lpidShardPrefix = md5hex(lpid).substring(0, prefixLen);

  const lpidIndex = await fetchLotDpShard(
    c.env.GNAF_BUCKET,
    gnafVersion,
    lpidShardPrefix,
    c.executionCtx
  );
  const pids = lpidIndex[lpid];

  if (!pids?.length) {
    return c.json({ error: "No addresses found for LPID", lpid }, 404);
  }

  // Group PIDs by their address shard prefix to minimize shard fetches
  const pidsByShardPrefix = new Map<string, string[]>();
  for (const pid of pids) {
    const prefix = md5hex(pid).substring(0, prefixLen);
    if (!pidsByShardPrefix.has(prefix)) {
      pidsByShardPrefix.set(prefix, []);
    }
    pidsByShardPrefix.get(prefix)!.push(pid);
  }

  // Fetch all needed shards in parallel
  const shardEntries = Array.from(pidsByShardPrefix.entries());
  const shardResults = await Promise.all(
    shardEntries.map(([prefix]) =>
      fetchAddressShard(c.env.GNAF_BUCKET, gnafVersion, prefix, c.executionCtx)
    )
  );

  // Collect addresses from all shards
  const addresses = [];
  for (let i = 0; i < shardEntries.length; i++) {
    const [, shardPids] = shardEntries[i];
    const shardData = shardResults[i];
    for (const pid of shardPids) {
      const record = shardData[pid];
      if (record) {
        addresses.push(formatAddressResponse(pid, record));
      }
    }
  }

  if (addresses.length === 0) {
    return c.json({ error: "No addresses found for LPID", lpid }, 404);
  }

  const response = c.json(addresses, 200, {
    "Cache-Control": `public, max-age=${CACHE_TTL}`,
    "X-GNAF-Version": gnafVersion,
  });
  c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
});

// Get all addresses on a street (for drill-down after search)
app.get("/api/streets/:streetId/addresses", async (c) => {
  const cache = caches.default;
  const cacheKey = new Request(c.req.url, { method: "GET" });
  const cachedResponse = await cache.match(cacheKey);
  if (cachedResponse) return cachedResponse;

  const streetId = parseInt(c.req.param("streetId"), 10);
  if (isNaN(streetId)) {
    return c.json({ error: "Invalid street ID" }, 400);
  }

  const digit = c.req.query("digit");

  const db = c.env.SEARCH_DB.withSession();

  // Look up the street from D1
  const street = await db
    .prepare(
      `SELECT street_key, shard_prefix, street_name, street_type, street_suffix,
              locality_name, state, postcode, digit_shards
       FROM streets WHERE id = ?1`
    )
    .bind(streetId)
    .first<StreetRow>();

  if (!street) {
    return c.json({ error: "Street not found", streetId }, 404);
  }

  const gnafVersion = await resolveGnafVersion(c.env, c.executionCtx);

  // Determine which shard keys to fetch
  const keysToFetch: { shardPrefix: string; shardKey: string }[] = [];

  if (street.digit_shards) {
    const digitMap: Record<string, string> = JSON.parse(street.digit_shards);

    if (digit != null) {
      // Fetch only the requested digit sub-shard
      const subPrefix = digitMap[digit];
      if (subPrefix) {
        keysToFetch.push({
          shardPrefix: subPrefix,
          shardKey: `${street.street_key}|${digit}`,
        });
      }
      // Also fetch base shard for un-numbered addresses
      keysToFetch.push({
        shardPrefix: street.shard_prefix,
        shardKey: street.street_key,
      });
    } else {
      // Fetch all sub-shards + base
      keysToFetch.push({
        shardPrefix: street.shard_prefix,
        shardKey: street.street_key,
      });
      for (const [d, prefix] of Object.entries(digitMap)) {
        keysToFetch.push({
          shardPrefix: prefix,
          shardKey: `${street.street_key}|${d}`,
        });
      }
    }
  } else {
    // No sub-sharding: fetch base shard only
    keysToFetch.push({
      shardPrefix: street.shard_prefix,
      shardKey: street.street_key,
    });
  }

  // Deduplicate by shard prefix (multiple keys may be in the same file)
  const uniquePrefixes = [...new Set(keysToFetch.map((k) => k.shardPrefix))];
  const shardResults = await Promise.all(
    uniquePrefixes.map((prefix) =>
      fetchStreetShard(c.env.GNAF_BUCKET, gnafVersion, prefix, c.executionCtx)
    )
  );
  const shardByPrefix = new Map(
    uniquePrefixes.map((p, i) => [p, shardResults[i]])
  );

  // Collect addresses
  const addresses: { p: string; s: string; n?: number; l?: number; f?: number }[] = [];
  for (const { shardPrefix, shardKey } of keysToFetch) {
    const shardData = shardByPrefix.get(shardPrefix);
    const entries = shardData?.[shardKey];
    if (!entries) continue;
    for (const entry of entries) {
      addresses.push({
        p: entry.p,
        s: entryToSla(entry, street as unknown as StreetRow),
        n: entry.n,
        l: entry.l,
        f: entry.f,
      });
    }
  }

  // Sort by street number, level, flat (ascending, nulls first)
  addresses.sort((a, b) =>
    (a.n ?? -1) - (b.n ?? -1) ||
    (a.l ?? -1) - (b.l ?? -1) ||
    (a.f ?? -1) - (b.f ?? -1)
  );

  if (addresses.length === 0) {
    return c.json({ error: "No addresses found for street", streetId }, 404);
  }

  const response = c.json(addresses.map(({ p, s }) => ({ p, s })), 200, {
    "Cache-Control": `public, max-age=${CACHE_TTL}`,
    "X-GNAF-Version": gnafVersion,
  });
  c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
});

export default app;
