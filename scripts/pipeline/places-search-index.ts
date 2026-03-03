import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { DuckDBInstance } from "@duckdb/node-api";
import { SHARDS_DIR, SHARD_PREFIX_LENGTH } from "./config.js";
import { PLACES_DUCKDB_PATH } from "./places-download.js";
import { readAllRows } from "./shard.js";

const PLACES_SEARCH_INDEX_DIR = path.join(SHARDS_DIR, "places", "search-index");
const INSERT_BATCH_SIZE = 200;

export { PLACES_SEARCH_INDEX_DIR };

/** Escape a string for use in a SQL single-quoted literal */
function sqlEscape(val: string): string {
  return val.replace(/'/g, "''");
}

function md5hex(input: string): string {
  return createHash("md5").update(input).digest("hex");
}

/** Format elapsed time as "Xs" or "Xm Ys" */
function elapsed(startMs: number): string {
  const s = ((Date.now() - startMs) / 1000) | 0;
  return s >= 60 ? `${(s / 60) | 0}m ${s % 60}s` : `${s}s`;
}

interface PlaceEntry {
  overture_id: string;
  display: string;
  display_search: string;
  name: string;
  category: string;
  locality: string;
  state: string;
  postcode: string;
  latitude: number;
  longitude: number;
  shard_prefix: string;
  confidence: number;
}

export async function generatePlacesSearchIndex(): Promise<void> {
  const t0 = Date.now();
  console.log(`Opening DuckDB at ${PLACES_DUCKDB_PATH}...`);
  const instance = await DuckDBInstance.create(PLACES_DUCKDB_PATH);
  const conn = await instance.connect();

  await conn.run("SET memory_limit = '3GB'");
  await conn.run("SET temp_directory = '/tmp/duckdb_temp'");

  await fsp.mkdir(PLACES_SEARCH_INDEX_DIR, { recursive: true });

  console.log("Querying places for search index...");
  const result = await conn.run(`
    SELECT
      id,
      name,
      COALESCE(category, '') AS category,
      alt_categories,
      COALESCE(locality, '') AS locality,
      COALESCE(region, '') AS region,
      COALESCE(postcode, '') AS postcode,
      latitude,
      longitude,
      confidence
    FROM places
    ORDER BY confidence DESC, name
  `);

  const rows = await readAllRows(result);
  console.log(`  Read ${rows.length.toLocaleString()} places (${elapsed(t0)})`);

  // Build place entries
  const places: PlaceEntry[] = [];
  for (const row of rows) {
    const id = row.id as string;
    const name = row.name as string;
    const category = row.category as string;
    const rawAltCats = row.alt_categories;
    const altCats: string[] = Array.isArray(rawAltCats)
      ? rawAltCats
      : rawAltCats && typeof rawAltCats === "object" && "toArray" in (rawAltCats as object)
        ? Array.from((rawAltCats as Iterable<string>))
        : [];
    const locality = row.locality as string;
    const region = row.region as string;
    const postcode = row.postcode as string;
    const lat = row.latitude as number;
    const lng = row.longitude as number;
    const confidence = row.confidence as number;

    // Build display: "Name, Locality, State, Postcode"
    const displayParts = [name];
    if (locality) displayParts.push(locality);
    if (region) displayParts.push(region);
    if (postcode) displayParts.push(postcode);
    const display = displayParts.join(", ");

    // Build search text: name + category + alt categories + locality + state + postcode
    // Strip apostrophes so "McDonald's" → "McDonalds" matches searches
    const searchParts = [name, category, ...altCats, locality, region, postcode]
      .filter((s) => s.length > 0);
    const displaySearch = searchParts.join(" ").replace(/['']/g, "");

    places.push({
      overture_id: id,
      display,
      display_search: displaySearch,
      name,
      category,
      locality,
      state: region,
      postcode,
      latitude: lat,
      longitude: lng,
      shard_prefix: md5hex(id).substring(0, SHARD_PREFIX_LENGTH),
      confidence,
    });
  }

  console.log(`Built ${places.length.toLocaleString()} place entries (${elapsed(t0)})`);

  // Generate SQL
  console.log("Generating places search index SQL...");

  const sqlStatements: string[] = [];

  // Drop existing tables
  sqlStatements.push("DROP TABLE IF EXISTS places_fts;");
  sqlStatements.push("DROP TABLE IF EXISTS places;");

  // Create places table
  sqlStatements.push(`CREATE TABLE places (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  overture_id TEXT NOT NULL,
  display TEXT NOT NULL,
  display_search TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT,
  locality TEXT,
  state TEXT,
  postcode TEXT,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  shard_prefix TEXT NOT NULL,
  confidence REAL NOT NULL
);`);

  // Batch INSERT
  for (let i = 0; i < places.length; i += INSERT_BATCH_SIZE) {
    const batch = places.slice(i, i + INSERT_BATCH_SIZE);
    const values = batch
      .map(
        (p) =>
          `('${sqlEscape(p.overture_id)}','${sqlEscape(p.display)}','${sqlEscape(p.display_search)}','${sqlEscape(p.name)}',${p.category ? `'${sqlEscape(p.category)}'` : "NULL"},${p.locality ? `'${sqlEscape(p.locality)}'` : "NULL"},${p.state ? `'${sqlEscape(p.state)}'` : "NULL"},${p.postcode ? `'${sqlEscape(p.postcode)}'` : "NULL"},${p.latitude},${p.longitude},'${p.shard_prefix}',${p.confidence})`
      )
      .join(",\n");
    sqlStatements.push(
      `INSERT INTO places (overture_id,display,display_search,name,category,locality,state,postcode,latitude,longitude,shard_prefix,confidence) VALUES\n${values};`
    );
  }

  // Indexes
  sqlStatements.push(
    "CREATE INDEX idx_places_overture_id ON places(overture_id);"
  );

  // Create FTS5 virtual table
  sqlStatements.push(`CREATE VIRTUAL TABLE places_fts USING fts5(
  display_search,
  content='places',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);`);

  // Rebuild FTS5 index
  sqlStatements.push(
    "INSERT INTO places_fts(places_fts) VALUES('rebuild');"
  );

  // Write SQL file
  await fsp.rm(PLACES_SEARCH_INDEX_DIR, { recursive: true, force: true });
  await fsp.mkdir(PLACES_SEARCH_INDEX_DIR, { recursive: true });

  const content = sqlStatements.join("\n\n") + "\n";
  await fsp.writeFile(path.join(PLACES_SEARCH_INDEX_DIR, "001.sql"), content);
  const totalBytes = Buffer.byteLength(content);
  const totalMb = (totalBytes / 1024 / 1024).toFixed(1);

  console.log(
    `Places search index SQL written to ${PLACES_SEARCH_INDEX_DIR}/001.sql (${totalMb} MB, ${places.length.toLocaleString()} places)`
  );
  console.log(`Search index generation complete (${elapsed(t0)})`);

  conn.disconnectSync();
  instance.closeSync();
}

// Allow running directly
if (import.meta.url === `file://${process.argv[1]}`) {
  generatePlacesSearchIndex().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
