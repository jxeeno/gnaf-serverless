import { fetchAndDecompress } from "./r2.js";
import { executeSearch } from "./search.js";
import { generateShortQueries } from "../shared/precomputed-queries.js";

export { isPrecomputedQuery, normalizeQuery } from "../shared/precomputed-queries.js";

/** Only warm street shards — these are used by search/autocomplete */
const SHARD_TYPES = ["streets"] as const;
const TOTAL_PREFIXES = 4096;
const SHARD_BATCH_SIZE = 128;
const QUERY_BATCH_SIZE = 20;
/** Max queries to process per cron invocation (avoids subrequest + CPU limits) */
const QUERIES_PER_RUN = 60;

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
 * Processes up to QUERIES_PER_RUN queries per invocation to stay within CPU limits.
 * Uses a progress file to resume across cron runs. Skips if sentinel exists.
 */
export async function warmShortQueries(
  db: D1Database,
  bucket: R2Bucket,
  version: string,
  ctx: ExecutionContext
): Promise<boolean> {
  // Check sentinel file — skip if already generated for this version
  const sentinelKey = `gnaf/${version}/precomputed/.done`;
  const existing = await bucket.head(sentinelKey);
  if (existing) return true;

  const queries = generateShortQueries();

  // Read progress file to resume from where we left off
  const progressKey = `gnaf/${version}/precomputed/.progress`;
  const progressObj = await bucket.get(progressKey);
  let startIndex = 0;
  if (progressObj) {
    startIndex = parseInt(await progressObj.text(), 10) || 0;
  }

  if (startIndex >= queries.length) {
    // All queries done — write sentinel and clean up progress file
    await bucket.put(sentinelKey, "", {
      httpMetadata: { contentType: "text/plain" },
    });
    await bucket.delete(progressKey);
    console.log(`Pre-computed all ${queries.length} short query results`);
    return true;
  }

  const endIndex = Math.min(startIndex + QUERIES_PER_RUN, queries.length);
  console.log(`Pre-computing queries ${startIndex}–${endIndex - 1} of ${queries.length}...`);

  // Process this chunk in batches
  for (let i = startIndex; i < endIndex; i += QUERY_BATCH_SIZE) {
    const batch = queries.slice(i, Math.min(i + QUERY_BATCH_SIZE, endIndex));
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
  }

  if (endIndex >= queries.length) {
    // Finished — write sentinel and clean up progress file
    await bucket.put(sentinelKey, "", {
      httpMetadata: { contentType: "text/plain" },
    });
    await bucket.delete(progressKey);
    console.log(`Pre-computed all ${queries.length} short query results`);
    return true;
  }

  // Save progress for next cron run
  await bucket.put(progressKey, String(endIndex), {
    httpMetadata: { contentType: "text/plain" },
  });
  console.log(`Progress saved at ${endIndex}/${queries.length}`);
  return false;
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
