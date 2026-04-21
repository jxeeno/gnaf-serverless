import { fetchAndDecompress } from "./r2.js";
import { executeSearch } from "./search.js";

const SHARD_TYPES = ["streets", "addresses", "lotdp"] as const;
const TOTAL_PREFIXES = 4096;
const SHARD_BATCH_SIZE = 128;
const QUERY_BATCH_SIZE = 20;

/**
 * Generate all pre-computable short queries:
 * - 2-char: all [a-z0-9] x [a-z0-9] = 1,296
 * - 3-char: [0-9]{2}[a-z] only = 2,600 (e.g., "10k", "25s" — street number + first letter)
 * Total: 3,896
 */
function generateShortQueries(): string[] {
  const alphanumeric = "abcdefghijklmnopqrstuvwxyz0123456789";
  const alpha = "abcdefghijklmnopqrstuvwxyz";
  const digits = "0123456789";
  const queries: string[] = [];

  // All 2-char alphanumeric combinations
  for (const a of alphanumeric) {
    for (const b of alphanumeric) {
      queries.push(a + b);
    }
  }

  // 3-char: two digits followed by one letter
  for (const d1 of digits) {
    for (const d2 of digits) {
      for (const c of alpha) {
        queries.push(d1 + d2 + c);
      }
    }
  }

  return queries;
}

/** Check if a normalized query has a pre-computed result */
export function isPrecomputedQuery(normalized: string): boolean {
  if (normalized.length === 2) return true;
  if (normalized.length === 3 && /^[0-9]{2}[a-z]$/.test(normalized)) return true;
  return false;
}

/** Normalize a query string: trim, strip non-alphanumeric, lowercase */
export function normalizeQuery(q: string): string {
  return q.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

/** Load a single pre-computed short query result from R2 (with Cache API caching) */
export async function loadPrecomputedQuery(
  bucket: R2Bucket,
  version: string,
  normalizedQuery: string,
  ctx: ExecutionContext
): Promise<{ streets: any[]; addresses: any[] } | null> {
  const r2Key = `gnaf/${version}/precomputed/${normalizedQuery}.json`;
  const cacheUrl = `https://r2-cache/${r2Key}`;
  const cacheKey = new Request(cacheUrl);
  const cache = caches.default;

  const cached = await cache.match(cacheKey);
  if (cached) return cached.json();

  const obj = await bucket.get(r2Key);
  if (!obj) return null;

  const json = await obj.text();
  const data = JSON.parse(json);

  const cacheResponse = new Response(json, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=86400",
    },
  });
  ctx.waitUntil(cache.put(cacheKey, cacheResponse));

  return data;
}

/**
 * Pre-compute short query results and store individually in R2.
 * Skips if already generated for this version (sentinel file exists).
 */
export async function warmShortQueries(
  db: D1Database,
  bucket: R2Bucket,
  version: string,
  ctx: ExecutionContext
): Promise<void> {
  // Check sentinel file — skip if already generated for this version
  const sentinelKey = `gnaf/${version}/precomputed/.done`;
  const existing = await bucket.head(sentinelKey);
  if (existing) return;

  console.log("Generating pre-computed short query results...");
  const queries = generateShortQueries();
  let generated = 0;

  // Process in batches to avoid overwhelming D1
  for (let i = 0; i < queries.length; i += QUERY_BATCH_SIZE) {
    const batch = queries.slice(i, i + QUERY_BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async (q) => {
        const result = await executeSearch(q, 50, db, bucket, version, ctx);
        return { q, body: result?.body ?? { streets: [], addresses: [] } };
      })
    );

    // Upload each result to R2
    await Promise.all(
      batchResults.map(({ q, body }) =>
        bucket.put(
          `gnaf/${version}/precomputed/${q}.json`,
          JSON.stringify(body),
          { httpMetadata: { contentType: "application/json" } }
        )
      )
    );

    generated += batch.length;
  }

  // Write sentinel file to mark completion
  await bucket.put(sentinelKey, "", {
    httpMetadata: { contentType: "text/plain" },
  });

  console.log(`Pre-computed ${generated} short query results`);
}

/**
 * Warm R2 shard caches for all shard types and prefixes.
 * Checks Cache API first — only fetches from R2 on miss.
 */
export async function warmShards(
  bucket: R2Bucket,
  version: string,
): Promise<void> {
  const cache = caches.default;

  for (const type of SHARD_TYPES) {
    for (let i = 0; i < TOTAL_PREFIXES; i += SHARD_BATCH_SIZE) {
      const batch: Promise<void>[] = [];

      for (let j = i; j < Math.min(i + SHARD_BATCH_SIZE, TOTAL_PREFIXES); j++) {
        const prefix = j.toString(16).padStart(3, "0");
        const r2Key = `gnaf/${version}/${type}/${prefix}.json.gz`;
        const cacheUrl = `https://r2-cache/${r2Key}`;
        const cacheKeyReq = new Request(cacheUrl);

        batch.push(
          (async () => {
            // Skip if already in Cache API
            const cached = await cache.match(cacheKeyReq);
            if (cached) return;

            // Fetch from R2, decompress, and store in Cache API
            const json = await fetchAndDecompress(bucket, r2Key);
            const cacheResponse = new Response(json, {
              headers: {
                "Content-Type": "application/json",
                "Cache-Control": "public, max-age=86400",
              },
            });
            await cache.put(cacheKeyReq, cacheResponse);
          })()
        );
      }

      await Promise.all(batch);
    }
  }
}
