import { AwsClient } from "aws4fetch";
import type { AddressShardData, LotDpShardData } from "../shared/types.js";

export interface S3Config {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  gnafVersion: string;
}

function getS3Client(config: S3Config): AwsClient {
  return new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    region: config.region,
    service: "s3",
  });
}

function shardUrl(
  config: S3Config,
  type: "addresses" | "lotdp",
  prefix: string
): string {
  return `${config.endpoint}/${config.bucket}/gnaf/${config.gnafVersion}/${type}/${prefix}.json.gz`;
}

async function fetchAndDecompress(
  client: AwsClient,
  url: string
): Promise<string> {
  const res = await client.fetch(url);
  if (!res.ok) {
    if (res.status === 404) {
      return "{}";
    }
    throw new Error(`S3 fetch failed: ${res.status} ${res.statusText} for ${url}`);
  }

  const arrayBuf = await res.arrayBuffer();
  const bytes = new Uint8Array(arrayBuf);

  // Check gzip magic bytes (0x1f 0x8b) to determine if decompression is needed
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const ds = new DecompressionStream("gzip");
    const decompressedStream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Response(decompressedStream).text();
  }

  return new TextDecoder().decode(bytes);
}

/**
 * Fetch an address shard from S3, with Cloudflare Cache API caching.
 */
export async function fetchAddressShard(
  config: S3Config,
  prefix: string,
  ctx: ExecutionContext
): Promise<AddressShardData> {
  const url = shardUrl(config, "addresses", prefix);
  const cacheKey = new Request(url);
  const cache = caches.default;

  // Check cache first
  const cached = await cache.match(cacheKey);
  if (cached) {
    return cached.json();
  }

  const client = getS3Client(config);
  const json = await fetchAndDecompress(client, url);
  const data: AddressShardData = JSON.parse(json);

  // Cache the decompressed result
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
 * Fetch a lot/DP shard from S3, with Cloudflare Cache API caching.
 */
export async function fetchLotDpShard(
  config: S3Config,
  prefix: string,
  ctx: ExecutionContext
): Promise<LotDpShardData> {
  const url = shardUrl(config, "lotdp", prefix);
  const cacheKey = new Request(url);
  const cache = caches.default;

  const cached = await cache.match(cacheKey);
  if (cached) {
    return cached.json();
  }

  const client = getS3Client(config);
  const json = await fetchAndDecompress(client, url);
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
