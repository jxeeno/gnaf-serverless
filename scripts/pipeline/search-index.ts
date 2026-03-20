import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { DuckDBInstance } from "@duckdb/node-api";
import {
  DUCKDB_PATH,
  SEARCH_INDEX_DIR,
  SHARDS_DIR,
  SHARD_PREFIX_LENGTH,
} from "./config.js";
import { readAllRows } from "./shard.js";
import type { StreetAddressEntry } from "../../src/shared/types.js";

const STREET_SHARDS_DIR = path.join(SHARDS_DIR, "streets");

/** Threshold: streets with more than this many addresses get digit sub-sharding */
const DIGIT_SHARD_THRESHOLD = 100;

/** Escape a string for use in a SQL single-quoted literal */
function sqlEscape(val: string): string {
  return val.replace(/'/g, "''");
}

function md5hex(input: string): string {
  return createHash("md5").update(input).digest("hex");
}

/** Build a display string from street+locality components */
function buildDisplay(row: {
  street_name: string;
  street_type: string;
  street_suffix: string;
  locality_name: string;
  state: string;
  postcode: string;
}): string {
  const parts = [row.street_name];
  if (row.street_type) parts[0] += ` ${row.street_type}`;
  if (row.street_suffix) parts[0] += ` ${row.street_suffix}`;
  parts.push(row.locality_name);
  parts.push(row.state);
  if (row.postcode) parts.push(row.postcode);
  return parts.join(", ");
}

/** Build a display_search string using full-form street types for better FTS prefix matching */
function buildDisplaySearch(row: {
  street_name: string;
  street_type_full: string;
  street_suffix: string;
  locality_name: string;
  state: string;
  postcode: string;
}): string {
  const parts = [row.street_name];
  if (row.street_type_full) parts[0] += ` ${row.street_type_full}`;
  if (row.street_suffix) parts[0] += ` ${row.street_suffix}`;
  parts.push(row.locality_name);
  parts.push(row.state);
  if (row.postcode) parts.push(row.postcode);
  return parts.join(", ").replace(/'/g, "");
}

/** Build a street key from components (same format used for S3 shard lookup) */
function buildStreetKey(
  streetName: string,
  streetType: string,
  streetSuffix: string,
  localityName: string,
  state: string,
  postcode: string
): string {
  return `${streetName}|${streetType}|${streetSuffix}|${localityName}|${state}|${postcode}`;
}

/** Format elapsed time as "Xs" or "Xm Ys" */
function elapsed(startMs: number): string {
  const s = ((Date.now() - startMs) / 1000) | 0;
  return s >= 60 ? `${(s / 60) | 0}m ${s % 60}s` : `${s}s`;
}

const INSERT_BATCH_SIZE = 200;

interface StreetEntry {
  id: number;
  display: string;
  display_search: string;
  street_key: string;
  shard_prefix: string;
  street_name: string;
  street_type: string;
  street_suffix: string;
  locality_name: string;
  state: string;
  postcode: string;
  address_count: number;
  digit_shards: string | null; // JSON object or null
  num_min: number | null;
  num_max: number | null;
  flat_min: number | null;
  flat_max: number | null;
}

/**
 * SQL expression that replicates buildAddressPrefix() from address-format.ts.
 *
 * Computes the display prefix (everything before street name) from address components.
 * Uses a CTE with intermediate line computations, then joins non-empty lines with ", ".
 *
 * Note: the 3-line merge rule in buildAddressPrefix (when exactly 3 prefix lines exist,
 * merge first two) is a no-op when joining with ", " — the result is identical.
 */
const DISPLAY_PREFIX_SQL = `
WITH base AS (
  SELECT
    gnaf_pid,
    _street_key,
    _street_shard,
    CAST(number_first AS INTEGER) AS number_first,
    CAST(number_last AS INTEGER) AS number_last,
    CAST(flat_number AS INTEGER) AS flat_number,
    CAST(level_number AS INTEGER) AS level_number,
    CASE WHEN level_type_code IS NOT NULL OR level_number IS NOT NULL
      THEN TRIM(
        COALESCE(level_type_name, '') || ' ' ||
        COALESCE(level_number_prefix, '') ||
        COALESCE(CAST(level_number AS VARCHAR), '') ||
        COALESCE(level_number_suffix, '')
      )
      ELSE '' END AS _level_line,
    CASE WHEN flat_type_code IS NOT NULL OR flat_number IS NOT NULL
      THEN TRIM(
        COALESCE(flat_type_name, '') || ' ' ||
        COALESCE(flat_number_prefix, '') ||
        COALESCE(CAST(flat_number AS VARCHAR), '') ||
        COALESCE(flat_number_suffix, '')
      )
      ELSE '' END AS _flat_line,
    COALESCE(building_name, '') AS _bn_line,
    CASE
      WHEN number_first IS NOT NULL THEN
        COALESCE(number_first_prefix, '') ||
        CAST(number_first AS VARCHAR) ||
        COALESCE(number_first_suffix, '') ||
        CASE WHEN number_last IS NOT NULL
          THEN '-' || COALESCE(number_last_prefix, '') ||
               CAST(number_last AS VARCHAR) ||
               COALESCE(number_last_suffix, '')
          ELSE '' END
      WHEN lot_number IS NOT NULL THEN
        'LOT ' || COALESCE(lot_number_prefix, '') ||
        lot_number ||
        COALESCE(lot_number_suffix, '')
      ELSE '' END AS _street_num
  FROM addresses
  WHERE alias_principal = 'P'
)
SELECT
  gnaf_pid,
  _street_key,
  _street_shard,
  number_first,
  number_last,
  flat_number,
  level_number,
  array_to_string(list_filter(
    [_level_line, _flat_line, _bn_line, _street_num],
    x -> x != ''
  ), ', ') AS display_prefix
FROM base`;

export async function generateSearchIndex(): Promise<void> {
  const t0 = Date.now();
  console.log(`Opening DuckDB at ${DUCKDB_PATH}...`);
  const instance = await DuckDBInstance.create(DUCKDB_PATH);
  const conn = await instance.connect();

  await conn.run("SET memory_limit = '3GB'");
  await conn.run("SET temp_directory = '/tmp/duckdb_temp'");

  await fsp.mkdir(SHARDS_DIR, { recursive: true });
  await fsp.mkdir(STREET_SHARDS_DIR, { recursive: true });

  // --- Part 1: Build street entries ---

  console.log("Querying unique street+locality combinations...");
  const streetResult = await conn.run(`
    SELECT
      street_name,
      COALESCE(street_type_abbrev, '') AS street_type,
      COALESCE(street_type_code, '') AS street_type_full,
      COALESCE(street_suffix_code, '') AS street_suffix,
      locality_name,
      state,
      COALESCE(postcode, '') AS postcode,
      COUNT(*) AS address_count,
      MIN(CAST(number_first AS INTEGER)) AS num_min,
      MAX(GREATEST(CAST(number_first AS INTEGER), CAST(number_last AS INTEGER))) AS num_max,
      MIN(LEAST(CAST(flat_number AS INTEGER), CAST(level_number AS INTEGER))) AS flat_min,
      MAX(GREATEST(CAST(flat_number AS INTEGER), CAST(level_number AS INTEGER))) AS flat_max
    FROM addresses
    WHERE alias_principal = 'P'
    GROUP BY street_name, street_type_abbrev, street_suffix_code, locality_name, state, postcode
    ORDER BY state, locality_name, street_name
  `);
  const streetRows = await readAllRows(streetResult);
  console.log(`  Found ${streetRows.length} unique street+locality combinations (${elapsed(t0)})`);

  // Build street entries (without digit_shards yet — computed during shard generation)
  const streets: StreetEntry[] = [];
  const streetKeyToId = new Map<string, number>();

  for (let i = 0; i < streetRows.length; i++) {
    const row = streetRows[i];
    const sName = row.street_name as string;
    const sType = row.street_type as string;
    const sTypeFull = row.street_type_full as string;
    const sSuffix = row.street_suffix as string;
    const locName = row.locality_name as string;
    const st = row.state as string;
    const pc = row.postcode as string;
    const streetKey = buildStreetKey(sName, sType, sSuffix, locName, st, pc);
    const id = i + 1;

    streets.push({
      id,
      display: buildDisplay({
        street_name: sName,
        street_type: sType,
        street_suffix: sSuffix,
        locality_name: locName,
        state: st,
        postcode: pc,
      }),
      display_search: buildDisplaySearch({
        street_name: sName,
        street_type_full: sTypeFull,
        street_suffix: sSuffix,
        locality_name: locName,
        state: st,
        postcode: pc,
      }),
      street_key: streetKey,
      shard_prefix: md5hex(streetKey).substring(0, SHARD_PREFIX_LENGTH),
      street_name: sName,
      street_type: sType,
      street_suffix: sSuffix,
      locality_name: locName,
      state: st,
      postcode: pc,
      address_count: Number(row.address_count),
      digit_shards: null,
      num_min: row.num_min != null ? Number(row.num_min) : null,
      num_max: row.num_max != null ? Number(row.num_max) : null,
      flat_min: row.flat_min != null ? Number(row.flat_min) : null,
      flat_max: row.flat_max != null ? Number(row.flat_max) : null,
    });

    streetKeyToId.set(streetKey, id);
  }

  // --- Part 2: Generate street S3 shards ---
  // Compute display_prefix in DuckDB SQL, then stream results in a single query

  console.log("Computing street shard prefixes...");
  await conn.run(
    `ALTER TABLE addresses ADD COLUMN IF NOT EXISTS _street_key VARCHAR`
  );
  await conn.run(
    `UPDATE addresses SET _street_key = street_name || '|' || COALESCE(street_type_abbrev, '') || '|' || COALESCE(street_suffix_code, '') || '|' || locality_name || '|' || state || '|' || COALESCE(postcode, '')`
  );

  await conn.run(
    `ALTER TABLE addresses ADD COLUMN IF NOT EXISTS _street_shard VARCHAR`
  );
  await conn.run(
    `UPDATE addresses SET _street_shard = LEFT(md5(_street_key), ${SHARD_PREFIX_LENGTH})`
  );
  console.log(`  Street shard prefixes computed (${elapsed(t0)})`);

  // Create pre-computed table with display_prefix computed in SQL
  // This replaces: toShardRecord() + buildAddressPrefix() per row
  console.log("Creating pre-computed street entries table...");
  await conn.run(`CREATE TABLE _street_entries AS ${DISPLAY_PREFIX_SQL}`);
  console.log(`  Pre-computed table created (${elapsed(t0)})`);

  // Stream all entries in a single ordered query
  console.log("Streaming street address entries...");
  const entryResult = await conn.run(`
    SELECT gnaf_pid, _street_key, display_prefix, number_first, number_last, flat_number, level_number
    FROM _street_entries
    ORDER BY _street_key
  `);

  // Collect entries grouped by street_key
  const byStreetKey = new Map<string, StreetAddressEntry[]>();
  let totalStreetAddresses = 0;

  while (true) {
    const chunk = await entryResult.fetchChunk();
    if (!chunk || chunk.rowCount === 0) break;

    const pidCol = chunk.getColumnVector(0);
    const skCol = chunk.getColumnVector(1);
    const dpCol = chunk.getColumnVector(2);
    const nfCol = chunk.getColumnVector(3);
    const nlCol = chunk.getColumnVector(4);
    const fnCol = chunk.getColumnVector(5);
    const lnCol = chunk.getColumnVector(6);

    for (let i = 0; i < chunk.rowCount; i++) {
      const streetKey = skCol.getItem(i) as string;
      const entry: StreetAddressEntry = {
        p: pidCol.getItem(i) as string,
        d: (dpCol.getItem(i) as string) ?? "",
      };
      const nf = nfCol.getItem(i) as number | null;
      const nl = nlCol.getItem(i) as number | null;
      const fn = fnCol.getItem(i) as number | null;
      const ln = lnCol.getItem(i) as number | null;
      if (nf != null) entry.n = nf;
      if (nl != null) entry.n2 = nl;
      if (fn != null) entry.f = fn;
      if (ln != null) entry.l = ln;

      let arr = byStreetKey.get(streetKey);
      if (!arr) {
        arr = [];
        byStreetKey.set(streetKey, arr);
      }
      arr.push(entry);
      totalStreetAddresses++;
    }

    if (totalStreetAddresses % 100_000 < 2048) {
      process.stdout.write(
        `\r  ${totalStreetAddresses.toLocaleString()} addresses streamed (${elapsed(t0)})...`
      );
    }
  }
  console.log(
    `\n  ${totalStreetAddresses.toLocaleString()} addresses streamed into ${byStreetKey.size} street groups (${elapsed(t0)})`
  );

  // Drop temporary table
  await conn.run("DROP TABLE IF EXISTS _street_entries");

  // Process: sub-shard large streets, group by file prefix
  console.log("Processing street groups and writing shard files...");
  const allShardData = new Map<string, StreetAddressEntry[]>();
  let subShardedStreets = 0;

  for (const [streetKey, entries] of byStreetKey) {
    if (entries.length > DIGIT_SHARD_THRESHOLD) {
      subShardedStreets++;
      const digitBuckets = new Map<string, StreetAddressEntry[]>();
      const unnumbered: StreetAddressEntry[] = [];

      for (const entry of entries) {
        if (entry.n != null) {
          const digit = String(entry.n).charAt(0);
          if (!digitBuckets.has(digit)) digitBuckets.set(digit, []);
          digitBuckets.get(digit)!.push(entry);
        } else {
          unnumbered.push(entry);
        }
      }

      // Store un-numbered under base key
      if (unnumbered.length > 0) {
        allShardData.set(streetKey, unnumbered);
      }

      // Store digit buckets under street_key|digit
      const digitMap: Record<string, string> = {};
      for (const [digit, digitEntries] of digitBuckets) {
        const subKey = `${streetKey}|${digit}`;
        allShardData.set(subKey, digitEntries);
        digitMap[digit] = md5hex(subKey).substring(0, SHARD_PREFIX_LENGTH);
      }

      // Update the street entry with digit_shards info
      const streetId = streetKeyToId.get(streetKey);
      if (streetId != null) {
        const streetEntry = streets[streetId - 1];
        streetEntry.digit_shards = JSON.stringify(digitMap);
      }
    } else {
      allShardData.set(streetKey, entries);
    }
  }

  console.log(
    `  ${allShardData.size} shard keys (${subShardedStreets} streets sub-sharded, ${totalStreetAddresses} addresses total) (${elapsed(t0)})`
  );

  // Write shard files: group shard entries by their hash prefix
  console.log("Writing street shard files...");
  const byShardFile = new Map<string, Record<string, StreetAddressEntry[]>>();

  for (const [shardKey, entries] of allShardData) {
    const filePrefix = md5hex(shardKey).substring(0, SHARD_PREFIX_LENGTH);
    if (!byShardFile.has(filePrefix)) byShardFile.set(filePrefix, {});
    byShardFile.get(filePrefix)![shardKey] = entries;
  }

  let shardFilesWritten = 0;
  for (const [filePrefix, data] of byShardFile) {
    const compressed = gzipSync(Buffer.from(JSON.stringify(data)));
    await fsp.writeFile(
      path.join(STREET_SHARDS_DIR, `${filePrefix}.json.gz`),
      compressed
    );
    shardFilesWritten++;
    if (shardFilesWritten % 100 === 0) {
      console.log(
        `  ${shardFilesWritten}/${byShardFile.size} shard files (${elapsed(t0)})...`
      );
    }
  }
  console.log(`  ${shardFilesWritten} street shard files written (${elapsed(t0)})`);

  // --- Part 3: Generate D1 SQL (chunked into multiple files) ---

  console.log("Generating search index SQL...");

  // Collect all SQL statements
  const sqlStatements: string[] = [];

  // Drop existing tables (for rebuilds)
  sqlStatements.push("DROP TABLE IF EXISTS streets_fts;");
  sqlStatements.push("DROP TABLE IF EXISTS street_pids;"); // clean up old table if present
  sqlStatements.push("DROP TABLE IF EXISTS streets;");

  // Create streets table
  sqlStatements.push(`CREATE TABLE streets (
  id INTEGER PRIMARY KEY,
  display TEXT NOT NULL,
  display_search TEXT NOT NULL,
  street_key TEXT NOT NULL,
  shard_prefix TEXT NOT NULL,
  street_name TEXT NOT NULL,
  street_type TEXT,
  street_suffix TEXT,
  locality_name TEXT NOT NULL,
  state TEXT NOT NULL,
  postcode TEXT,
  address_count INTEGER NOT NULL,
  digit_shards TEXT,
  num_min INTEGER,
  num_max INTEGER,
  flat_min INTEGER,
  flat_max INTEGER
);`);

  // Batch INSERT for streets
  for (let i = 0; i < streets.length; i += INSERT_BATCH_SIZE) {
    const batch = streets.slice(i, i + INSERT_BATCH_SIZE);
    const values = batch
      .map(
        (s) =>
          `(${s.id},'${sqlEscape(s.display)}','${sqlEscape(s.display_search)}','${sqlEscape(s.street_key)}','${sqlEscape(s.shard_prefix)}','${sqlEscape(s.street_name)}',${s.street_type ? `'${sqlEscape(s.street_type)}'` : "NULL"},${s.street_suffix ? `'${sqlEscape(s.street_suffix)}'` : "NULL"},'${sqlEscape(s.locality_name)}','${sqlEscape(s.state)}',${s.postcode ? `'${sqlEscape(s.postcode)}'` : "NULL"},${s.address_count},${s.digit_shards ? `'${sqlEscape(s.digit_shards)}'` : "NULL"},${s.num_min ?? "NULL"},${s.num_max ?? "NULL"},${s.flat_min ?? "NULL"},${s.flat_max ?? "NULL"})`
      )
      .join(",\n");
    sqlStatements.push(
      `INSERT INTO streets (id,display,display_search,street_key,shard_prefix,street_name,street_type,street_suffix,locality_name,state,postcode,address_count,digit_shards,num_min,num_max,flat_min,flat_max) VALUES\n${values};`
    );
  }

  // Index on street_name for efficient LIKE prefix queries (used for short single-token searches)
  sqlStatements.push(
    `CREATE INDEX idx_streets_name ON streets (street_name);`
  );

  // Create FTS5 virtual table with external content
  // Uses display_search (apostrophes stripped) so "O'DEA" → "ODEA" matches search queries
  sqlStatements.push(`CREATE VIRTUAL TABLE streets_fts USING fts5(
  display_search,
  content='streets',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);`);

  // Rebuild FTS5 index from content table
  sqlStatements.push(
    "INSERT INTO streets_fts(streets_fts) VALUES('rebuild');"
  );

  // Write single SQL file (001.sql for backwards compatibility)
  await fsp.rm(SEARCH_INDEX_DIR, { recursive: true, force: true });
  await fsp.mkdir(SEARCH_INDEX_DIR, { recursive: true });

  const content = sqlStatements.join("\n\n") + "\n";
  await fsp.writeFile(path.join(SEARCH_INDEX_DIR, "001.sql"), content);
  const totalBytes = Buffer.byteLength(content);

  const totalMb = (totalBytes / 1024 / 1024).toFixed(1);
  console.log(
    `Search index SQL written to ${SEARCH_INDEX_DIR}/001.sql (${totalMb} MB, ${streets.length} streets)`
  );
  console.log(`Search index generation complete (${elapsed(t0)})`);

  conn.disconnectSync();
  instance.closeSync();
}

// Allow running directly
if (import.meta.url === `file://${process.argv[1]}`) {
  generateSearchIndex().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
