import { fetchAndDecompress } from "./r2.js";

export { isPrecomputedQuery, normalizeQuery } from "../shared/precomputed-queries.js";

/** Only warm street shards — these are used by search/autocomplete */
const SHARD_TYPES = ["streets"] as const;
const TOTAL_PREFIXES = 4096;
const SHARD_BATCH_SIZE = 128;

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

/** Store a pre-computed short query result in R2 (lazy cache on first miss) */
export async function storePrecomputedQuery(
  bucket: R2Bucket,
  version: string,
  normalizedQuery: string,
  result: { streets: unknown[]; addresses: unknown[] },
): Promise<void> {
  const r2Key = `gnaf/${version}/precomputed/${normalizedQuery}.json`;
  await bucket.put(r2Key, JSON.stringify(result), {
    httpMetadata: { contentType: "application/json" },
  });
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
