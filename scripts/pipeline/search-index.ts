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
import { toShardRecord, readAllRows } from "./shard.js";
import { buildAddressPrefix } from "../../src/shared/address-format.js";
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

const INSERT_BATCH_SIZE = 200;

/** Target max size per SQL chunk file (~2 MB) */
const CHUNK_MAX_BYTES = 2 * 1024 * 1024;

interface StreetEntry {
  id: number;
  display: string;
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
}

export async function generateSearchIndex(): Promise<void> {
  console.log(`Opening DuckDB at ${DUCKDB_PATH}...`);
  const instance = await DuckDBInstance.create(DUCKDB_PATH);
  const conn = await instance.connect();

  await conn.run("SET memory_limit = '3GB'");
  await conn.run("SET temp_directory = '/tmp/duckdb_temp'");

  await fsp.mkdir(SHARDS_DIR, { recursive: true });
  await fsp.mkdir(STREET_SHARDS_DIR, { recursive: true });

  // --- Part 1: Build street entries and generate shards ---

  console.log("Querying unique street+locality combinations...");
  const streetResult = await conn.run(`
    SELECT
      street_name,
      COALESCE(street_type_abbrev, '') AS street_type,
      COALESCE(street_suffix_code, '') AS street_suffix,
      locality_name,
      state,
      COALESCE(postcode, '') AS postcode,
      COUNT(*) AS address_count
    FROM addresses
    WHERE alias_principal = 'P'
    GROUP BY street_name, street_type_abbrev, street_suffix_code, locality_name, state, postcode
    ORDER BY state, locality_name, street_name
  `);
  const streetRows = await readAllRows(streetResult);
  console.log(`  Found ${streetRows.length} unique street+locality combinations`);

  // Build street entries (without digit_shards yet — computed during shard generation)
  const streets: StreetEntry[] = [];
  const streetKeyToId = new Map<string, number>();

  for (let i = 0; i < streetRows.length; i++) {
    const row = streetRows[i];
    const sName = row.street_name as string;
    const sType = row.street_type as string;
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
    });

    streetKeyToId.set(streetKey, id);
  }

  // --- Part 2: Generate street S3 shards ---

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
  console.log("  Street shard prefixes computed");

  // Discover non-empty street shard prefixes
  console.log("Discovering non-empty street shard prefixes...");
  const streetShardPrefixResult = await conn.run(
    `SELECT DISTINCT _street_shard FROM addresses WHERE alias_principal = 'P' ORDER BY _street_shard`
  );
  const streetShardPrefixRows = await readAllRows(streetShardPrefixResult);
  const streetShardPrefixes = streetShardPrefixRows.map(
    (r) => r._street_shard as string
  );

  // Collect all shard data: map of shard_key → entries
  // For small streets: shard_key = street_key
  // For large streets: shard_key = street_key (un-numbered) + street_key|digit (numbered)
  const allShardData = new Map<string, StreetAddressEntry[]>();

  let totalStreetAddresses = 0;
  let subShardedStreets = 0;

  console.log(
    `Processing ${streetShardPrefixes.length} shard prefixes...`
  );

  for (const prefix of streetShardPrefixes) {
    const result = await conn.run(
      `SELECT * EXCLUDE (_addr_shard, _lotdp_shard, _street_key, _street_shard), _street_key FROM addresses WHERE _street_shard = '${prefix}' AND alias_principal = 'P'`
    );
    const rows = await readAllRows(result);
    if (rows.length === 0) continue;

    // Group by street key
    const byStreet = new Map<string, typeof rows>();
    for (const row of rows) {
      const streetKey = row._street_key as string;
      if (!byStreet.has(streetKey)) byStreet.set(streetKey, []);
      byStreet.get(streetKey)!.push(row);
    }

    for (const [streetKey, streetRows] of byStreet) {
      const needsSubSharding = streetRows.length > DIGIT_SHARD_THRESHOLD;

      if (needsSubSharding) {
        subShardedStreets++;
        const digitBuckets = new Map<string, StreetAddressEntry[]>();
        const unnumbered: StreetAddressEntry[] = [];

        for (const row of streetRows) {
          const pid = row.gnaf_pid as string;
          const record = toShardRecord(row);
          const d = buildAddressPrefix(record);
          const entry: StreetAddressEntry = { p: pid, d };
          if (record.nf != null) entry.n = record.nf;
          if (record.fn != null) entry.f = record.fn;

          if (record.nf != null) {
            const digit = String(record.nf).charAt(0);
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
        for (const [digit, entries] of digitBuckets) {
          const subKey = `${streetKey}|${digit}`;
          allShardData.set(subKey, entries);
          digitMap[digit] = md5hex(subKey).substring(0, SHARD_PREFIX_LENGTH);
        }

        // Update the street entry with digit_shards info
        const streetId = streetKeyToId.get(streetKey);
        if (streetId != null) {
          const streetEntry = streets[streetId - 1];
          streetEntry.digit_shards = JSON.stringify(digitMap);
        }
      } else {
        // Small street: all addresses under base key
        const entries: StreetAddressEntry[] = [];
        for (const row of streetRows) {
          const pid = row.gnaf_pid as string;
          const record = toShardRecord(row);
          const d = buildAddressPrefix(record);
          const entry: StreetAddressEntry = { p: pid, d };
          if (record.nf != null) entry.n = record.nf;
          if (record.fn != null) entry.f = record.fn;
          entries.push(entry);
        }
        allShardData.set(streetKey, entries);
      }

      totalStreetAddresses += streetRows.length;
    }
  }

  console.log(
    `  ${allShardData.size} shard keys (${subShardedStreets} streets sub-sharded, ${totalStreetAddresses} addresses total)`
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
    if (shardFilesWritten % 500 === 0) {
      console.log(
        `  ${shardFilesWritten}/${byShardFile.size} shard files...`
      );
    }
  }
  console.log(`  ${shardFilesWritten} street shard files written`);

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
  street_key TEXT NOT NULL,
  shard_prefix TEXT NOT NULL,
  street_name TEXT NOT NULL,
  street_type TEXT,
  street_suffix TEXT,
  locality_name TEXT NOT NULL,
  state TEXT NOT NULL,
  postcode TEXT,
  address_count INTEGER NOT NULL,
  digit_shards TEXT
);`);

  // Batch INSERT for streets
  for (let i = 0; i < streets.length; i += INSERT_BATCH_SIZE) {
    const batch = streets.slice(i, i + INSERT_BATCH_SIZE);
    const values = batch
      .map(
        (s) =>
          `(${s.id},'${sqlEscape(s.display)}','${sqlEscape(s.street_key)}','${sqlEscape(s.shard_prefix)}','${sqlEscape(s.street_name)}',${s.street_type ? `'${sqlEscape(s.street_type)}'` : "NULL"},${s.street_suffix ? `'${sqlEscape(s.street_suffix)}'` : "NULL"},'${sqlEscape(s.locality_name)}','${sqlEscape(s.state)}',${s.postcode ? `'${sqlEscape(s.postcode)}'` : "NULL"},${s.address_count},${s.digit_shards ? `'${sqlEscape(s.digit_shards)}'` : "NULL"})`
      )
      .join(",\n");
    sqlStatements.push(
      `INSERT INTO streets (id,display,street_key,shard_prefix,street_name,street_type,street_suffix,locality_name,state,postcode,address_count,digit_shards) VALUES\n${values};`
    );
  }

  // Create FTS5 virtual table with external content
  sqlStatements.push(`CREATE VIRTUAL TABLE streets_fts USING fts5(
  display,
  content='streets',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);`);

  // Rebuild FTS5 index from content table
  sqlStatements.push(
    "INSERT INTO streets_fts(streets_fts) VALUES('rebuild');"
  );

  // Write chunked SQL files
  await fsp.rm(SEARCH_INDEX_DIR, { recursive: true, force: true });
  await fsp.mkdir(SEARCH_INDEX_DIR, { recursive: true });

  let chunkIndex = 1;
  let chunkStatements: string[] = [];
  let chunkBytes = 0;
  let totalBytes = 0;

  async function flushChunk() {
    if (chunkStatements.length === 0) return;
    const content = chunkStatements.join("\n\n") + "\n";
    const fileName = String(chunkIndex).padStart(3, "0") + ".sql";
    await fsp.writeFile(path.join(SEARCH_INDEX_DIR, fileName), content);
    totalBytes += Buffer.byteLength(content);
    chunkIndex++;
    chunkStatements = [];
    chunkBytes = 0;
  }

  for (const stmt of sqlStatements) {
    const stmtBytes = Buffer.byteLength(stmt);
    // Start a new chunk if adding this statement would exceed the limit
    // (but always allow at least one statement per chunk)
    if (chunkBytes > 0 && chunkBytes + stmtBytes > CHUNK_MAX_BYTES) {
      await flushChunk();
    }
    chunkStatements.push(stmt);
    chunkBytes += stmtBytes;
  }
  await flushChunk();

  const totalMb = (totalBytes / 1024 / 1024).toFixed(1);
  console.log(
    `Search index SQL written to ${SEARCH_INDEX_DIR}/ (${chunkIndex - 1} files, ${totalMb} MB total, ${streets.length} streets)`
  );

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
