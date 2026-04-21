import type { AddressShardData, LotDpShardData, StreetShardData } from "../shared/types.js";

export async function fetchAndDecompress(
  bucket: R2Bucket,
  key: string
): Promise<string> {
  const obj = await bucket.get(key);
  if (!obj) return "{}";

  const bytes = new Uint8Array(await obj.arrayBuffer());

  // Check gzip magic bytes (0x1f 0x8b) to determine if decompression is needed
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const ds = new DecompressionStream("gzip");
    const decompressedStream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Response(decompressedStream).text();
  }

  return new TextDecoder().decode(bytes);
}

/**
 * Fetch the latest GNAF version string from gnaf/latest.json in R2.
 * Cached for 1 hour.
 */
export async function fetchLatestVersion(
  bucket: R2Bucket,
  ctx: ExecutionContext
): Promise<string> {
  const cacheUrl = "https://r2-cache/gnaf/latest.json";
  const cacheKey = new Request(cacheUrl);
  const cache = caches.default;

  const cached = await cache.match(cacheKey);
  if (cached) {
    const data = await cached.json<{ version: string }>();
    return data.version;
  }

  const obj = await bucket.get("gnaf/latest.json");
  if (!obj) {
    throw new Error("Failed to fetch latest.json from R2");
  }

  const json = await obj.text();
  const data = JSON.parse(json) as { version: string };

  const cacheResponse = new Response(json, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600",
    },
  });
  ctx.waitUntil(cache.put(cacheKey, cacheResponse));

  return data.version;
}

/**
 * Fetch an address shard from R2, with Cloudflare Cache API caching.
 */
export async function fetchAddressShard(
  bucket: R2Bucket,
  version: string,
  prefix: string,
  ctx: ExecutionContext
): Promise<AddressShardData> {
  const r2Key = `gnaf/${version}/addresses/${prefix}.json.gz`;
  const cacheUrl = `https://r2-cache/${r2Key}`;
  const cacheKey = new Request(cacheUrl);
  const cache = caches.default;

  const cached = await cache.match(cacheKey);
  if (cached) {
    return cached.json();
  }

  const json = await fetchAndDecompress(bucket, r2Key);
  const data: AddressShardData = JSON.parse(json);

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
 * Fetch a lot/DP shard from R2, with Cloudflare Cache API caching.
 */
export async function fetchLotDpShard(
  bucket: R2Bucket,
  version: string,
  prefix: string,
  ctx: ExecutionContext
): Promise<LotDpShardData> {
  const r2Key = `gnaf/${version}/lotdp/${prefix}.json.gz`;
  const cacheUrl = `https://r2-cache/${r2Key}`;
  const cacheKey = new Request(cacheUrl);
  const cache = caches.default;

  const cached = await cache.match(cacheKey);
  if (cached) {
    return cached.json();
  }

  const json = await fetchAndDecompress(bucket, r2Key);
  const data: LotDpShardData = JSON.parse(json);

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
 * Fetch a street shard from R2, with Cloudflare Cache API caching.
 */
export async function fetchStreetShard(
  bucket: R2Bucket,
  version: string,
  prefix: string,
  ctx: ExecutionContext
): Promise<StreetShardData> {
  const r2Key = `gnaf/${version}/streets/${prefix}.json.gz`;
  const cacheUrl = `https://r2-cache/${r2Key}`;
  const cacheKey = new Request(cacheUrl);
  const cache = caches.default;

  const cached = await cache.match(cacheKey);
  if (cached) {
    return cached.json();
  }

  const json = await fetchAndDecompress(bucket, r2Key);
  const data: StreetShardData = JSON.parse(json);

  const cacheResponse = new Response(json, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=86400",
    },
  });
  ctx.waitUntil(cache.put(cacheKey, cacheResponse));

  return data;
}
