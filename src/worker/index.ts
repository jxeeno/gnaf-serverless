import { createHash } from "node:crypto";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { formatAddressResponse } from "../shared/address-format.js";
import type { ShardMetadata } from "../shared/types.js";
import {
  fetchAddressShard,
  fetchLotDpShard,
  fetchStreetShard,
  fetchLatestVersion,
} from "./r2.js";
import { queryOverlays } from "./pmtiles.js";
import { executeSearch, entryToSla } from "./search.js";
import type { StreetRow } from "./search.js";
import { normalizeQuery, isPrecomputedQuery, loadPrecomputedQuery, warmShortQueries, warmShards } from "./warmup.js";

type Bindings = {
  GNAF_BUCKET: R2Bucket;
  GNAF_VERSION?: string;
  SHARD_PREFIX_LENGTH: string;
  SEARCH_DB: D1Database;
  PMTILES_BUCKET?: R2Bucket;
  PMTILES_LAYERS?: string;
};

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

// Cache TTL for search responses (1 week — data only changes on GNAF version updates)
const CACHE_TTL = 604800;

// Health check
app.get("/api/health", (c) => c.json({ status: "ok" }));

// GNAF metadata (version, address count, release info)
app.get("/api/metadata", async (c) => {
  const cache = caches.default;
  const cacheKey = new Request(c.req.url, { method: "GET" });
  const cachedResponse = await cache.match(cacheKey);
  if (cachedResponse) return cachedResponse;

  const gnafVersion = await resolveGnafVersion(c.env, c.executionCtx);
  const obj = await c.env.GNAF_BUCKET.get(`gnaf/${gnafVersion}/metadata.json`);
  if (!obj) {
    return c.json({ error: "Metadata not found" }, 404);
  }

  const metadata: ShardMetadata = await obj.json();
  const response = c.json(metadata, 200, {
    "Cache-Control": `public, max-age=${CACHE_TTL}`,
    "X-GNAF-Version": gnafVersion,
  });
  c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
});

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
  const gnafVersion = await resolveGnafVersion(c.env, c.executionCtx);

  // For short queries, serve from pre-computed R2 data
  const normalized = normalizeQuery(q);
  if (isPrecomputedQuery(normalized)) {
    const precomputed = await loadPrecomputedQuery(
      c.env.GNAF_BUCKET, gnafVersion, normalized, c.executionCtx
    );
    if (precomputed) {
      const body = {
        streets: precomputed.streets.slice(0, limit),
        addresses: precomputed.addresses.slice(0, limit),
      };
      const response = c.json(body, 200, {
        "Cache-Control": `public, max-age=${CACHE_TTL}`,
        "X-GNAF-Version": gnafVersion,
        "X-Precomputed": "true",
      });
      c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
      return response;
    }
  }

  // Full search via D1 + R2
  const result = await executeSearch(
    q, limit, c.env.SEARCH_DB, c.env.GNAF_BUCKET, gnafVersion, c.executionCtx
  );

  if (!result) {
    const response = c.json(
      { streets: [], addresses: [] },
      200,
      { "Cache-Control": "public, max-age=604800" }
    );
    c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  }

  const response = c.json(result.body, 200, {
    "Cache-Control": `public, max-age=${CACHE_TTL}`,
    "X-GNAF-Version": gnafVersion,
    "X-D1-Rows-Read": String(result.meta.d1RowsRead),
    "X-D1-Duration-Ms": String(result.meta.d1Duration),
    "X-R2-Fetches": String(result.meta.r2Fetches),
    "X-R2-Duration-Ms": String(result.meta.r2Duration),
  });

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
  if (c.env.PMTILES_BUCKET && c.env.PMTILES_LAYERS) {
    const defaultGeocode = body.geocoding.geocodes.find((g) => g.default) ??
      body.geocoding.geocodes[0];
    if (defaultGeocode) {
      try {
        const overlays = await queryOverlays(
          c.env.PMTILES_BUCKET,
          c.env.PMTILES_LAYERS,
          defaultGeocode.latitude,
          defaultGeocode.longitude
        );
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

export default {
  fetch: app.fetch,
  async scheduled(
    _event: ScheduledEvent,
    env: Bindings,
    ctx: ExecutionContext
  ) {
    const version = await resolveGnafVersion(env, ctx);

    // D1 keepalive — prevents cold connection on next user request
    await env.SEARCH_DB.prepare("SELECT 1").first();

    // Pre-compute short query results (once per version, stored in R2)
    await warmShortQueries(env.SEARCH_DB, env.GNAF_BUCKET, version, ctx);

    // Warm all R2 shard caches (skips already-cached entries)
    await warmShards(env.GNAF_BUCKET, version);
  },
};
