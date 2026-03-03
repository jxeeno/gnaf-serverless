import fsp from "node:fs/promises";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import type { PlaceShardRecord, PlaceShardMetadata } from "../../src/shared/types.js";
import { SHARDS_DIR, SHARD_PREFIX_LENGTH } from "./config.js";
import { PLACES_DUCKDB_PATH } from "./places-download.js";
import { readAllRows } from "./shard.js";

const PLACES_SHARDS_DIR = path.join(SHARDS_DIR, "places", "records");

export { PLACES_SHARDS_DIR };

/** Convert a nullable value to undefined (for JSON omission) */
function n<T>(val: T | null | undefined): T | undefined {
  if (val === null || val === undefined || val === "") return undefined;
  return val;
}

/** Format elapsed time as "Xs" or "Xm Ys" */
function elapsed(startMs: number): string {
  const s = ((Date.now() - startMs) / 1000) | 0;
  return s >= 60 ? `${(s / 60) | 0}m ${s % 60}s` : `${s}s`;
}

export async function shardPlaces(): Promise<void> {
  const t0 = Date.now();
  console.log(`Opening DuckDB at ${PLACES_DUCKDB_PATH}...`);
  const instance = await DuckDBInstance.create(PLACES_DUCKDB_PATH);
  const conn = await instance.connect();

  await conn.run("SET memory_limit = '3GB'");
  await conn.run("SET temp_directory = '/tmp/duckdb_temp'");

  await fsp.mkdir(PLACES_SHARDS_DIR, { recursive: true });

  // Count total places
  console.log("Counting places...");
  const countResult = await conn.run("SELECT count(*) AS cnt FROM places");
  const countChunk = await countResult.fetchChunk();
  const totalPlaces = Number(countChunk!.getColumnVector(0).getItem(0));
  console.log(`Total places: ${totalPlaces.toLocaleString()}`);

  // Add shard prefix column
  console.log("Computing shard prefixes...");
  await conn.run("ALTER TABLE places ADD COLUMN IF NOT EXISTS _shard VARCHAR");
  await conn.run(
    `UPDATE places SET _shard = LEFT(md5(id), ${SHARD_PREFIX_LENGTH})`
  );
  console.log(`  Shard prefixes computed (${elapsed(t0)})`);

  // Get distinct shard prefixes
  const prefixResult = await conn.run(
    "SELECT DISTINCT _shard FROM places ORDER BY _shard"
  );
  const prefixRows = await readAllRows(prefixResult);
  const prefixes = prefixRows.map((r) => r._shard as string);
  console.log(`Writing place shards (${prefixes.length} non-empty prefixes)...`);

  let shardsWritten = 0;
  let totalProcessed = 0;

  for (const prefix of prefixes) {
    const result = await conn.run(
      `SELECT id, name, category, alt_categories, confidence, latitude, longitude,
              address_freeform, locality, region, postcode, country, phone, website, brand_name
       FROM places WHERE _shard = '${prefix}'`
    );

    const col = new Map<string, number>();
    const names = result.columnNames();
    for (let i = 0; i < names.length; i++) {
      col.set(names[i].toLowerCase(), i);
    }

    const obj: Record<string, PlaceShardRecord> = {};
    let rowCount = 0;

    while (true) {
      const chunk = await result.fetchChunk();
      if (!chunk || chunk.rowCount === 0) break;

      const g = (name: string, row: number) =>
        chunk.getColumnVector(col.get(name)!).getItem(row);

      for (let i = 0; i < chunk.rowCount; i++) {
        const id = g("id", i) as string;

        const rec: PlaceShardRecord = {
          nm: g("name", i) as string,
          cat: (g("category", i) as string) ?? "",
          lat: g("latitude", i) as number,
          lng: g("longitude", i) as number,
          con: g("confidence", i) as number,
        };

        const rawAltCats = g("alt_categories", i);
        const altCats: string[] = Array.isArray(rawAltCats)
          ? rawAltCats
          : rawAltCats && typeof rawAltCats === "object"
            ? Array.from(rawAltCats as unknown as Iterable<string>)
            : [];
        if (altCats.length > 0) rec.cats = altCats;
        if (n(g("address_freeform", i))) rec.addr = g("address_freeform", i) as string;
        if (n(g("locality", i))) rec.loc = g("locality", i) as string;
        if (n(g("region", i))) rec.reg = g("region", i) as string;
        if (n(g("postcode", i))) rec.pc = g("postcode", i) as string;
        if (n(g("country", i))) rec.ctr = g("country", i) as string;
        if (n(g("phone", i))) rec.ph = g("phone", i) as string;
        if (n(g("website", i))) rec.web = g("website", i) as string;
        if (n(g("brand_name", i))) rec.br = g("brand_name", i) as string;

        obj[id] = rec;
        rowCount++;
      }
    }

    if (rowCount === 0) continue;

    const compressed = gzipSync(Buffer.from(JSON.stringify(obj)));
    await fsp.writeFile(
      path.join(PLACES_SHARDS_DIR, `${prefix}.json.gz`),
      compressed
    );
    shardsWritten++;
    totalProcessed += rowCount;

    if (shardsWritten % 10 === 0) {
      console.log(
        `  ${shardsWritten}/${prefixes.length} place shards (${totalProcessed.toLocaleString()} rows, ${elapsed(t0)})...`
      );
    }
  }

  console.log(
    `  ${shardsWritten} place shards written (${totalProcessed.toLocaleString()} rows total, ${elapsed(t0)})`
  );

  // Write metadata
  const now = new Date();
  const version = `v${now.toISOString().slice(0, 10).replace(/-/g, "")}`;
  const metadata: PlaceShardMetadata = {
    version,
    date: now.toISOString(),
    shardPrefixLength: SHARD_PREFIX_LENGTH,
    totalPlaces,
    totalShards: shardsWritten,
  };

  const placesMetaDir = path.join(SHARDS_DIR, "places");
  await fsp.writeFile(
    path.join(placesMetaDir, "metadata.json"),
    JSON.stringify(metadata, null, 2)
  );
  console.log(`Metadata written: ${JSON.stringify(metadata)}`);
  console.log(`Place shard generation complete (${elapsed(t0)})`);

  conn.disconnectSync();
  instance.closeSync();
}

// Allow running directly
if (import.meta.url === `file://${process.argv[1]}`) {
  shardPlaces().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
