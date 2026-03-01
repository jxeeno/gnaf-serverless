import { createHash } from "node:crypto";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { formatAddressResponse } from "../shared/address-format.js";
import {
  fetchAddressShard,
  fetchLotDpShard,
  type S3Config,
} from "./s3.js";

type Bindings = {
  S3_ENDPOINT: string;
  S3_BUCKET: string;
  S3_ACCESS_KEY_ID: string;
  S3_SECRET_ACCESS_KEY: string;
  S3_REGION: string;
  GNAF_VERSION: string;
  SHARD_PREFIX_LENGTH: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.use("/api/*", cors());

function md5hex(input: string): string {
  return createHash("md5").update(input).digest("hex");
}

function getS3Config(env: Bindings): S3Config {
  return {
    endpoint: env.S3_ENDPOINT,
    bucket: env.S3_BUCKET,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    region: env.S3_REGION ?? "auto",
    gnafVersion: env.GNAF_VERSION,
  };
}

function getShardPrefixLength(env: Bindings): number {
  return parseInt(env.SHARD_PREFIX_LENGTH ?? "3", 10);
}

// Health check
app.get("/api/health", (c) => c.json({ status: "ok" }));

// Get address by GNAF PID
app.get("/api/addresses/:pid", async (c) => {
  const pid = c.req.param("pid").toUpperCase();
  const config = getS3Config(c.env);
  const prefixLen = getShardPrefixLength(c.env);
  const shardPrefix = md5hex(pid).substring(0, prefixLen);

  const shardData = await fetchAddressShard(config, shardPrefix, c.executionCtx);
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

  const config = getS3Config(c.env);
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

export default app;
