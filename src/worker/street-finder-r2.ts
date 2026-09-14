import { createIndexStreetFinder, type IndexLoader } from "../shared/street-index.js";
import type { IndexCacheStats, StreetFinder, StreetFinderResult } from "../shared/street-finder.js";
import { fetchObjectText } from "./r2.js";

/** Parsed index files kept in isolate memory between requests, keyed by R2 key */
const MEMORY_CACHE_LIMIT = 128;
const memoryCache = new Map<string, unknown>();

function rememberFile(r2Key: string, value: unknown): void {
  memoryCache.delete(r2Key);
  memoryCache.set(r2Key, value);
  if (memoryCache.size > MEMORY_CACHE_LIMIT) {
    const oldest = memoryCache.keys().next().value;
    if (oldest !== undefined) memoryCache.delete(oldest);
  }
}

/** Load a search index file: isolate memory, then Cache API, then R2 */
async function loadIndexFile(
  bucket: R2Bucket,
  r2Key: string,
  ctx: ExecutionContext,
  stats: IndexCacheStats
): Promise<unknown> {
  if (memoryCache.has(r2Key)) {
    const value = memoryCache.get(r2Key);
    rememberFile(r2Key, value);
    stats.memory++;
    return value;
  }

  const cacheKey = new Request(`https://r2-cache/${r2Key}`);
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  let json: string;
  if (cached) {
    json = await cached.text();
    stats.cacheApi++;
  } else {
    const text = await fetchObjectText(bucket, r2Key);
    if (text == null) return null;
    json = text;
    stats.r2++;
    const cacheResponse = new Response(json, {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=86400",
      },
    });
    ctx.waitUntil(cache.put(cacheKey, cacheResponse));
  }

  stats.bytes += json.length;
  const value = JSON.parse(json);
  rememberFile(r2Key, value);
  return value;
}

/** Street finder backed by the static search index in R2 (no D1) */
export function createR2StreetFinder(
  bucket: R2Bucket,
  version: string,
  ctx: ExecutionContext
): StreetFinder {
  const stats: IndexCacheStats = { memory: 0, cacheApi: 0, r2: 0, bytes: 0 };
  const loader: IndexLoader = {
    load: async <T>(path: string) =>
      (await loadIndexFile(bucket, `gnaf/${version}/${path}`, ctx, stats)) as T | null,
  };
  const finder = createIndexStreetFinder(loader);
  const withStats = async (result: Promise<StreetFinderResult>): Promise<StreetFinderResult> => ({
    ...(await result),
    indexCache: { ...stats },
  });

  return {
    ...finder,
    findByQuery: (parsed, streetLimit) => withStats(finder.findByQuery(parsed, streetLimit)),
    findByNumber: (num, streetLimit) => withStats(finder.findByNumber(num, streetLimit)),
  };
}
