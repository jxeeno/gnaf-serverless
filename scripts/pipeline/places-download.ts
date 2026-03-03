import path from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { DATA_DIR } from "./config.js";

export const PLACES_DUCKDB_PATH = path.join(DATA_DIR, "places.duckdb");

const STAC_CATALOG_URL = "https://stac.overturemaps.org";

/**
 * Resolve the Overture release version to use.
 * Uses OVERTURE_RELEASE env var if set, otherwise fetches the latest from STAC catalog.
 */
async function resolveOvertureRelease(): Promise<string> {
  const envRelease = process.env.OVERTURE_RELEASE;
  if (envRelease) {
    console.log(`Using manually specified Overture release: ${envRelease}`);
    return envRelease;
  }

  console.log("Discovering latest Overture release from STAC catalog...");
  const res = await fetch(STAC_CATALOG_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch STAC catalog: ${res.status} ${res.statusText}`);
  }
  const catalog = await res.json() as { latest?: string };
  if (!catalog.latest) {
    throw new Error("STAC catalog did not contain a 'latest' field");
  }
  console.log(`Discovered latest release: ${catalog.latest}`);
  return catalog.latest;
}

/**
 * Download Australian places from Overture Maps GeoParquet on S3 via DuckDB.
 * Uses httpfs + spatial extensions to query directly from the Overture S3 bucket.
 */
export async function downloadPlaces(): Promise<void> {
  const release = await resolveOvertureRelease();

  console.log(`Opening DuckDB at ${PLACES_DUCKDB_PATH}...`);
  const instance = await DuckDBInstance.create(PLACES_DUCKDB_PATH);
  const conn = await instance.connect();

  const run = async (sql: string) => {
    await conn.run(sql);
  };

  console.log("Loading DuckDB extensions (httpfs, spatial)...");
  await run("INSTALL httpfs");
  await run("INSTALL spatial");
  await run("LOAD httpfs");
  await run("LOAD spatial");

  // Configure S3 access (Overture bucket is public, no credentials needed)
  await run("SET s3_region = 'us-west-2'");

  console.log(`Querying Overture Places (release ${release}) for AU...`);
  console.log("This may take several minutes on first run...");

  const t0 = Date.now();
  await run(`
    CREATE OR REPLACE TABLE places_raw AS
    SELECT *
    FROM read_parquet(
      's3://overturemaps-us-west-2/release/${release}/theme=places/type=place/*',
      hive_partitioning = true
    )
    WHERE addresses[1].country = 'AU'
      AND confidence > 0.4
  `);

  const result = await conn.run("SELECT count(*) AS cnt FROM places_raw");
  const chunk = await result.fetchChunk();
  const count = Number(chunk!.getColumnVector(0).getItem(0));
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  Downloaded ${count.toLocaleString()} Australian places (${elapsed}s)`);

  conn.disconnectSync();
  instance.closeSync();
}

// Allow running directly
if (import.meta.url === `file://${process.argv[1]}`) {
  downloadPlaces().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
