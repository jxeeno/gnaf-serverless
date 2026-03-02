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
  type S3BaseConfig,
  type S3Config,
} from "./s3.js";

type Bindings = {
  S3_ENDPOINT: string;
  S3_BUCKET: string;
  S3_ACCESS_KEY_ID: string;
  S3_SECRET_ACCESS_KEY: string;
  S3_REGION: string;
  GNAF_VERSION?: string;
  SHARD_PREFIX_LENGTH: string;
  SEARCH_DB: D1Database;
};

interface StreetRow {
  id: number;
  display: string;
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
}

const app = new Hono<{ Bindings: Bindings }>();

app.use("/api/*", cors());

app.onError((err, c) => {
  console.error("Unhandled error:", err.message, err.stack);
  return c.json({ error: err.message }, 500);
});

function md5hex(input: string): string {
  return createHash("md5").update(input).digest("hex");
}

function getBaseS3Config(env: Bindings): S3BaseConfig {
  return {
    endpoint: env.S3_ENDPOINT,
    bucket: env.S3_BUCKET,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    region: env.S3_REGION ?? "auto",
  };
}

async function resolveS3Config(
  env: Bindings,
  ctx: ExecutionContext
): Promise<S3Config> {
  const base = getBaseS3Config(env);
  const version = env.GNAF_VERSION || (await fetchLatestVersion(base, ctx));
  return { ...base, gnafVersion: version };
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

  const limit = Math.min(parseInt(c.req.query("limit") ?? "10", 10), 50);

  const parsed = parseSearchQuery(q);
  if (!parsed) {
    return c.json(
      { streets: [], addresses: [] },
      200,
      { "Cache-Control": "public, max-age=604800" }
    );
  }

  const { numTokens, ftsQuery, streetHint, flatHint } = parsed;

  const db = c.env.SEARCH_DB;

  // Search FTS5 index — fetch more streets than limit to allow address scoring
  const streetLimit = numTokens.length > 0 ? limit * 3 : limit;
  const searchResults = await db
    .prepare(
      `SELECT s.id, s.display, s.street_key, s.shard_prefix, s.street_name,
              s.street_type, s.street_suffix, s.locality_name, s.state,
              s.postcode, s.address_count, s.digit_shards
       FROM streets_fts AS fts
       JOIN streets AS s ON s.id = fts.rowid
       WHERE streets_fts MATCH ?1
       ORDER BY rank
       LIMIT ?2`
    )
    .bind(ftsQuery, streetLimit)
    .all<StreetRow>();

  if (!searchResults.results.length) {
    return c.json(
      { streets: [], addresses: [] },
      200,
      { "Cache-Control": "public, max-age=604800" }
    );
  }

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
  const config = await resolveS3Config(c.env, c.executionCtx);

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
        // No numbers: fetch base shard for representative addresses
        addShardFetch(street.shard_prefix, street.street_key);
      }
    } else {
      // No digit sub-sharding: fetch base shard
      addShardFetch(street.shard_prefix, street.street_key);
    }
  }

  // Fetch all needed shard files in parallel
  const fetchEntries = Array.from(shardFetches.entries());
  const shardResults = await Promise.all(
    fetchEntries.map(([prefix]) =>
      fetchStreetShard(config, prefix, c.executionCtx)
    )
  );

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

  // When no numbers, limit to 1 per street for representative results
  let addressResults: ScoredAddress[];
  if (numTokens.length === 0) {
    const seenStreets = new Set<number>();
    addressResults = [];
    for (const addr of scoredAddresses) {
      if (seenStreets.has(addr.streetId)) continue;
      seenStreets.add(addr.streetId);
      addressResults.push(addr);
      if (addressResults.length >= limit) break;
    }
  } else {
    addressResults = scoredAddresses.slice(0, limit);
  }

  const addresses = addressResults.map((a) => ({
    pid: a.pid,
    sla: a.sla,
    streetId: a.streetId,
  }));

  return c.json(
    { streets, addresses },
    200,
    { "Cache-Control": "public, max-age=604800" }
  );
});

// Get address by GNAF PID
app.get("/api/addresses/:pid", async (c) => {
  const pid = c.req.param("pid").toUpperCase();
  const config = await resolveS3Config(c.env, c.executionCtx);
  const prefixLen = getShardPrefixLength(c.env);
  const shardPrefix = md5hex(pid).substring(0, prefixLen);

  const shardData = await fetchAddressShard(
    config,
    shardPrefix,
    c.executionCtx
  );
  const record = shardData[pid];

  if (!record) {
    return c.json({ error: "Address not found", pid }, 404);
  }

  const response = formatAddressResponse(pid, record);
  return c.json(response, 200, {
    "Cache-Control": "public, max-age=604800",
  });
});

// Lookup addresses by lot/DP reference
app.get("/api/addresses", async (c) => {
  const lotdp = c.req.query("lotdp");
  if (!lotdp) {
    return c.json(
      { error: "Missing required query parameter: lotdp" },
      400
    );
  }

  const config = await resolveS3Config(c.env, c.executionCtx);
  const prefixLen = getShardPrefixLength(c.env);
  const lotdpShardPrefix = md5hex(lotdp).substring(0, prefixLen);

  const lotdpIndex = await fetchLotDpShard(
    config,
    lotdpShardPrefix,
    c.executionCtx
  );
  const pids = lotdpIndex[lotdp];

  if (!pids?.length) {
    return c.json({ error: "No addresses found for lot/DP", lotdp }, 404);
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
      fetchAddressShard(config, prefix, c.executionCtx)
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
    return c.json({ error: "No addresses found for lot/DP", lotdp }, 404);
  }

  return c.json(addresses, 200, {
    "Cache-Control": "public, max-age=604800",
  });
});

// Get all addresses on a street (for drill-down after search)
app.get("/api/streets/:streetId/addresses", async (c) => {
  const streetId = parseInt(c.req.param("streetId"), 10);
  if (isNaN(streetId)) {
    return c.json({ error: "Invalid street ID" }, 400);
  }

  const digit = c.req.query("digit");

  const db = c.env.SEARCH_DB;

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

  const config = await resolveS3Config(c.env, c.executionCtx);

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
      fetchStreetShard(config, prefix, c.executionCtx)
    )
  );
  const shardByPrefix = new Map(
    uniquePrefixes.map((p, i) => [p, shardResults[i]])
  );

  // Collect addresses
  const addresses: { p: string; s: string }[] = [];
  for (const { shardPrefix, shardKey } of keysToFetch) {
    const shardData = shardByPrefix.get(shardPrefix);
    const entries = shardData?.[shardKey];
    if (!entries) continue;
    for (const entry of entries) {
      addresses.push({
        p: entry.p,
        s: entryToSla(entry, street as unknown as StreetRow),
      });
    }
  }

  if (addresses.length === 0) {
    return c.json({ error: "No addresses found for street", streetId }, 404);
  }

  return c.json(addresses, 200, {
    "Cache-Control": "public, max-age=604800",
  });
});

export default app;
