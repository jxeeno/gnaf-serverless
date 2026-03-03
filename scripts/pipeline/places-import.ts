import { DuckDBInstance } from "@duckdb/node-api";
import { PLACES_DUCKDB_PATH } from "./places-download.js";

/**
 * Denormalize Overture's nested structs into a flat places table.
 * Expects places_raw to already exist from the download step.
 */
export async function importPlaces(): Promise<void> {
  console.log(`Opening DuckDB at ${PLACES_DUCKDB_PATH}...`);
  const instance = await DuckDBInstance.create(PLACES_DUCKDB_PATH);
  const conn = await instance.connect();

  await conn.run("LOAD spatial");

  console.log("Denormalizing places_raw into flat places table...");
  const t0 = Date.now();

  await conn.run(`
    CREATE OR REPLACE TABLE places AS
    SELECT
      id,
      names.primary AS name,
      categories.primary AS category,
      COALESCE(categories.alternate, [])::VARCHAR[] AS alt_categories,
      confidence,
      ST_Y(geometry) AS latitude,
      ST_X(geometry) AS longitude,
      addresses[1].freeform AS address_freeform,
      addresses[1].locality AS locality,
      addresses[1].region AS region,
      addresses[1].postcode AS postcode,
      addresses[1].country AS country,
      phones[1] AS phone,
      websites[1] AS website,
      brand.names.primary AS brand_name
    FROM places_raw
    WHERE names.primary IS NOT NULL
  `);

  const result = await conn.run("SELECT count(*) AS cnt FROM places");
  const chunk = await result.fetchChunk();
  const count = Number(chunk!.getColumnVector(0).getItem(0));
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  Denormalized ${count.toLocaleString()} places (${elapsed}s)`);

  conn.disconnectSync();
  instance.closeSync();
}

// Allow running directly
if (import.meta.url === `file://${process.argv[1]}`) {
  importPlaces().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
